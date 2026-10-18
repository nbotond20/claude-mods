#!/usr/bin/env python3
"""Demo transcripts for the observability screenshots (see README.md).

Writes three fictional profiles under <dir>/home: claude-work and claude-personal (direct
subscription) and claude-gateway (through a LiteLLM gateway: slower, a few more errors). 21 days of
sessions in the fictional projects, with tool calls, failures, API errors and subagents, in the same
JSONL shape Claude Code writes.

`send` replays them into a demo stack as if they had reported live: observability's own backfill
turns each into events and spans, and this adds what only live telemetry carries (time to first
token, hooks, permission decisions, MCP connections, skills, plugins).

  python3 scripts/demo/observability-demo.py /tmp/obs-demo
  python3 scripts/demo/observability-demo.py /tmp/obs-demo send http://127.0.0.1:4328
"""
import glob
import importlib.util
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

DAYS = 21
VERSION = '2.1.301'
PROJECTS = {'acme-web': 'main', 'billing-api': 'feat/invoices', 'mobile-app': 'main', 'infra': 'tf-upgrade',
            'design-system': 'tokens-v2'}
# profile: (share of sessions, main models with weights, latency factor, latency spread, API error rate)
PROFILES = {
    'claude-work': (0.55, (('claude-opus-5-5', 6), ('claude-sonnet-5-5', 4)), 1.0, 0.45, 0.012),
    'claude-gateway': (0.30, (('claude-opus-5-5', 5), ('claude-sonnet-5-5', 5)), 1.65, 0.65, 0.022),
    'claude-personal': (0.15, (('claude-sonnet-5-5', 7), ('claude-opus-5-5', 3)), 1.0, 0.45, 0.01),
}
MEDIAN_S = {'opus': 9.0, 'sonnet': 6.0, 'haiku': 2.4}
PROMPTS = [
    'Add pagination to the invoices endpoint and cover it with tests',
    'Why does the checkout page re-render twice on load?',
    'Refactor the auth middleware to use the new session store',
    'Fix the flaky date picker test',
    'Upgrade the Terraform AWS provider and fix the plan diff',
    'Write a migration that backfills customer.region',
    'The Android build fails after the Gradle bump, can you look?',
    'Add dark mode tokens for the button component',
    'Review this PR and list anything risky',
    'Explain how retries work in the payment client',
    'Make the CSV export stream instead of loading everything',
    'Add an index for the slow orders query',
    'Port the Card component to the new token names',
    'Rename the feature flag and clean up the dead branch',
    'Set up a GitHub Action that runs the e2e suite nightly',
]
FILES = ['src/routes/invoices.ts', 'src/components/Checkout.tsx', 'src/middleware/auth.ts', 'tests/date-picker.test.ts',
         'modules/vpc/main.tf', 'migrations/0042_region.sql', 'android/app/build.gradle', 'tokens/button.json',
         'src/payments/client.ts', 'src/export/csv.ts', 'src/components/Card.tsx', 'README.md']
BASH = [('git status', 0.2, 0.0), ('git diff --stat', 0.3, 0.0), ('npm test', 24, 0.18), ('npm run lint', 7, 0.1),
        ('pytest -q', 15, 0.15), ('terraform plan', 35, 0.12), ('./gradlew assembleDebug', 55, 0.2),
        ('rg -n TODO src', 0.4, 0.0), ('npx tsc --noEmit', 9, 0.14), ('gh pr view 412', 1.4, 0.03)]
# tool: (weight, median seconds, failure rate)
TOOLS = {'Read': (30, 0.12, 0.01), 'Bash': (22, 0, 0), 'Edit': (16, 0.4, 0.05), 'Grep': (12, 0.35, 0.0),
         'Glob': (6, 0.2, 0.0), 'Write': (4, 0.3, 0.02), 'TodoWrite': (4, 0.03, 0.0), 'WebFetch': (2, 3.2, 0.12),
         'mcp__github__get_pull_request': (2, 1.3, 0.04), 'Agent': (2, 0, 0)}
API_ERRORS = ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
              'API Error: Request timed out.', 'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
              'API Error: Connection error.']


def lognorm(rng, median, spread):
    return median * rng.lognormvariate(0, spread)


