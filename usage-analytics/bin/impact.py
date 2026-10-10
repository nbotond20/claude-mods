"""Mod impact: is each mod saving money, or costing more?

Three kinds of evidence, strongest first:

1. Holdout comparison (causal). Each mod puts a random share of sessions in a `holdout` arm where it
   stays passive (events kind='arm'). Sessions with the mod active are compared with holdout sessions on
   cost per prompt and friends, with a bootstrap 95% interval. Arms are independent per mod, so the
   other mods are balanced across both arms.
2. Direct ledger (mechanical). What each mod's own actions cost (guide sections and schemas read on
   every request, nudge text, classifier calls, keep-alive pings) against what they kept out (capped
   and trimmed output re-read by later requests, budget-guard's own savings estimates).
3. Compliance. After a nudge, how often the next calls did what it asked, compared with the holdout
   sessions where the same nudge would have fired.
"""
import json, os, random
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from paths import mods_home

MODS = ('budget-guard', 'lean-tools', 'lsp-first')
MIN_SESSIONS = 30
BOOT = 1000
HAIKU = 'claude-haiku-5-5'


def _iso_ms(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000
    except Exception:
        return None


def _since(days):
    return (datetime.now() - timedelta(days=days - 1)).strftime('%Y-%m-%d') if days else '0000'


def _events(con, since, profiles):
    sql = "SELECT ts, day, profile, sid, data FROM events WHERE ev = 'mod' AND day >= ?"
    p = [since]
    if profiles:
        sql += f" AND profile IN ({','.join('?' * len(profiles))})"
        p += profiles
    for ts, day, prof, sid, data in con.execute(sql + ' ORDER BY ts', p):
        d = json.loads(data or '{}')
        d.update(ts=ts, day=day, profile=prof, sid=sid)
        yield d


def _session_metrics(con, sids):
    """Per session: cost, prompts, requests, main context, tool output (all agents)."""
    out = {}
    sids = list(sids)
    for i in range(0, len(sids), 500):
        chunk = sids[i:i + 500]
        q = ','.join('?' * len(chunk))
        for sid, cost, reqs, ctx, hit in con.execute(f'''SELECT session_id, SUM(cost_usd), COUNT(*),
                AVG(CASE WHEN agent_id IS NULL THEN input + cache_read + cache_write END),
                1.0 * SUM(cache_read) / NULLIF(SUM(input + cache_read + cache_write), 0)
                FROM requests WHERE session_id IN ({q}) GROUP BY session_id''', chunk):
            out[sid] = {'cost': cost or 0, 'requests': reqs, 'context': ctx or 0, 'hit': hit or 0, 'prompts': 0, 'tool_chars': 0}
        for sid, n in con.execute(f"SELECT session_id, COUNT(*) FROM prompts WHERE kind = 'prompt' AND session_id IN ({q}) GROUP BY 1", chunk):
            if sid in out:
                out[sid]['prompts'] = n
        for sid, n in con.execute(f'SELECT session_id, SUM(result_chars) FROM tool_uses WHERE session_id IN ({q}) GROUP BY 1', chunk):
            if sid in out:
                out[sid]['tool_chars'] = n or 0
    return out


def _ratio(rows, num, den):
    d = sum(r[den] for r in rows)
    return sum(r[num] for r in rows) / d if d else None


def _boot(on, off, num, den, rng):
    """Bootstrap 95% interval of (on/off - 1) for the ratio-of-sums metric num/den."""
    if len(on) < 2 or len(off) < 2:
        return None, None
    diffs = []
    for _ in range(BOOT):
        a = _ratio([on[rng.randrange(len(on))] for _ in on], num, den)
        b = _ratio([off[rng.randrange(len(off))] for _ in off], num, den)
        if a is not None and b:
            diffs.append(a / b - 1)
    if len(diffs) < BOOT // 2:
        return None, None
    diffs.sort()
    return diffs[int(len(diffs) * 0.025)], diffs[int(len(diffs) * 0.975) - 1]


METRICS = [  # name, numerator, denominator, lower is better
    ('cost per prompt', 'cost', 'prompts', True),
    ('requests per prompt', 'requests', 'prompts', True),
    ('tool output chars per prompt', 'tool_chars', 'prompts', True),
    ('cost per request', 'cost', 'requests', True),
]


class Pricer:
    def __init__(self, coster):
        self.coster = coster

    def read(self, model, speed=None):
        return (self.coster(model, speed, 0, 0, 1_000_000, 0, 0, 0) or 0) / 1e6

    def write(self, model, speed=None):
        return (self.coster(model, speed, 0, 0, 0, 1_000_000, 0, 1_000_000) or 0) / 1e6

    def call(self, model, inp, out, cr=0, cw=0):
        return self.coster(model, 'standard', inp, out, cr, cw, 0, cw) or 0


def _main_requests(con, sids):
    """Main-loop requests per session as (ms, model, speed), and compaction times."""
    reqs, comp = defaultdict(list), defaultdict(list)
    sids = list(sids)
    for i in range(0, len(sids), 500):
        chunk = sids[i:i + 500]
        q = ','.join('?' * len(chunk))
        for sid, ts, model, speed in con.execute(f'SELECT session_id, ts, model, speed FROM requests WHERE agent_id IS NULL AND session_id IN ({q}) ORDER BY ts', chunk):
            ms = _iso_ms(ts)
            if ms:
                reqs[sid].append((ms, model, speed))
        for sid, ts in con.execute(f"SELECT session_id, ts FROM system_events WHERE subtype = 'compact_boundary' AND session_id IN ({q})", chunk):
            ms = _iso_ms(ts)
            if ms:
                comp[sid].append(ms)
    return reqs, comp


def _carry(pr, reqs, comp, sid, ts, tokens, survives_compaction=False):
    """Dollars to carry `tokens` of context from `ts` on: one cache write, then a cache read per later
    main-loop request, until the next compaction (system prompt parts survive compaction)."""
    later = [r for r in reqs.get(sid, ()) if r[0] > ts]
    if not survives_compaction:
        cut = min((c for c in comp.get(sid, ()) if c > ts), default=None)
        if cut is not None:
            later = [r for r in later if r[0] < cut]
    if not later:
        return 0.0, 0
    usd = tokens * pr.write(later[0][1], later[0][2]) + sum(tokens * pr.read(m, s) for _, m, s in later[1:])
    return usd, len(later)


def _ledgers():
    d = os.path.join(mods_home(), 'budget-guard', 'sessions')
    out = {}
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if f.endswith('.json'):
            try:
                j = json.load(open(os.path.join(d, f)))
                out[j.get('id')] = j
            except Exception:
                pass
    return out


def impact(con, coster, days=30, profiles=None, seed=7):
    rng = random.Random(seed)
    pr = Pricer(coster)
    since = _since(days)
    evs = list(_events(con, since, profiles or []))
    arms = {}  # (mod, sid) -> arm
    hold_share = {}
    for e in evs:
        if e.get('kind') == 'arm' and e.get('mod'):
            arms[(e['mod'], e['sid'])] = e.get('arm', 'on')
            hold_share[e['mod']] = e.get('holdout')
    sids = {sid for _, sid in arms}
    metrics = _session_metrics(con, sids)
    reqs, comp = _main_requests(con, sids)
    ledgers = _ledgers()

    result = {'since': since, 'mods': [], 'observer': {
        'mod': 'usage-analytics', 'note': 'Observer only: adds nothing to prompts and makes no model calls, so it costs no tokens.'}}
    for mod in MODS:
        m = {'mod': mod, 'holdoutShare': hold_share.get(mod), 'arms': {}, 'effects': [], 'costs': [], 'savings': [], 'compliance': [], 'actions': []}
        by_arm = {'on': [], 'holdout': []}
        for (md, sid), arm in arms.items():
            if md == mod and sid in metrics and metrics[sid]['prompts'] > 0:
                by_arm.setdefault(arm, []).append(metrics[sid])
        for arm, rows in by_arm.items():
            m['arms'][arm] = {
                'sessions': len(rows), 'prompts': sum(r['prompts'] for r in rows), 'cost': round(sum(r['cost'] for r in rows), 2),
                'costPerPrompt': _ratio(rows, 'cost', 'prompts'), 'requestsPerPrompt': _ratio(rows, 'requests', 'prompts'),
                'toolCharsPerPrompt': _ratio(rows, 'tool_chars', 'prompts'), 'costPerRequest': _ratio(rows, 'cost', 'requests'),
                'avgContext': sum(r['context'] for r in rows) / len(rows) if rows else None,
            }
        on, off = by_arm['on'], by_arm['holdout']
        for name, num, den, lower in METRICS:
            a, b = _ratio(on, num, den), _ratio(off, num, den)
            lo, hi = _boot(on, off, num, den, rng) if len(on) >= MIN_SESSIONS and len(off) >= MIN_SESSIONS else (None, None)
            m['effects'].append({'metric': name, 'on': a, 'holdout': b, 'diff': (a / b - 1) if a is not None and b else None, 'lo': lo, 'hi': hi})
        main = m['effects'][0]
        if len(on) < MIN_SESSIONS or len(off) < MIN_SESSIONS:
            m['verdict'] = ('collecting', f'collecting data: {len(on)} active / {len(off)} holdout sessions (need {MIN_SESSIONS}+ each)')
        elif main['hi'] is not None and main['hi'] < 0:
            m['verdict'] = ('saving', f"saving: cost per prompt {main['diff'] * 100:+.0f}% (95% CI {main['lo'] * 100:+.0f}% to {main['hi'] * 100:+.0f}%)")
        elif main['lo'] is not None and main['lo'] > 0:
            m['verdict'] = ('costing', f"COSTING MORE: cost per prompt {main['diff'] * 100:+.0f}% (95% CI {main['lo'] * 100:+.0f}% to {main['hi'] * 100:+.0f}%)")
        else:
            d = main['diff']
            m['verdict'] = ('unclear', f"no clear effect yet: cost per prompt {d * 100:+.0f}%" + (f" (95% CI {main['lo'] * 100:+.0f}% to {main['hi'] * 100:+.0f}%)" if main['lo'] is not None else ''))

        # Direct ledger, active arm only.
        cost = defaultdict(lambda: [0.0, 0])
        save = defaultdict(lambda: [0.0, 0])
        acts = defaultdict(int)
        outcome = defaultdict(lambda: [0, 0])
        for e in evs:
            if e.get('mod') != mod:
                continue
            k, arm, sid, ts = e.get('kind'), e.get('arm', 'on'), e['sid'], e['ts']
            acts[(k, arm)] += 1
            if k == 'nudge_outcome':
                o = outcome[(e.get('nudge'), arm)]
                o[0] += e.get('followed', 0)
                o[1] += e.get('total', 0)
            if arm != 'on':
                continue
            if k in ('guide', 'schema_upfront'):
                usd, _ = _carry(pr, reqs, comp, sid, ts, e.get('chars', 0) / 4, survives_compaction=True)
                c = cost['system prompt section (read on every request)' if k == 'guide' else 'LSP schema loaded up front']
                c[0] += usd
                c[1] += 1
            elif k == 'nudge':
                usd, _ = _carry(pr, reqs, comp, sid, ts, e.get('chars', 0) / 4)
                c = cost[f"nudge text ({e.get('nudge')})"]
                c[0] += usd
                c[1] += 1
            elif k == 'classify':
                c = cost[f"Haiku classifier ({e.get('purpose')})"]
                c[0] += pr.call(HAIKU, e.get('inputChars', 0) / 4 + 60, 5)
                c[1] += 1
            elif k == 'keepalive':
                c = cost['keep-alive pings' + ('' if e.get('hit') else ' (missed cache)')]
                c[0] += pr.call(e.get('model') or 'opus', e.get('input', 0), e.get('output', 0), e.get('cacheRead', 0), e.get('cacheWrite', 0))
                c[1] += 1
            elif k in ('cap', 'trim'):
                tokens = max(0, e.get('bytesAll', 0) - e.get('bytesKept', 0)) / 4
                usd, _ = _carry(pr, reqs, comp, sid, ts, tokens)
                s = save['shell output kept out of context (cap)' if k == 'cap' else 'build/test output trimmed']
                s[0] += usd
                s[1] += 1
        if mod == 'budget-guard':
            for sid_, j in ledgers.items():
                if arms.get((mod, sid_)) != 'on':
                    continue
                for cat, v in (j.get('saved') or {}).items():
                    if cat == 'output-trim':
                        continue  # counted above from the trim events
                    s = save[f'{cat} (budget-guard estimate)']
                    s[0] += v.get('usd', 0)
                    s[1] += v.get('count', 0)
        m['costs'] = sorted(([k, round(v[0], 2), v[1]] for k, v in cost.items()), key=lambda r: -r[1])
        m['savings'] = sorted(([k, round(v[0], 2), v[1]] for k, v in save.items()), key=lambda r: -r[1])
        m['net'] = round(sum(r[1] for r in m['savings']) - sum(r[1] for r in m['costs']), 2)
        m['actions'] = sorted(([k, a, n] for (k, a), n in acts.items()), key=lambda r: (r[0], r[1]))
        for (nudge, arm), (f, t) in sorted(outcome.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])):
            m['compliance'].append([nudge, arm, f, t, round(100 * f / t, 1) if t else None])
        m['warnings'] = _warnings(mod, acts, outcome)
        result['mods'].append(m)

    daily = defaultdict(int)
    for e in evs:
        if e.get('kind') not in ('arm', 'session_summary'):
            daily[(e['day'], e.get('mod'), e.get('kind'))] += 1
    result['daily'] = {'cols': ['day', 'mod', 'kind', 'n'], 'rows': [[d, m_, k, n] for (d, m_, k), n in sorted(daily.items())]}
    return result


