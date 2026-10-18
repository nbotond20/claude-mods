#!/usr/bin/env python3
"""Replay Claude Code transcripts into the local observability stack.

Sessions from before telemetry was on only live in the transcripts (~/.claude*/projects/*/*.jsonl).
This rebuilds them as the same events and spans Claude Code's own OpenTelemetry sends, with their
real timestamps: user_prompt, api_request, tool_result and api_error logs, and an interaction ->
llm_request / tool waterfall per prompt (subagents nested under the Agent call that ran them).

Costs: Claude Code writes the exact per-model cost of a session into its transcript (cost-state);
per-request costs are list-price estimates scaled so each session's total matches it exactly.

Never doubles anything: a session already in Loki (reported live, or backfilled before) is skipped.
Python 3 standard library only; it only talks to the stack on 127.0.0.1.
"""
import argparse
import glob
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# $ per million tokens: (input, output). Cache reads 0.1x input, cache writes 1.25x (5m) / 2x (1h).
PRICES = (('opus', 5.0, 25.0), ('sonnet', 3.0, 15.0), ('haiku', 1.0, 5.0))
MAX_TEXT = 4096
BATCH = 2000


def ns(stamp):
    return int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1e9)


def hid(*parts, n=32):
    return hashlib.sha256('|'.join(str(p) for p in parts).encode()).hexdigest()[:n]


def attrs(d):
    out = []
    for k, v in d.items():
        if v is None or v == '':
            continue
        if isinstance(v, bool):
            val = {'boolValue': v}
        elif isinstance(v, int):
            val = {'intValue': str(v)}
        elif isinstance(v, float):
            val = {'doubleValue': v}
        else:
            val = {'stringValue': str(v)}
        out.append({'key': k, 'value': val})
    return out


def clip(s, n=MAX_TEXT):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + '…'


def estimate(model, u):
    i, o = next(((pi, po) for name, pi, po in PRICES if name in (model or '')), (3.0, 15.0))
    write = u.get('cache_creation_input_tokens') or 0
    w1h = ((u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0)
    w1h = min(w1h, write)
    return ((u.get('input_tokens') or 0) * i + (u.get('output_tokens') or 0) * o
            + (u.get('cache_read_input_tokens') or 0) * i * 0.1
            + (write - w1h) * i * 1.25 + w1h * i * 2) / 1e6


def argv0(cmd):
    """The program a command line runs, past any VAR=value prefixes."""
    words = cmd.split()
    while words and '=' in words[0] and not words[0].startswith(('=', '-')):
        words.pop(0)
    return words[0] if words else ''


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
            return None
        parts = [b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text']
        return '\n'.join(parts) if parts else None
    return None


def read_rows(path):
    rows = []
    with open(path, errors='replace') as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def parse(rows, agent=False):
    """One transcript -> ordered items: prompt, llm, tool, error. Plus the session's facts."""
    items, pending, groups = [], {}, {}
    facts = {'sid': None, 'version': None, 'cwd': None, 'branch': None, 'cost': None}
    last_ts = None
    for d in rows:
        t = d.get('type')
        if t == 'cost-state':
            facts['cost'] = d
            continue
        facts['sid'] = facts['sid'] or d.get('sessionId')
        facts['version'] = d.get('version') or facts['version']
        facts['cwd'] = facts['cwd'] or d.get('cwd')
        facts['branch'] = facts['branch'] or d.get('gitBranch')
        ts = d.get('timestamp')
        if not ts or t not in ('user', 'assistant', 'attachment', 'system'):
            continue
        if d.get('isSidechain') and not agent:
            last_ts = ts
            continue
        m = d.get('message') or {}
        if t == 'user':
            content = m.get('content')
            prompt = None if (d.get('isMeta') or d.get('isCompactSummary')) else text_of(content)
            if prompt is not None and not d.get('toolUseResult'):
                items.append({'kind': 'prompt', 'id': d.get('uuid') or hid(ts), 'ts': ts, 'text': prompt})
            elif isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict) or b.get('type') != 'tool_result':
                        continue
                    use = pending.pop(b.get('tool_use_id'), None)
                    if not use:
                        continue
                    out = b.get('content')
                    out = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False) if out else ''
                    use.update(end=ts, ok=not b.get('is_error'), size=len(out.encode()),
                               error=clip(out, 500) if b.get('is_error') else None)
        elif t == 'assistant':
            model = m.get('model') or ''
            if d.get('isApiErrorMessage'):
                items.append({'kind': 'error', 'ts': ts, 'model': model,
                              'text': clip(text_of(m.get('content')) or d.get('error') or 'API error', 500)})
            elif model and not model.startswith('<'):
                key = d.get('requestId') or m.get('id') or d.get('uuid')
                g = groups.get(key)
                if not g:
                    g = groups[key] = {'kind': 'llm', 'id': key, 'start': last_ts or ts, 'end': ts,
                                       'ts': last_ts or ts, 'model': model, 'usage': {}, 'tools': 0}
                    items.append(g)
                g['end'] = ts
                g['usage'] = m.get('usage') or g['usage']
                g['stop'] = m.get('stop_reason') or g.get('stop')
                for b in m.get('content') or []:
                    if isinstance(b, dict) and b.get('type') == 'tool_use':
                        g['tools'] += 1
                        use = {'kind': 'tool', 'id': b.get('id'), 'name': b.get('name') or '?',
                               'input': b.get('input'), 'start': ts, 'ts': ts, 'end': None, 'ok': True}
                        pending[b.get('id')] = use
                        items.append(use)
        last_ts = ts
    items = [x for x in items if x['kind'] != 'tool' or x.get('end')]
    items.sort(key=lambda x: x['ts'])
    return items, facts