def stamp(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Session:
    def __init__(self, rng, profile, project, start):
        self.rng, self.profile, self.project, self.t = rng, profile, project, start
        self.sid = str(uuid.UUID(int=rng.getrandbits(128)))
        self.cwd = f'/Users/dev/code/{project}'
        self.rows, self.subs, self.context = [], [], rng.randint(12000, 30000)
        _, self.models, self.factor, self.spread, self.err = PROFILES[profile]

    def row(self, rows, kind, **kw):
        rows.append({'type': kind, 'sessionId': self.sid, 'version': VERSION, 'cwd': self.cwd,
                     'gitBranch': PROJECTS[self.project], 'timestamp': stamp(self.t),
                     'uuid': str(uuid.UUID(int=self.rng.getrandbits(128))), **kw})

    def model_call(self, rows, model, tools, last):
        rng = self.rng
        if rng.random() < self.err:
            self.t += lognorm(rng, 20, 0.6)
            self.row(rows, 'assistant', isApiErrorMessage=True,
                     message={'model': '<synthetic>', 'role': 'assistant',
                              'content': [{'type': 'text', 'text': rng.choice(API_ERRORS)}]})
        kind = next(k for k in MEDIAN_S if k in model)
        out = int(lognorm(rng, 320 if tools else 650, 0.7)) + 20
        self.t += lognorm(rng, MEDIAN_S[kind] * self.factor, self.spread) * (0.6 + out / 900)
        self.context += rng.randint(800, 6000)
        usage = {'input_tokens': rng.randint(3, 60), 'output_tokens': out,
                 'cache_read_input_tokens': self.context, 'cache_creation_input_tokens': rng.randint(600, 5000)}
        content = [{'type': 'text', 'text': 'Working on it.'}]
        uses = []
        for _ in range(tools):
            name = rng.choices(list(TOOLS), [w for w, _, _ in TOOLS.values()])[0]
            if name == 'Agent' and rows is not self.rows:
                name = 'Grep'
            use = {'type': 'tool_use', 'id': 'toolu_' + uuid.UUID(int=rng.getrandbits(128)).hex[:24], 'name': name,
                   'input': self.tool_input(name)}
            content.append(use)
            uses.append(use)
        self.row(rows, 'assistant', requestId='req_' + uuid.UUID(int=rng.getrandbits(128)).hex[:24],
                 message={'model': model, 'id': 'msg_' + uuid.UUID(int=rng.getrandbits(128)).hex[:24], 'role': 'assistant',
                          'usage': usage, 'stop_reason': 'tool_use' if uses else 'end_turn', 'content': content})
        begin, ends = self.t, []
        for use in uses:
            self.t = begin
            ok, out = self.run_tool(use)
            ends.append(self.t)
            self.row(rows, 'user', toolUseResult={'ok': ok},
                     message={'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': use['id'],
                                                           'content': out, 'is_error': not ok}]})
        self.t = max(ends, default=self.t)

    def tool_input(self, name):
        rng = self.rng
        if name == 'Bash':
            return {'command': rng.choice(BASH)[0]}
        if name in ('Read', 'Edit', 'Write'):
            return {'file_path': f'{self.cwd}/{rng.choice(FILES)}'}
        if name in ('Grep', 'Glob'):
            return {'pattern': rng.choice(['useSession', 'TODO', '*.test.ts', 'retry', 'region'])}
        if name == 'Agent':
            return {'description': 'Find every caller', 'subagent_type': 'Explore', 'prompt': 'List the callers'}
        if name == 'WebFetch':
            return {'url': 'https://docs.example.com/api'}
        return {}

    def run_tool(self, use):
        rng, name = self.rng, use['name']
        if name == 'Bash':
            cmd, med, fail = next(b for b in BASH if b[0] == use['input']['command'])
            self.t += lognorm(rng, med, 0.5) + 0.05
            ok = rng.random() >= fail
            return ok, 'ok' if ok else 'Exit code 1\n2 failing'
        if name == 'Agent':
            sub = []
            for i in range(rng.randint(2, 6)):
                self.model_call(sub, 'claude-haiku-5-5', rng.choice((1, 1, 2, 3)) if i < 4 else 0, False)
            self.model_call(sub, 'claude-haiku-5-5', 0, True)
            self.subs.append((use['id'], sub))
            return True, 'Found 7 callers'
        _, med, fail = TOOLS[name]
        self.t += lognorm(rng, med, 0.6)
        if name in ('Edit', 'Write', 'WebFetch') and rng.random() < 0.15:
            self.t += lognorm(rng, 4, 0.8)  # a permission prompt answered by hand
        ok = rng.random() >= fail
        return ok, 'ok' if ok else ('String to replace not found in file.' if name == 'Edit' else 'Request failed')

    def build(self):
        rng = self.rng
        model = rng.choices([m for m, _ in self.models], [w for _, w in self.models])[0]
        for _ in range(rng.randint(2, 8)):
            self.row(self.rows, 'user', message={'role': 'user', 'content': rng.choice(PROMPTS)})
            turns = rng.randint(1, 7)
            for i in range(turns):
                self.model_call(self.rows, model, 0 if i == turns - 1 else rng.choice((1, 1, 1, 2, 2, 3)), i == turns - 1)
            self.t += lognorm(rng, 70, 0.9)  # reading the answer, typing the next prompt
        return self


