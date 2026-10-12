"""The weekly digest and the shareable summary, from the usage database.

digest(): last full week (Monday to Sunday) against the week before: spend, sessions, top project and model,
cache hit rate, new advisor recommendations. fmt_digest_line() is the toast, fmt_digest() the /analytics digest.
summary(): the last N days as a dict; to_md() and to_html() render it for sharing (no prompts, no file paths:
projects are named by their last folder, and --no-projects leaves them out)."""
import html
import os
from datetime import date, datetime, timedelta


def week_bounds(today=None):
    """(start, end) of the last full week and of the one before, as ISO dates (end inclusive)."""
    today = today or date.today()
    this_monday = today - timedelta(days=today.weekday())
    last = this_monday - timedelta(days=7)
    prev = last - timedelta(days=7)
    return (last.isoformat(), (last + timedelta(days=6)).isoformat()), (prev.isoformat(), (prev + timedelta(days=6)).isoformat())


def _totals(con, start, end):
    r = con.execute('''SELECT COALESCE(SUM(cost_usd), 0), COUNT(DISTINCT session_id), COUNT(*),
        SUM(cache_read), SUM(input + cache_read + cache_write), COUNT(DISTINCT day)
        FROM requests WHERE day BETWEEN ? AND ?''', (start, end)).fetchone()
    cost, sessions, requests, cr, ctx, days = r
    return {'cost': round(cost or 0, 2), 'sessions': sessions or 0, 'requests': requests or 0, 'activeDays': days or 0,
            'cacheHit': round(cr / ctx, 3) if ctx else None}


def _top(con, col, start, end, n=1):
    rows = con.execute(f'''SELECT {col}, SUM(cost_usd) c FROM requests WHERE day BETWEEN ? AND ? AND {col} IS NOT NULL
        GROUP BY {col} ORDER BY c DESC LIMIT ?''', (start, end, n)).fetchall()
    return [[r[0], round(r[1] or 0, 2)] for r in rows]


def short_project(p):
    return os.path.basename(str(p).rstrip('/')) or str(p)


def digest(con, today=None, new_recs=()):
    (s, e), (ps, pe) = week_bounds(today)
    cur, prev = _totals(con, s, e), _totals(con, ps, pe)
    change = None
    if prev['cost'] > 0:
        change = round(cur['cost'] / prev['cost'] - 1, 3)
    proj = _top(con, 'project', s, e)
    model = _top(con, 'model', s, e)
    return {'from': s, 'to': e, 'week': date.fromisoformat(s).strftime('%G-W%V'), **cur, 'prev': prev, 'change': change,
            'topProject': [short_project(proj[0][0]), proj[0][1]] if proj else None,
            'topModel': model[0] if model else None,
            'newRecs': [r for r in new_recs if s <= str(r.get('created', ''))[:10]]}


def _usd(v):
    if v is None:
        return '–'
    sign, v = ('-' if v < 0 else ''), abs(v)
    return f'{sign}${v:,.2f}' if v < 100 else f'{sign}${v:,.0f}'


def _pct(v):
    return '' if v is None else f'{v * 100:+.0f}%'


def fmt_digest_line(d):
    """One line for the weekly toast; empty when the week had no usage."""
    if not d['requests']:
        return ''
    vs = f" ({_pct(d['change'])} vs the week before)" if d['change'] is not None else ''
    top = f", most on {d['topProject'][0]} ({_usd(d['topProject'][1])})" if d['topProject'] else ''
    recs = f" · {len(d['newRecs'])} new advisor tip{'s' if len(d['newRecs']) != 1 else ''}" if d['newRecs'] else ''
    return f"Last week: {_usd(d['cost'])} over {d['sessions']} sessions{vs}{top}{recs}."