def session_spans(sid, profile, items, subs, cost_of, content, tool_content):
    """Items -> (spans, logs) in OTLP JSON shape."""
    spans, logs, emitted = [], [], {(x['kind'], x.get('id')) for x in items}
    base = {'session.id': sid, 'claude.source': 'transcript'}

    def log(name, ts, trace, span, extra):
        logs.append({'timeUnixNano': str(ns(ts)), 'observedTimeUnixNano': str(ns(ts)),
                     'severityNumber': 9, 'severityText': 'INFO',
                     'body': {'stringValue': f'claude_code.{name}'},
                     'traceId': trace, 'spanId': span,
                     'attributes': attrs({'event.name': name, 'event.timestamp': ts, **base, **extra})})

    def span(trace, sid_, parent, name, start, end, a, error=None):
        s0, s1 = ns(start), max(ns(end), ns(start) + 1_000_000)
        spans.append({'traceId': trace, 'spanId': sid_, 'parentSpanId': parent or '', 'name': name,
                      'kind': 1, 'startTimeUnixNano': str(s0), 'endTimeUnixNano': str(s1),
                      'attributes': attrs({**base, **a, 'duration_ms': (s1 - s0) // 1_000_000}),
                      'status': {'code': 2, 'message': error or 'error'} if error else {}})

    def emit(x, trace, parent, prompt_id, context):
        if x['kind'] == 'llm':
            u, ms = x['usage'], max(1, (ns(x['end']) - ns(x['start'])) // 1_000_000)
            sp = hid(sid, 'llm', x['id'], n=16)
            tok = {'input_tokens': u.get('input_tokens') or 0, 'output_tokens': u.get('output_tokens') or 0,
                   'cache_read_tokens': u.get('cache_read_input_tokens') or 0,
                   'cache_creation_tokens': u.get('cache_creation_input_tokens') or 0}
            cost = round(cost_of(x), 8)
            span(trace, sp, parent, 'claude_code.llm_request', x['start'], x['end'],
                 {'span.type': 'llm_request', 'model': x['model'], 'gen_ai.request.model': x['model'],
                  'gen_ai.system': 'anthropic', 'llm_request.context': context, 'request_id': x['id'],
                  'success': True, 'stop_reason': x.get('stop'), 'response.has_tool_call': x['tools'] > 0,
                  'cost_usd': cost, **tok})
            log('api_request', x['end'], trace, sp,
                {'prompt.id': prompt_id, 'model': x['model'], 'request_id': x['id'], 'duration_ms': ms,
                 'cost_usd': cost, 'query_source': 'agent' if context == 'agent' else 'repl_main_thread',
                 'speed': u.get('speed'), 'stop_reason': x.get('stop'), **tok})
        elif x['kind'] == 'tool':
            sp = hid(sid, 'tool', x['id'], n=16)
            inp = clip(x['input']) if x['input'] is not None else None
            a = {'span.type': 'tool', 'tool_name': x['name'], 'gen_ai.tool.name': x['name'],
                 'tool_use_id': x['id'], 'success': x['ok']}
            if tool_content and inp:
                a['tool_input'] = inp
            span(trace, sp, parent, 'claude_code.tool', x['start'], x['end'], a, x.get('error'))
            span(trace, hid(sid, 'exec', x['id'], n=16), sp, 'claude_code.tool.execution', x['start'], x['end'],
                 {'span.type': 'tool.execution', 'tool_use_id': x['id'], 'success': x['ok']}, x.get('error'))
            extra = {'prompt.id': prompt_id, 'tool_name': x['name'], 'tool_use_id': x['id'], 'success': x['ok'],
                     'duration_ms': max(0, (ns(x['end']) - ns(x['start'])) // 1_000_000),
                     'tool_result_size_bytes': x.get('size'), 'error': x.get('error')}
            if content and inp:
                extra['tool_input'] = inp
                if x['name'] == 'Bash' and isinstance(x['input'], dict):
                    cmd = x['input'].get('command') or ''
                    extra['tool_parameters'] = json.dumps({'bash_command': argv0(cmd),
                                                           'full_command': clip(cmd),
                                                           'description': x['input'].get('description')})
            log('tool_result', x['end'], trace, sp, extra)
            # a forked subagent's transcript repeats the parent's turns: nest each call once
            for sub in subs.pop(x['id'], []):
                for y in sub:
                    key = (y['kind'], y.get('id'))
                    if key not in emitted:
                        emitted.add(key)
                        emit(y, trace, sp, prompt_id, 'agent')
        elif x['kind'] == 'error':
            log('api_error', x['ts'], trace, parent, {'prompt.id': prompt_id, 'model': x['model'],
                                                       'error': x['text']})

    # split at prompts: each prompt is one interaction trace; work before the first prompt gets its own
    turns, cur = [], None
    for x in items:
        if x['kind'] == 'prompt' or cur is None:
            cur = {'prompt': x if x['kind'] == 'prompt' else None, 'items': []}
            turns.append(cur)
            if x['kind'] == 'prompt':
                continue
        cur['items'].append(x)
    for seq, turn in enumerate(turns, 1):
        p = turn['prompt']
        pid = p['id'] if p else hid(sid, 'turn', seq)
        trace, root = hid(sid, pid), hid(sid, pid, 'root', n=16)
        start = p['ts'] if p else turn['items'][0]['ts']
        end = max([x.get('end') or x['ts'] for x in turn['items']] + [start])
        for x in turn['items']:
            if x['kind'] == 'tool':
                for sub in subs.get(x['id'], []):
                    end = max([end] + [y.get('end') or y['ts'] for y in sub])
        a = {'span.type': 'interaction', 'interaction.sequence': seq, 'gen_ai.operation.name': 'invoke_agent',
             'interaction.duration_ms': (ns(end) - ns(start)) // 1_000_000}
        if p:
            a['user_prompt_length'] = len(p['text'])
            if content:
                a['user_prompt'] = clip(p['text'])
            extra = {'prompt.id': pid, 'prompt_length': len(p['text'])}
            if content:
                extra['prompt'] = clip(p['text'])
            log('user_prompt', p['ts'], trace, root, extra)
        span(trace, root, None, 'claude_code.interaction', start, end, a)
        for x in turn['items']:
            emit(x, trace, root, pid, 'interaction')
    return spans, logs


def profiles(home, only):
    out = []
    for d in sorted(glob.glob(os.path.join(home, '.claude')) + glob.glob(os.path.join(home, '.claude-*'))):
        name = os.path.basename(d)[1:]
        if name in ('claude-shared', 'claude-mods') or not os.path.isdir(os.path.join(d, 'projects')):
            continue
        if only and name not in only and name.removeprefix('claude-') not in only:
            continue
        out.append((name, d))
    return out


def known_sessions(grafana, days):
    """(live, backfilled): session ids Loki already holds, queried in 30-day windows."""
    live, back, end, step = set(), set(), time.time(), 30 * 86400
    stop = end - days * 86400
    queries = ((live, 'session_id', '{service_name=~"claude-code.*", claude_backfill=""} | claude_source!="transcript"'),
               (back, 'claude_backfill', '{service_name=~"claude-code.*", claude_backfill=~".+"}'))
    while end > stop:
        hours = int(min(step, end - stop) // 3600 + 1)
        for into, label, sel in queries:
            q = 'sum by (%s) (count_over_time(%s [%dh]))' % (label, sel, hours)
            url = grafana + '/api/datasources/proxy/uid/loki/loki/api/v1/query?' + urllib.parse.urlencode({'query': q, 'time': int(end)})
            with urllib.request.urlopen(url, timeout=120) as r:
                into.update(row['metric'][label] for row in json.load(r)['data']['result'] if row['metric'].get(label))
        end -= step
    return live, back


def post(endpoint, path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(endpoint + path, data, {'Content-Type': 'application/json'})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
            return
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or attempt == 4:
                raise SystemExit(f'backfill: {path} refused ({e.code}): {e.read()[:300].decode(errors="replace")}')
        except urllib.error.URLError as e:
            if attempt == 4:
                raise SystemExit(f'backfill: cannot reach {endpoint} ({e.reason}); is the stack up? (claude-obs up)')
        time.sleep(2 ** attempt)


def send(endpoint, resource, spans, logs):
    res = {'attributes': attrs(resource)}
    scope = {'name': 'claude-obs.backfill', 'version': '1'}
    for i in range(0, len(spans), BATCH):
        post(endpoint, '/v1/traces', {'resourceSpans': [{'resource': res, 'scopeSpans': [{'scope': scope, 'spans': spans[i:i + BATCH]}]}]})
    # one request per session, in time order: Loki refuses entries older than what a stream already has
    post(endpoint, '/v1/logs', {'resourceLogs': [{'resource': res, 'scopeLogs': [{'scope': scope, 'logRecords': logs}]}]})


def main():
    ap = argparse.ArgumentParser(description='Replay Claude Code transcripts as traces and events.')
    ap.add_argument('--endpoint', default='http://127.0.0.1:4318')
    ap.add_argument('--grafana', default='http://127.0.0.1:3301')
    ap.add_argument('--dir', default=os.path.expanduser('~/.claude-shared/observability'))
    ap.add_argument('--days', type=float, default=90, help='only sessions active in the last N days')
    ap.add_argument('--profile', action='append', default=[], help='only this profile (repeatable): claude, work, claude-work')
    ap.add_argument('--home', default=os.path.expanduser('~'))
    ap.add_argument('--dry-run', action='store_true', help='count what would be sent, send nothing')
    ap.add_argument('--force', action='store_true', help='resend sessions backfilled before (identical events are deduplicated); live ones are never resent')
    ap.add_argument('--include-active', action='store_true', help='also sessions written to in the last 10 minutes')
    a = ap.parse_args()

    cfg = {}
    try:
        with open(os.path.join(a.dir, 'config.json')) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        pass
    content, tool_content = cfg.get('content', True), cfg.get('toolContent', False)
    state_path = os.path.join(a.dir, 'backfill.json')
    try:
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    done = state.setdefault('sessions', {})

    try:
        live, back = known_sessions(a.grafana, a.days)
    except Exception as e:  # noqa: BLE001
        if not a.dry_run:
            raise SystemExit(f'backfill: cannot ask Loki which sessions it already has ({e}); is the stack up? (claude-obs up)')
        live, back = set(), set()
    now = time.time()
    cutoff = now - a.days * 86400
    total = {'sessions': 0, 'prompts': 0, 'requests': 0, 'tools': 0, 'cost': 0.0, 'skipped': 0}

    for name, pdir in profiles(a.home, a.profile):
        stats = {'sessions': 0, 'prompts': 0, 'requests': 0, 'tools': 0, 'cost': 0.0, 'skipped': 0}
        for path in sorted(glob.glob(os.path.join(pdir, 'projects', '*', '*.jsonl'))):
            mtime = os.path.getmtime(path)
            if mtime < cutoff or (now - mtime < 600 and not a.include_active):
                continue
            items, facts = parse(read_rows(path))
            sid = facts['sid'] or os.path.basename(path)[:-6]
            if not items:
                continue
            # a session reported live is never replayed; --force only resends backfilled ones
            if sid in live or ((sid in back or sid in done) and not a.force):
                stats['skipped'] += 1
                continue
            subs = {}
            for sp in glob.glob(os.path.join(os.path.dirname(path), sid, 'subagents', '*.jsonl')):
                try:
                    with open(sp[:-6] + '.meta.json') as f:
                        tool = json.load(f).get('toolUseId')
                except (OSError, ValueError):
                    tool = None
                sub_items = [x for x in parse(read_rows(sp), agent=True)[0] if x['kind'] != 'prompt']
                if tool and sub_items:
                    subs.setdefault(tool, []).append(sub_items)
            llms = [x for x in items if x['kind'] == 'llm'] + [y for g in subs.values() for s in g for y in s if y['kind'] == 'llm']
            est = {id(x): estimate(x['model'], x['usage']) for x in llms}
            scale = {}
            usage = ((facts['cost'] or {}).get('modelUsage') or {})
            for model, mu in usage.items():
                guess = sum(est[id(x)] for x in llms if x['model'] == model)
                if guess > 0 and mu.get('costUSD') is not None:
                    scale[model] = mu['costUSD'] / guess

            def cost_of(x):
                return est[id(x)] * scale.get(x['model'], 1.0)

            spans, logs = session_spans(sid, name, items, subs, cost_of, content, tool_content)
            # Loki keeps one of several entries with the same timestamp and line (parallel tool results
            # share a millisecond): nudge each to a strictly later nanosecond
            logs.sort(key=lambda r: int(r['timeUnixNano']))
            prev = 0
            for r in logs:
                t = max(int(r['timeUnixNano']), prev + 1)
                r['timeUnixNano'] = r['observedTimeUnixNano'] = str(t)
                prev = t
            stats['sessions'] += 1
            stats['prompts'] += sum(1 for x in items if x['kind'] == 'prompt')
            stats['requests'] += len(llms)
            stats['tools'] += sum(1 for x in items if x['kind'] == 'tool') + sum(1 for g in subs.values() for s in g for y in s if y['kind'] == 'tool')
            stats['cost'] += sum(cost_of(x) for x in llms)
            if a.dry_run:
                continue
            send(a.endpoint, {'service.name': 'claude-code', 'service.version': facts['version'],
                              'claude.profile': name, 'claude.source': 'transcript',
                              # its own Loki stream: Loki only takes old entries into a stream that has nothing newer
                              'claude.backfill': sid}, spans, logs)
            done[sid] = datetime.now(timezone.utc).isoformat(timespec='seconds')
            os.makedirs(a.dir, exist_ok=True)
            with open(state_path + '.tmp', 'w') as f:
                json.dump(state, f)
            os.replace(state_path + '.tmp', state_path)
        if stats['sessions'] or stats['skipped']:
            print(f"{name}: {stats['sessions']} sessions, {stats['prompts']} prompts, {stats['requests']} requests, "
                  f"{stats['tools']} tool calls, ${stats['cost']:.2f}"
                  + (f" ({stats['skipped']} already in the stack)" if stats['skipped'] else ''))
        for k in total:
            total[k] += stats[k]
    verb = 'would send' if a.dry_run else 'sent'
    print(f"{verb} {total['sessions']} sessions (${total['cost']:.2f}), skipped {total['skipped']} already in the stack"
          + ('' if a.dry_run or not total['sessions'] else '; new traces are searchable in Grafana within a minute'))


if __name__ == '__main__':
    main()