def send(home, endpoint):
    spec = importlib.util.spec_from_file_location('backfill', os.path.join(os.path.dirname(__file__), '..', '..',
                                                                           'observability', 'bin', 'backfill.py'))
    bf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bf)
    rng = random.Random(7)
    hooks = {'SessionStart': (180, 0.02), 'UserPromptSubmit': (90, 0.01), 'PreToolUse': (35, 0.004),
             'PostToolUse': (60, 0.006), 'Stop': (240, 0.03)}
    n = 0
    for name, pdir in bf.profiles(home, []):
        slow = PROFILES[name][2]
        for path in sorted(glob.glob(os.path.join(pdir, 'projects', '*', '*.jsonl'))):
            items, facts = bf.parse(bf.read_rows(path))
            sid = facts['sid']
            subs = {}
            for sp in glob.glob(os.path.join(os.path.dirname(path), sid, 'subagents', '*.jsonl')):
                with open(sp[:-6] + '.meta.json') as f:
                    subs.setdefault(json.load(f)['toolUseId'], []).append(
                        [x for x in bf.parse(bf.read_rows(sp), agent=True)[0] if x['kind'] != 'prompt'])
            spans, logs = bf.session_spans(sid, name, items, subs, lambda x: bf.estimate(x['model'], x['usage']), True, False)
            extra = []

            def event(ev, at_ns, **a):
                extra.append({'timeUnixNano': str(at_ns), 'observedTimeUnixNano': str(at_ns), 'severityNumber': 9,
                              'severityText': 'INFO', 'body': {'stringValue': f'claude_code.{ev}'},
                              'attributes': bf.attrs({'event.name': ev, 'session.id': sid, **a})})

            def hook(ev, at_ns):
                med, err = hooks[ev]
                event('hook_execution_complete', at_ns, hook_event=ev, total_duration_ms=int(lognorm(rng, med, 0.6)),
                      num_hooks=rng.randint(1, 3), num_non_blocking_error=int(rng.random() < err),
                      num_blocking=int(ev == 'PreToolUse' and rng.random() < 0.01), num_cancelled=0)

            for r in logs:
                a = {x['key']: x['value'] for x in r['attributes']}
                at = int(r['timeUnixNano'])
                kind = a['event.name']['stringValue']
                if kind == 'api_request':
                    dur = int(a['duration_ms']['intValue'])
                    ttft = int(min(dur * 0.9, lognorm(rng, 1400 * slow ** 1.3, 0.45)))
                    r['attributes'].append({'key': 'ttft_ms', 'value': {'intValue': str(ttft)}})
                elif kind == 'user_prompt':
                    hook('UserPromptSubmit', at + 1000)
                elif kind == 'tool_result':
                    tool = a['tool_name']['stringValue']
                    hook('PreToolUse', at - 2_000_000)
                    hook('PostToolUse', at + 1000)
                    if tool in ('Edit', 'Write', 'Bash', 'WebFetch'):
                        src = rng.choices(('config', 'user_temporary', 'user_permanent', 'user_reject'), (70, 18, 8, 4))[0]
                        event('tool_decision', at - 3_000_000, tool_name=tool, decision='reject' if src == 'user_reject' else 'accept',
                              source='user_temporary' if src == 'user_reject' else src)
            t0 = min(int(r['timeUnixNano']) for r in logs) - 5_000_000_000
            hook('SessionStart', t0)
            for server, med in (('github', 900), ('linear', 1300)):
                event('mcp_server_connection', t0 + 1000, server_name=server, transport_type='http',
                      duration_ms=int(lognorm(rng, med, 0.5)), status='failed' if rng.random() < 0.04 else 'connected')
            for plugin in ('budget-guard', 'lean-tools', 'observability'):
                event('plugin_loaded', t0 + 2000, plugin_name=plugin, marketplace_name='my-mods', plugin_version='0.1.3',
                      has_hooks=True, has_mcp=False)
            if rng.random() < 0.3:
                event('skill_activated', t0 + 60_000_000_000, skill_name=rng.choice(('dataviz', 'pdf', 'xlsx')),
                      invocation_trigger=rng.choice(('model', 'user')))
            for x in spans + logs:  # reported live: no transcript marker
                x['attributes'] = [y for y in x['attributes'] if y['key'] != 'claude.source']
            logs = sorted(logs + extra, key=lambda r: int(r['timeUnixNano']))
            prev = 0
            for r in logs:  # Loki keeps one of several entries with the same timestamp
                prev = max(int(r['timeUnixNano']), prev + 1)
                r['timeUnixNano'] = r['observedTimeUnixNano'] = str(prev)
            bf.send(endpoint, {'service.name': 'claude-code', 'service.version': VERSION, 'claude.profile': name,
                               'claude.backfill': sid}, spans, logs)
            n += 1
    print(f'sent {n} sessions to {endpoint}')