def fmt_digest(d):
    if not d['requests']:
        return f"No usage recorded {d['from']} – {d['to']}."
    p = d['prev']
    hit = lambda v: '–' if v is None else f'{v * 100:.0f}%'
    out = [f"Week {d['week']} ({d['from']} – {d['to']})  vs the week before",
           f"  spend     {_usd(d['cost']):>10}  {_usd(p['cost']):>10}  {_pct(d['change'])}",
           f"  sessions  {d['sessions']:>10}  {p['sessions']:>10}",
           f"  requests  {d['requests']:>10}  {p['requests']:>10}",
           f"  cache hit {hit(d['cacheHit']):>10}  {hit(p['cacheHit']):>10}",
           f"  days used {d['activeDays']:>10}  {p['activeDays']:>10}"]
    if d['topProject']:
        out.append(f"  top project: {d['topProject'][0]} ({_usd(d['topProject'][1])})")
    if d['topModel']:
        out.append(f"  top model:   {d['topModel'][0]} ({_usd(d['topModel'][1])})")
    for r in d['newRecs'][:5]:
        out.append(f"  advisor: {r.get('title')}  (/analytics advise show)")
    out.append('Costs are list-price estimates. /analytics summary --days 7 makes a shareable version.')
    return '\n'.join(out)


def summary(con, days=30, projects=True, impact=None, today=None):
    today = today or date.today()
    start = (today - timedelta(days=max(1, days) - 1)).isoformat()
    end = today.isoformat()
    t = _totals(con, start, end)
    by_day = [[r[0], round(r[1] or 0, 2), r[2]] for r in con.execute(
        '''SELECT day, SUM(cost_usd), COUNT(DISTINCT session_id) FROM requests WHERE day BETWEEN ? AND ?
           GROUP BY day ORDER BY day''', (start, end))]
    models = [[r[0], round(r[1] or 0, 2), r[2]] for r in con.execute(
        '''SELECT model, SUM(cost_usd), COUNT(*) FROM requests WHERE day BETWEEN ? AND ? AND model IS NOT NULL
           GROUP BY model ORDER BY SUM(cost_usd) DESC LIMIT 6''', (start, end))]
    projs = []
    if projects:
        agg = {}
        for p, c, s in con.execute('''SELECT project, SUM(cost_usd), COUNT(DISTINCT session_id) FROM requests
                WHERE day BETWEEN ? AND ? AND project IS NOT NULL GROUP BY project''', (start, end)):
            k = short_project(p)
            a = agg.setdefault(k, [0.0, 0])
            a[0] += c or 0
            a[1] += s
        projs = sorted(([k, round(v[0], 2), v[1]] for k, v in agg.items()), key=lambda r: -r[1])[:8]
    agents = con.execute('''SELECT COALESCE(SUM(CASE WHEN agent_id IS NOT NULL THEN cost_usd END), 0), COALESCE(SUM(cost_usd), 0)
        FROM requests WHERE day BETWEEN ? AND ?''', (start, end)).fetchone()
    mods = []
    for m in (impact or {}).get('mods', []):
        mods.append({'mod': m['mod'], 'verdict': m['verdict'][1], 'net': m.get('net')})
    return {'from': start, 'to': end, 'days': days, 'generated': datetime.now().isoformat(timespec='minutes'), **t,
            'perActiveDay': round(t['cost'] / t['activeDays'], 2) if t['activeDays'] else None,
            'subagentShare': round(agents[0] / agents[1], 3) if agents[1] else None,
            'byDay': by_day, 'models': models, 'projects': projs, 'mods': mods}


def to_md(s):
    hit = '–' if s['cacheHit'] is None else f"{s['cacheHit'] * 100:.0f}%"
    sub = '–' if s['subagentShare'] is None else f"{s['subagentShare'] * 100:.0f}%"
    out = [f"# Claude Code usage, {s['from']} – {s['to']}", '',
           f"| Spend | Sessions | Requests | Days used | Per day used | Cache hit | Subagents |",
           '|---:|---:|---:|---:|---:|---:|---:|',
           f"| {_usd(s['cost'])} | {s['sessions']} | {s['requests']:,} | {s['activeDays']} | {_usd(s['perActiveDay'])} | {hit} | {sub} of spend |", '']
    if s['models']:
        out += ['## By model', '', '| Model | Spend | Requests |', '|---|---:|---:|']
        out += [f'| {m} | {_usd(c)} | {n:,} |' for m, c, n in s['models']] + ['']
    if s['projects']:
        out += ['## By project', '', '| Project | Spend | Sessions |', '|---|---:|---:|']
        out += [f'| {p} | {_usd(c)} | {n} |' for p, c, n in s['projects']] + ['']
    if s['mods']:
        out += ['## Mods', '', '| Mod | Verdict | Net (ledger) |', '|---|---|---:|']
        out += [f"| {m['mod']} | {m['verdict']} | {_usd(m['net'])} |" for m in s['mods']] + ['']
    if s['byDay']:
        peak = max(c for _, c, _ in s['byDay']) or 1
        out += ['## By day', '', '```']
        out += [f"{d}  {'█' * max(1, round(20 * c / peak)) if c else '':<20}  {_usd(c)}" for d, c, _ in s['byDay']] + ['```', '']
    out.append(f"_Costs are list-price estimates from Claude Code transcripts (usage-analytics, {s['generated']})._")
    return '\n'.join(out) + '\n'