def _warnings(mod, acts, outcome):
    """Signs that a mechanism costs more than it saves."""
    w = []
    n = lambda k, a='on': acts.get((k, a), 0)
    if mod == 'lean-tools' and n('cap') >= 5 and n('cap_followup') / n('cap') > 0.3:
        w.append(f"{n('cap_followup')} of {n('cap')} capped outputs were re-opened: the cap may be too tight (raise maxBytes/maxLines).")
    if mod == 'budget-guard':
        if n('keepalive') >= 3:
            pass
        if n('hold') >= 3 and acts.get(('resolve', 'on'), 0):
            pass
        if n('deny') >= 5:
            w.append(f"{n('deny')} denials: check they did not push work into longer workarounds.")
    for (nudge, arm), (f, t) in outcome.items():
        if arm != 'on' or t < 20:
            continue
        hf, ht = outcome.get((nudge, 'holdout'), (0, 0))
        if ht >= 20 and f / t <= hf / ht:
            w.append(f"'{nudge}' nudges are not changing behaviour ({100 * f / t:.0f}% followed vs {100 * hf / ht:.0f}% without them): consider turning them off.")
    return w


def fmt_text(r):
    usd = lambda v: '–' if v is None else f'${v:,.2f}'
    pct = lambda v: '–' if v is None else f'{v * 100:+.0f}%'
    out = [f"Mod impact since {r['since']}  (holdout comparison · direct ledger · nudge compliance)", '']
    for m in r['mods']:
        out.append(f"■ {m['mod']}  — {m['verdict'][1]}")
        share = m['holdoutShare']
        a, h = m['arms'].get('on', {}), m['arms'].get('holdout', {})
        out.append(f"  arms: active {a.get('sessions', 0)} sessions, holdout {h.get('sessions', 0)} (holdout share {'?' if share is None else f'{share * 100:.0f}%'})")
        for e in m['effects']:
            ci = f" [{pct(e['lo'])} … {pct(e['hi'])}]" if e['lo'] is not None else ''
            fm = usd if 'cost' in e['metric'] else (lambda v: '–' if v is None else f'{v:,.1f}')
            out.append(f"    {e['metric']:<30} active {fm(e['on']):>10}  holdout {fm(e['holdout']):>10}  {pct(e['diff']):>6}{ci}")
        if m['costs'] or m['savings']:
            out.append(f"  ledger (active sessions): saved {usd(sum(x[1] for x in m['savings']))} · own cost {usd(sum(x[1] for x in m['costs']))} · net {usd(m['net'])}")
            for k, v, n in m['savings'][:5]:
                out.append(f"    + {usd(v):>9}  {k} ×{n}")
            for k, v, n in m['costs'][:5]:
                out.append(f"    − {usd(v):>9}  {k} ×{n}")
        if m['compliance']:
            out.append('  nudge followed: ' + ', '.join(f"{n} {a} {f}/{t}" for n, a, f, t, _ in m['compliance']))
        for w in m['warnings']:
            out.append(f'  ⚠ {w}')
        out.append('')
    out.append(f"■ usage-analytics — {r['observer']['note']}")
    return '\n'.join(out)