def main():
    if len(sys.argv) == 4 and sys.argv[2] == 'send':
        return send(os.path.join(os.path.abspath(sys.argv[1]), 'home'), sys.argv[3])
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = os.path.abspath(sys.argv[1])
    if os.path.exists(out) and os.listdir(out) and not os.path.exists(os.path.join(out, '.obs-demo')):
        raise SystemExit(f'{out} is not empty and was not made by this script')
    home = os.path.join(out, 'home')
    os.makedirs(home, exist_ok=True)
    open(os.path.join(out, '.obs-demo'), 'w').close()
    rng = random.Random(20261018)
    now = time.time()
    day0 = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=DAYS)
    count = {p: 0 for p in PROFILES}
    for d in range(DAYS + 1):
        day = day0 + timedelta(days=d)
        n = rng.randint(6, 11) if day.weekday() < 5 else rng.randint(0, 3)
        for _ in range(n):
            start = day.replace(hour=rng.randint(9, 18), minute=rng.randint(0, 59)).timestamp()
            if start > now - 3 * 3600:
                continue
            profile = rng.choices(list(PROFILES), [v[0] for v in PROFILES.values()])[0]
            project = rng.choice(list(PROJECTS))
            s = Session(rng, profile, project, start).build()
            folder = os.path.join(home, '.' + profile, 'projects', '-Users-dev-code-' + project)
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, s.sid + '.jsonl')
            with open(path, 'w') as f:
                f.writelines(json.dumps(r) + '\n' for r in s.rows)
            for i, (tool, sub) in enumerate(s.subs):
                sub_dir = os.path.join(folder, s.sid, 'subagents')
                os.makedirs(sub_dir, exist_ok=True)
                with open(os.path.join(sub_dir, f'agent-{i}.jsonl'), 'w') as f:
                    f.writelines(json.dumps({**r, 'isSidechain': True}) + '\n' for r in sub)
                with open(os.path.join(sub_dir, f'agent-{i}.meta.json'), 'w') as f:
                    json.dump({'toolUseId': tool}, f)
            os.utime(path, (min(s.t, now - 3600),) * 2)
            count[profile] += 1
    print(', '.join(f'{p}: {n} sessions' for p, n in count.items()), f'-> {home}')


if __name__ == '__main__':
    main()