def to_html(s):
    e = html.escape
    hit = '–' if s['cacheHit'] is None else f"{s['cacheHit'] * 100:.0f}%"
    sub = '–' if s['subagentShare'] is None else f"{s['subagentShare'] * 100:.0f}%"
    peak = max([c for _, c, _ in s['byDay']] or [0]) or 1
    bars = ''.join(f'<div class="bar" title="{e(d)}: {_usd(c)}"><i style="height:{max(2, round(100 * c / peak))}%"></i></div>' for d, c, _ in s['byDay'])

    def tbl(title, head, rows):
        if not rows:
            return ''
        th = ''.join(f'<th>{e(h)}</th>' for h in head)
        tr = ''.join('<tr>' + ''.join(f'<td>{e(str(c))}</td>' for c in r) + '</tr>' for r in rows)
        return f'<h2>{e(title)}</h2><table><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'

    tiles = [('Spend', _usd(s['cost'])), ('Sessions', s['sessions']), ('Requests', f"{s['requests']:,}"), ('Days used', s['activeDays']),
             ('Per day used', _usd(s['perActiveDay'])), ('Cache hit', hit), ('Subagents', f'{sub} of spend')]
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code usage</title><style>
:root{{--bg:#fbfaf7;--fg:#1f1e1c;--mut:#6b6862;--line:#e6e2da;--acc:#c96442}}
@media (prefers-color-scheme:dark){{:root{{--bg:#1c1b19;--fg:#ece9e2;--mut:#a29e96;--line:#34322e;--acc:#e08a6a}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:860px;margin:0 auto}}h1{{font-size:22px;margin:0 0 4px}}h2{{font-size:15px;margin:28px 0 8px}}
.mut{{color:var(--mut);font-size:13px}}.tiles{{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:16px 0}}
.tile{{border:1px solid var(--line);border-radius:8px;padding:10px 12px}}.tile b{{display:block;font-size:20px;font-variant-numeric:tabular-nums}}
.tile span{{color:var(--mut);font-size:12px}}table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}
th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}}th{{color:var(--mut);font-weight:500;font-size:12px}}
td:not(:first-child),th:not(:first-child){{text-align:right}}.bars{{display:flex;align-items:flex-end;gap:2px;height:90px;margin-top:8px}}
.bar{{flex:1;height:100%;display:flex;align-items:flex-end}}.bar i{{display:block;width:100%;background:var(--acc);border-radius:2px 2px 0 0}}
</style></head><body><main>
<h1>Claude Code usage</h1><div class="mut">{e(s['from'])} – {e(s['to'])}</div>
<div class="tiles">{''.join(f'<div class="tile"><b>{e(str(v))}</b><span>{e(k)}</span></div>' for k, v in tiles)}</div>
{f'<h2>Spend by day</h2><div class="bars">{bars}</div>' if s['byDay'] else ''}
{tbl('By model', ['Model', 'Spend', 'Requests'], [[m, _usd(c), f'{n:,}'] for m, c, n in s['models']])}
{tbl('By project', ['Project', 'Spend', 'Sessions'], [[p, _usd(c), n] for p, c, n in s['projects']])}
{tbl('Mods', ['Mod', 'Verdict', 'Net (ledger)'], [[m['mod'], m['verdict'], _usd(m['net'])] for m in s['mods']])}
<p class="mut">Costs are list-price estimates from Claude Code transcripts (usage-analytics, {e(s['generated'])}).</p>
</main></body></html>
'''
