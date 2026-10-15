"""Advisor: a self-improving loop over the usage data.

    measure ──► detect ──► research (an agent: this data + the web) ──► recommend
       ▲                                                                    │
       └── verify (A/B trial, control group, or before/after) ◄── trial / apply ◄┘

* Metrics: a fixed catalog, four goals (cost, tokens, speed, reliability). Each metric is a ratio of
  per-session sums, so any window (a week, before/after a change) is comparable and bootstrappable.
  Trends: weekly values with a Theil–Sen slope and a Mann–Kendall test, so "rising" means a real trend.
* Detectors: deterministic findings with evidence; they work without any model and seed the research.
* Recommendations are falsifiable claims, written by the research agent (`record`): one metric, the expected
  relative effect, the scope (projects / profiles it is meant for), the SQL behind every number it quotes and
  its sources. `record` re-runs that SQL itself, so the numbers on a recommendation are this data's, not the
  model's; and adds what it is worth for this person (exposure × effect × spend) and how many sessions a
  verdict will need (a power calculation from the spread of their own sessions).
* Verification, the strongest design available:
  1. randomized: a recommendation that is an instruction to the model runs as an A/B trial. The mod adds it
     to a random half of sessions (a hash of rec + session id), and once adopted keeps a 10% holdout. Both
     arms run in the same weeks, so drift and workload changes cancel out.
  2. control group: a change scoped to some projects or profiles is compared with the rest over the same
     windows (difference in differences).
  3. before/after: 28 days each side, standardized to the before period's project mix, with a placebo test
     one window earlier; if the metric was already drifting, the estimate is corrected for that drift.
  Estimates come with a stratified bootstrap 95% interval (1000 resamples, seeded from the recommendation
  id: the same sessions always give the same numbers). Also: side effects on guard metrics, confounders
  (setting changes and other changes in the same week), and the effect per project, since what helps in one
  kind of work can hurt in another.
* Evidence grade: A randomized on this data · B controlled measurement on this data · C this data's pattern
  plus a primary source · D anything weaker.
* Memory: every run's notes and every verdict go back into the next run's brief, so the advisor learns
  which kinds of advice work for this person and stops repeating what did not.

Writes only <data>/advisor.db and <data>/advisor-trials.json; reads usage.db read-only.
"""
import fcntl, hashlib, json, math, os, random, re, sqlite3, time, uuid, zlib
from datetime import datetime, timedelta

import quality


GOALS = ('cost', 'tokens', 'speed', 'reliability', 'quality')
# key, label, goal, numerator, denominator, scale, lower is better (None: a lever, no good direction), unit
METRICS = [
    ('cost_per_prompt', 'Cost per prompt', 'cost', 'cost', 'prompts', 1, True, 'usd'),
    ('premium_share', 'Spend on Opus / Fable', 'cost', 'premium_cost', 'cost', 100, None, 'pct'),
    ('subagent_share', 'Spend inside subagents', 'cost', 'sub_cost', 'cost', 100, None, 'pct'),
    ('tokens_per_prompt', 'Tokens per prompt', 'tokens', 'tokens', 'prompts', 1, True, 'num'),
    ('avg_context', 'Main-loop context per request', 'tokens', 'main_ctx', 'main_reqs', 1, True, 'num'),
    ('cache_hit', 'Cache hit rate', 'tokens', 'cache_read', 'ctx_total', 100, False, 'pct'),
    ('tool_output_per_prompt', 'Tool output chars per prompt', 'tokens', 'tool_chars', 'prompts', 1, True, 'num'),
    ('whole_file_reads', 'Whole-file Reads', 'tokens', 'whole_reads', 'reads', 100, True, 'pct'),
    ('output_per_request', 'Output tokens per request', 'tokens', 'output', 'requests', 1, True, 'num'),
    ('non_english_prompts', 'Prompts not in English', 'tokens', 'non_en', 'prompts', 100, None, 'pct'),
    ('prompt_chars', 'Prompt length (chars)', 'tokens', 'prompt_chars', 'prompts', 1, None, 'num'),
    ('requests_per_prompt', 'Requests per prompt', 'speed', 'requests', 'prompts', 1, True, 'num'),
    ('turn_seconds', 'Turn time (s)', 'speed', 'turn_ms', 'turns', 0.001, True, 'sec'),
    ('tool_error_rate', 'Tool error rate', 'reliability', 'tool_errors', 'tool_calls', 100, True, 'pct'),
    ('api_errors', 'API errors per 100 requests', 'reliability', 'api_errors', 'requests', 100, True, 'num'),
    ('compactions', 'Compactions per 100 prompts', 'reliability', 'compactions', 'prompts', 100, True, 'num'),
    ('idle_recache', 'Cache writes after an idle gap', 'cost', 'idle_rewrite', 'cw_main', 100, True, 'pct'),
    # Quality: was the output right the first time? (rules in quality.py)
    ('correction_rate', 'Corrections per 100 follow-ups', 'quality', 'corrections', 'followups', 100, True, 'num'),
    ('interrupt_rate', 'Interrupts per 100 prompts', 'quality', 'interrupts', 'prompts', 100, True, 'num'),
    ('rejection_rate', 'Rejected calls per 100 prompts', 'quality', 'rejections', 'prompts', 100, True, 'num'),
    ('edit_churn', 'Edits redoing their own lines', 'quality', 'churn_edits', 'edits', 100, True, 'pct'),
    ('verify_pass', 'Turns whose last check passed', 'quality', 'verify_pass', 'verify_turns', 100, False, 'pct'),
    ('verify_coverage', 'Editing turns with a check', 'quality', 'verify_turns_edit', 'edit_turns', 100, None, 'pct'),
    ('edit_survival', 'Lines kept at the next commit', 'quality', 'lines_kept', 'lines_written', 100, False, 'pct'),
    ('files_shipped', 'Edited files committed', 'quality', 'files_committed', 'files_edited', 100, False, 'pct'),
]
M = {m[0]: m for m in METRICS}
# A cheaper or faster change that makes the output worse is not an improvement: the quality guards catch that.
GUARDS = ('cost_per_prompt', 'requests_per_prompt', 'tool_error_rate', 'turn_seconds', 'api_errors', 'correction_rate', 'verify_pass', 'interrupt_rate')
# A guard only counts as a side effect when it also got worse by at least this much in its own unit:
# a rare event doubling (0.02 → 0.04 API errors per 100 requests) is not a cost.
GUARD_FLOOR = {'cost_per_prompt': 0.02, 'requests_per_prompt': 0.5, 'tool_error_rate': 1.0, 'turn_seconds': 5.0, 'api_errors': 0.5,
               'correction_rate': 2.0, 'verify_pass': 5.0, 'interrupt_rate': 2.0}
STATUSES = ('proposed', 'accepted', 'trial', 'applied', 'dismissed', 'reverted')
WINDOW_DAYS = 28        # before/after window around an applied recommendation
MIN_AFTER = 8           # sessions on each side before any verdict
SETTLED_AFTER = 25      # sessions after which "no clear change" can become "no effect"
FLAT = 0.05             # changes within ±5% count as flat in trends
TRIAL_SHARE = 0.5       # share of sessions that get a trialled instruction
HOLDOUT = 0.1           # share of sessions that keep going without an adopted instruction
B_VERIFY = 1000         # bootstrap resamples for a verdict's own metric
B_SIDE = 400            # … for guard metrics, the placebo and per-project effects
B_TREND = 300           # … for the dashboard's trend intervals
CONFOUND_DAYS = 7       # setting changes and other changes this close to a start are confounders
STALE_NOTE_DAYS = 90    # research notes older than this are re-checked before being relied on
Z_POWER = 2.8           # z(97.5%) + z(80%): 80% power at the 5% level
METHOD = 'advisor-stats/2'
# Hosts whose pages count as primary sources about Claude and Claude Code.
PRIMARY = ('anthropic.com', 'claude.com', 'claude.ai', 'github.com/anthropics')

DDL = '''
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, started TEXT, finished TEXT, kind TEXT, trigger_ TEXT, model TEXT,
  summary TEXT, recs INTEGER DEFAULT 0, status TEXT);
CREATE TABLE IF NOT EXISTS recs (id TEXT PRIMARY KEY, run_id TEXT, created TEXT, title TEXT, goal TEXT, metric TEXT,
  expected TEXT, rationale TEXT, evidence TEXT, action TEXT, apply_kind TEXT, effort TEXT, risk TEXT, sources TEXT,
  supersedes TEXT, status TEXT, status_at TEXT, applied_at TEXT, baseline REAL, note TEXT,
  verdict TEXT, verdict_at TEXT, verdict_detail TEXT, notified_verdict TEXT);
CREATE TABLE IF NOT EXISTS checks (rec_id TEXT, ts TEXT, verdict TEXT, before REAL, after REAL, diff REAL, lo REAL, hi REAL,
  n_before INTEGER, n_after INTEGER, side_effects TEXT);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, topic TEXT, finding TEXT, source TEXT);
'''
# Columns added after the first release, added in place to an existing advisor.db.
COLUMNS = {
    'recs': [('hypothesis', 'TEXT'), ('expected_effect', 'REAL'), ('scope', 'TEXT'), ('instruction', 'TEXT'), ('counter', 'TEXT'),
             ('checked', 'TEXT'), ('exposure', 'REAL'), ('impact', 'TEXT'), ('power', 'TEXT'), ('grade', 'TEXT'), ('warnings', 'TEXT'),
             ('trial_at', 'TEXT')],
    'checks': [('method', 'TEXT'), ('grade', 'TEXT')],
    'notes': [('published', 'TEXT'), ('checked', 'TEXT'), ('kind', 'TEXT')],
}

EN_STOP = set('''the a an and or but if of to in on at for with from by as is are was were be been it this that these those
i you we he she they me my your our not no do does did can could should would will just so then than there here what
which who how why when where please make add use fix need want some all any more also into about like have has had'''.split())
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def now_iso():
    return datetime.now().isoformat(timespec='seconds')


def day_of(iso):
    return (iso or '')[:10]


def adb(data_dir):
    con = sqlite3.connect(os.path.join(data_dir, 'advisor.db'), timeout=30)
    con.executescript(DDL)
    for table, cols in COLUMNS.items():
        have = {r[1] for r in con.execute(f'PRAGMA table_info({table})')}
        for c, kind in cols:
            if c not in have:
                con.execute(f'ALTER TABLE {table} ADD COLUMN {c} {kind}')
    con.commit()
    con.row_factory = sqlite3.Row
    return con


def _path(con):
    return next((r[2] for r in con.execute('PRAGMA database_list') if r[1] == 'main'), '') or ''


# ---------- language ----------

def is_english(text):
    """None for text too short to tell; else whether it reads as English (share of common English words)."""
    words = [w.lower() for w in WORD.findall(text or '')]
    if len(words) < 4:
        return None
    return sum(w in EN_STOP for w in words) / len(words) >= 0.12


# ---------- per-session rows ----------

def _in(col, vals):
    return (f' AND {col} IN ({",".join("?" * len(vals))})', list(vals)) if vals else ('', [])


def sessions(con, since, until=None, profiles=None):
    """One row per session that started in [since, until): every metric's numerator and denominator."""
    w, p = 'day >= ?', [since]
    if until:
        w += ' AND day < ?'; p.append(until)
    pw, pp = _in('profile', profiles)
    rows = {}
    for sid, prof, first, proj, entry, cost, reqs, tokens, out, cr, ctx, main_ctx, main_reqs, prem, sub in con.execute(f'''
            SELECT session_id, MAX(profile), MIN(day), MAX(project), MAX(entrypoint), TOTAL(cost_usd), COUNT(*), TOTAL(input + output + cache_read + cache_write),
              TOTAL(output), TOTAL(cache_read), TOTAL(input + cache_read + cache_write),
              TOTAL(CASE WHEN agent_id IS NULL THEN input + cache_read + cache_write END), SUM(agent_id IS NULL),
              TOTAL(CASE WHEN model LIKE '%opus%' OR model LIKE '%fable%' THEN cost_usd END),
              TOTAL(CASE WHEN agent_id IS NOT NULL THEN cost_usd END)
            FROM requests WHERE session_id IN (SELECT session_id FROM requests WHERE {w}{pw} GROUP BY session_id)
            GROUP BY session_id''', p + pp):
        if first < since or (until and first >= until):
            continue
        rows[sid] = dict(sid=sid, profile=prof, day=first, project=proj or '', entrypoint=entry or '', cost=cost, requests=reqs, tokens=tokens, output=out, cache_read=cr,
                         ctx_total=ctx, main_ctx=main_ctx, main_reqs=main_reqs or 0, premium_cost=prem, sub_cost=sub,
                         prompts=0, prompt_chars=0, non_en=0, tool_calls=0, tool_errors=0, tool_chars=0, reads=0, whole_reads=0,
                         api_errors=0, compactions=0, turns=0, turn_ms=0)
    sids = list(rows)
    for i in range(0, len(sids), 500):
        chunk = sids[i:i + 500]
        q = ','.join('?' * len(chunk))
        for sid, text, chars in con.execute(f"SELECT session_id, text, chars FROM prompts WHERE kind = 'prompt' AND agent_id IS NULL AND session_id IN ({q})", chunk):
            r = rows[sid]
            r['prompts'] += 1
            r['prompt_chars'] += chars or 0
            if is_english(text) is False:
                r['non_en'] += 1
        for sid, n, err, chars, reads, whole in con.execute(f'''SELECT session_id, COUNT(*), TOTAL(is_error), TOTAL(result_chars),
                SUM(tool = 'Read'), SUM(tool = 'Read' AND detail IS NULL) FROM tool_uses WHERE session_id IN ({q}) GROUP BY 1''', chunk):
            rows[sid].update(tool_calls=n, tool_errors=err, tool_chars=chars, reads=reads or 0, whole_reads=whole or 0)
        for sid, sub, n, ms in con.execute(f'''SELECT session_id, subtype, COUNT(*), TOTAL(duration_ms) FROM system_events
                WHERE subtype IN ('api_error', 'compact_boundary', 'turn_duration') AND agent_id IS NULL AND session_id IN ({q}) GROUP BY 1, 2''', chunk):
            r = rows[sid]
            if sub == 'api_error':
                r['api_errors'] = n
            elif sub == 'compact_boundary':
                r['compactions'] = n
            else:
                r['turns'], r['turn_ms'] = n, ms
    for sid, qv in quality.session_quality(con, sids).items():
        rows[sid].update(qv)
    return [r for r in rows.values() if r['prompts'] > 0]


def value(rows, key):
    _, _, _, num, den, scale, _, _ = M[key]
    d = sum(r[den] for r in rows)
    return sum(r[num] for r in rows) / d * scale if d else None


def _seed(*parts):
    """A fixed seed from stable parts, so a bootstrap on the same sessions always gives the same interval."""
    return zlib.crc32('|'.join(map(str, parts)).encode())


def _groups(rows, key, strata=None):
    """Sessions as (numerator, denominator) pairs of `key`, per stratum ('' when not stratified)."""
    _, _, _, num, den, _, _, _ = M[key]
    g = {}
    for r in rows:
        if r[den]:
            g.setdefault(strata(r) if strata else '', []).append((r[num], r[den]))
    return g


def _rel(ga, gb):
    """after/before - 1 of a ratio of sums, directly standardized: each stratum present in both periods
    weighs by its before-period denominator, so a shift in the mix of work does not read as an effect."""
    top = bot = 0.0
    for s, xb in gb.items():
        xa = ga.get(s)
        if not xa:
            continue
        top += sum(x[1] for x in xb) * sum(x[0] for x in xa) / sum(x[1] for x in xa)
        bot += sum(x[0] for x in xb)
    return top / bot - 1 if bot else None


def _ratio2(x, y):
    """(1 + x) / (1 + y) - 1: an effect net of another (the control group's change, or the drift before)."""
    return (1 + x) / (1 + y) - 1 if x is not None and y is not None and 1 + y > 0 else None


def _coverage(ga, gb):
    """Share of the before period's work (its denominator) in strata that also appear after."""
    tot = sum(x[1] for xs in gb.values() for x in xs)
    return sum(x[1] for s, xs in gb.items() if s in ga for x in xs) / tot if tot else 0.0


def _boot(stat, groups, seed, n):
    """Percentile 95% interval of stat(*groups), resampling sessions within each stratum of each group."""
    if any(sum(len(x) for x in g.values()) < 2 for g in groups):
        return None, None
    rng = random.Random(seed)
    vals = []
    for _ in range(n):
        v = stat(*[{s: rng.choices(x, k=len(x)) for s, x in g.items()} for g in groups])
        if v is not None:
            vals.append(v)
    if len(vals) < n // 2:
        return None, None
    vals.sort()
    return vals[int(len(vals) * 0.025)], vals[min(len(vals) - 1, int(len(vals) * 0.975))]


def estimate(stat, groups, seed, n=B_VERIFY):
    v = stat(*groups)
    lo, hi = _boot(stat, groups, seed, n) if v is not None else (None, None)
    return v, lo, hi


def compare(after, before, key, seed=11, n=B_TREND, strata=None):
    """Values after and before, the relative change after/before - 1 and its bootstrap 95% interval."""
    diff, lo, hi = estimate(_rel, [_groups(after, key, strata), _groups(before, key, strata)], seed, n)
    return value(after, key), value(before, key), diff, lo, hi


def rel_se(rows, key, strata=lambda r: r['project']):
    """Relative standard error of a ratio of per-session sums (delta method), with residuals taken within
    each project, as the stratified comparisons are: differences between projects are not noise there."""
    g = _groups(rows, key, strata)
    xs = [x for v in g.values() for x in v]
    n, N, D = len(xs), sum(x[0] for x in xs), sum(x[1] for x in xs)
    if n < 2 or not N or not D:
        return None
    ss = 0.0
    for v in g.values():
        Rs = sum(x[0] for x in v) / sum(x[1] for x in v)
        ss += sum((x - Rs * d) ** 2 for x, d in v)
    return math.sqrt(ss * n / (n - 1)) / D / (N / D)


def power(rows, key, effect, pace=None):
    """How many sessions a clear verdict on a relative change of `effect` needs (80% power, 5% level),
    from the spread of these sessions: after a before/after change (with `rows` as the before), and in total
    for an A/B trial. None: not detectable with this much variation."""
    se, n = rel_se(rows, key), len(rows)
    if se is None or not effect:
        return None
    s2 = se * se * n                     # one session's relative variance
    t2 = (abs(effect) / Z_POWER) ** 2
    after = max(MIN_AFTER, math.ceil(s2 / (t2 - se * se))) if t2 > se * se else None
    trial = max(2 * MIN_AFTER, math.ceil(s2 * (1 / TRIAL_SHARE + 1 / (1 - TRIAL_SHARE)) / t2))
    days = lambda k: math.ceil(k / pace) if k and pace else None
    return dict(effect=effect, after=after, after_days=days(after), trial=trial, trial_days=days(trial),
                mde=Z_POWER * se * math.sqrt(2), pace=round(pace, 2) if pace else None, n=n)


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    return None if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def slope(ys):
    """Theil–Sen slope of a series (as a share of its median, per step) and a Mann–Kendall p-value for a
    monotonic trend; None, None with fewer than 4 points."""
    pts = [(i, y) for i, y in enumerate(ys) if y is not None]
    n = len(pts)
    if n < 4:
        return None, None
    level = _median([y for _, y in pts])
    sl = _median([(y2 - y1) / (x2 - x1) for k, (x1, y1) in enumerate(pts) for x2, y2 in pts[k + 1:]])
    S = sum((y2 > y1) - (y2 < y1) for k, (_, y1) in enumerate(pts) for _, y2 in pts[k + 1:])
    z = (S - (S > 0) + (S < 0)) / math.sqrt(n * (n - 1) * (2 * n + 5) / 18)
    return (sl / abs(level) if level else None), math.erfc(abs(z) / math.sqrt(2))


def sense(key, diff, lo=None, hi=None):
    """better / worse / flat / neutral for a change of `diff`; with an interval, only when it excludes zero."""
    lower = M[key][6]
    if diff is None:
        return None
    if lower is None:
        return 'neutral'
    if lo is not None and hi is not None:
        if lo <= 0 <= hi:
            return 'flat'
    elif abs(diff) < FLAT:
        return 'flat'
    return 'better' if (diff < 0) == lower else 'worse'


def _trend(key, sl, p):
    """better / worse / neutral for a significant 8-week trend (p < 0.05); flat otherwise."""
    if sl is None or p is None:
        return None
    if p >= 0.05 or abs(sl) * (TREND_WEEKS - 1) < FLAT:
        return 'flat'      # not a trend, or one too small to matter (under 5% over the 8 weeks)
    lower = M[key][6]
    return 'neutral' if lower is None else 'better' if (sl < 0) == lower else 'worse'


def _ago(days):
    return (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')


# ---------- trends ----------

TREND_WEEKS = 8


def trends(rows, weeks=TREND_WEEKS):
    """Per metric: weekly values (oldest first), the last 7 days vs the 28 before, and a direction.
    `rows`: sessions(...) covering at least the last `weeks` weeks."""
    today = datetime.now().date()
    buckets = [[] for _ in range(weeks)]
    for r in rows:
        age = (today - datetime.strptime(r['day'], '%Y-%m-%d').date()).days
        if 0 <= age < weeks * 7:
            buckets[weeks - 1 - age // 7].append(r)
    cur_from, base_from = _ago(6), _ago(34)
    cur = [r for r in rows if r['day'] >= cur_from]
    base = [r for r in rows if base_from <= r['day'] < cur_from]
    out = []
    for key, label, goal, num, den, scale, lower, unit in METRICS:
        a, b, diff, lo, hi = compare(cur, base, key)
        # A week with a handful of sessions (the edge of the data) is noise, not a trend point.
        weekly = [value(bk, key) if len(bk) >= MIN_AFTER else None for bk in buckets]
        sl, p = slope(weekly)
        out.append(dict(metric=key, label=label, goal=goal, unit=unit, lowerIsBetter=lower,
                        weekly=weekly, weeks=[(today - timedelta(days=7 * (weeks - 1 - i))).strftime('%m-%d') for i in range(weeks)],
                        current=a, baseline=b, diff=diff, lo=lo, hi=hi, direction=sense(key, diff, lo, hi),
                        # The 8-week trend: Theil–Sen slope per week and whether it is a real trend (p < 0.05).
                        slope=sl, slope_p=p, trend=_trend(key, sl, p),
                        # The smallest change a 28-day before/after could tell from noise in this person's data.
                        mde=(lambda se: Z_POWER * se * math.sqrt(2) if se is not None else None)(rel_se(base, key)),
                        sessions=[len(cur), len(base)]))
    return out


# ---------- detectors ----------

def detectors(con, rows, since, profiles=None):
    """Deterministic findings over the period's sessions: each with the metric it moves and its evidence."""
    out = []
    if not rows:
        return out
    total = sum(r['cost'] for r in rows)
    pw, pp = _in('profile', profiles)

    def f(metric, sev, title, detail, **ev):
        out.append(dict(detector=title.split(':')[0], metric=metric, goal=M[metric][2], severity=sev, title=title, detail=detail, evidence=ev))

    big = con.execute(f'''SELECT TOTAL(cost_usd), COUNT(*) FROM requests WHERE day >= ?{pw} AND input + cache_read + cache_write >= 150000''', [since] + pp).fetchone()
    if total and big[0] / total > 0.15:
        f('avg_context', 'high', 'Large contexts', f'{100 * big[0] / total:.0f}% of spend (${big[0]:.2f}) is requests that re-read 150k+ tokens of context. '
          'Clearing between tasks, compacting earlier and handing broad exploration to subagents keep the main loop small.',
          share=big[0] / total, usd=big[0], requests=big[1])
    hit = value(rows, 'cache_hit')
    if hit is not None and hit < 85:
        f('cache_hit', 'high' if hit < 70 else 'medium', 'Low cache hit rate', f'Only {hit:.0f}% of context tokens were cache reads. Breaks in the prefix '
          '(edited CLAUDE.md, toggled MCP servers or tools mid-session, model switches, idle gaps past the cache TTL) make every request pay full price.', hit_pct=hit)
    wr = value(rows, 'whole_file_reads')
    if wr is not None and wr > 50:
        chars = con.execute(f"SELECT TOTAL(result_chars), COUNT(*) FROM tool_uses WHERE tool = 'Read' AND detail IS NULL AND day >= ?{pw}", [since] + pp).fetchone()
        f('whole_file_reads', 'medium', 'Whole-file reads', f'{wr:.0f}% of Reads took the whole file ({int(chars[0]):,} chars in {chars[1]:,} reads). '
          'Locating with grep/LSP first and reading a range returns far less.', pct=wr, chars=chars[0])
    tools = con.execute(f'''SELECT COALESCE(cmd, tool), COUNT(*), TOTAL(result_chars) FROM tool_uses WHERE day >= ?{pw}
        GROUP BY 1 ORDER BY 3 DESC LIMIT 5''', [since] + pp).fetchall()
    all_chars = sum(r['tool_chars'] for r in rows)
    if tools and all_chars and tools[0][2] / all_chars > 0.25:
        f('tool_output_per_prompt', 'medium', f'Heavy tool output: {tools[0][0]}', f'`{tools[0][0]}` returned {100 * tools[0][2] / all_chars:.0f}% of all tool output. '
          'Every char of it is re-read by each later request in the session until a compaction.', top=[list(t) for t in tools])
    err = con.execute(f'''SELECT tool, COUNT(*), TOTAL(is_error) e FROM tool_uses WHERE day >= ?{pw} GROUP BY 1 HAVING COUNT(*) >= 20
        ORDER BY 1.0 * e / COUNT(*) DESC LIMIT 3''', [since] + pp).fetchall()
    if err and err[0][2] / err[0][1] > 0.15:
        f('tool_error_rate', 'medium', f'Failing tool: {err[0][0]}', f'{err[0][0]} failed in {100 * err[0][2] / err[0][1]:.0f}% of {err[0][1]} calls; each failure is a wasted round trip.',
          tools=[[t, n, int(e)] for t, n, e in err])
    rpp = value(rows, 'requests_per_prompt')
    single = con.execute(f'''SELECT SUM(n = 1), COUNT(*) FROM (SELECT msg_id, COUNT(*) n FROM tool_uses WHERE day >= ?{pw} GROUP BY msg_id)''', [since] + pp).fetchone()
    if single[1] and single[0] / single[1] > 0.6 and rpp and rpp > 8:
        f('requests_per_prompt', 'medium', 'Serial tool calls', f'{100 * single[0] / single[1]:.0f}% of tool-using requests made one call, and a prompt takes {rpp:.1f} requests. '
          'Independent reads and searches batched into one request save whole round trips.', single_pct=single[0] / single[1], requests_per_prompt=rpp)
    prem = value(rows, 'premium_share')
    sub = con.execute(f'''SELECT TOTAL(cost_usd) FROM requests WHERE day >= ?{pw} AND agent_id IS NOT NULL AND (model LIKE '%opus%' OR model LIKE '%fable%')''', [since] + pp).fetchone()[0]
    if total and sub / total > 0.1:
        f('premium_share', 'medium', 'Premium models in subagents', f'${sub:.2f} ({100 * sub / total:.0f}% of spend) went to Opus/Fable inside subagents. '
          'Search and summarizing subagents usually do as well on Sonnet or Haiku.', usd=sub, share=sub / total)
    elif prem is not None and prem > 90:
        f('premium_share', 'low', 'Almost everything on premium models', f'{prem:.0f}% of spend is Opus/Fable. Routine edits and lookups may not need it.', pct=prem)
    ne = value(rows, 'non_english_prompts')
    if ne is not None and ne > 20:
        f('non_english_prompts', 'low', 'Prompts not in English', f'{ne:.0f}% of prompts are not in English. Non-English text, especially with accents or non-Latin '
          'script, splits into more tokens per word, and replies in the same language do too. The prompts are a small part of the context, '
          'so the replies (output tokens, the dearest kind) matter more than the prompts.', pct=ne)
    comp = value(rows, 'compactions')
    if comp is not None and comp > 5:
        f('compactions', 'medium', 'Frequent compaction', f'{comp:.1f} compactions per 100 prompts. Each one is an extra summarizing request and loses detail; '
          'smaller sessions per task avoid them.', per_100=comp)
    api = value(rows, 'api_errors')
    if api is not None and api > 1:
        f('api_errors', 'medium', 'API errors', f'{api:.1f} API errors per 100 requests (overload, rate limits, timeouts). Check the Health tab for the kinds.', per_100=api)
    schemas = con.execute(f'''SELECT COUNT(*), TOTAL(chars) FROM (SELECT json_extract(data, '$.tool') t, MAX(json_extract(data, '$.chars')) chars FROM events
        WHERE ev = 'tool_schema' AND day >= ?{pw} AND json_extract(data, '$.deferred') = 0 AND t LIKE 'mcp__%' GROUP BY 1)''', [since] + pp).fetchone()
    if schemas[0] and schemas[1] > 20000:
        f('tokens_per_prompt', 'medium', 'Always-loaded MCP tools', f'{schemas[0]} MCP tool schemas ({int(schemas[1]):,} chars) ride along in every request. '
          'Disabling unused servers per project or keeping them deferred cuts the fixed cost of every call.', tools=schemas[0], chars=schemas[1])
    return out


# ---------- settings changes ----------

def changes(con, days=60, profiles=None):
    """When a profile's setup changed (model, effort, output style, plugins, Claude Code minor version), from session starts."""
    pw, pp = _in('profile', profiles)
    last, out = {}, []
    for ts, day, prof, data in con.execute(f"SELECT ts, day, profile, data FROM events WHERE ev = 'session_start' AND day >= ?{pw} ORDER BY ts", [_ago(days)] + pp):
        d = json.loads(data or '{}')
        s = d.get('settings') or {}
        v = d.get('version')
        ver = '.'.join(str((v.get('version') if isinstance(v, dict) else v) or '').split('.')[:2]) or None
        cur = {'model': s.get('model'), 'effort': s.get('effortLevel'), 'output style': s.get('outputStyle'),
               'plugins': ','.join(sorted(s.get('plugins') or [])), 'version': ver, 'subagent model': (d.get('env') or {}).get('subagentModel')}
        prev = last.get(prof)
        if prev:
            for k, v in cur.items():
                if v != prev.get(k):
                    if k == 'plugins':
                        a, b = set(filter(None, (prev.get(k) or '').split(','))), set(filter(None, (v or '').split(',')))
                        what = ' '.join([f'+{x}' for x in sorted(b - a)] + [f'-{x}' for x in sorted(a - b)])
                    else:
                        what = f'{prev.get(k) or "default"} → {v or "default"}'
                    out.append({'ts': datetime.fromtimestamp(ts / 1000).isoformat(timespec='seconds') if isinstance(ts, (int, float)) else ts,
                                'day': day, 'profile': prof, 'what': k, 'change': what})
        last[prof] = cur
    return out[::-1]


# ---------- verification ----------

def _json(v, default=None):
    try:
        return json.loads(v) if isinstance(v, str) and v else (v if v is not None else default)
    except ValueError:
        return default


def _scope(rec):
    s = _json(rec['scope'])
    return s if isinstance(s, dict) and (s.get('projects') or s.get('profiles')) else None


def in_scope(r, scope):
    if scope.get('profiles') and r['profile'] not in scope['profiles']:
        return False
    ps = scope.get('projects')
    return not ps or any(r['project'] == p or r['project'].startswith(p.rstrip('/') + '/') for p in ps)


def _arms(con, rid):
    """The A/B arm of every session the mod assigned for this recommendation: sid -> (arm, share)."""
    return {sid: (arm, share) for sid, arm, share in con.execute(
        "SELECT sid, json_extract(data, '$.arm'), json_extract(data, '$.share') FROM events "
        "WHERE ev = 'advisor_arm' AND json_extract(data, '$.rec') = ?", (rid,))}


def confounders(con, a, rec, start, scope):
    """What else changed within CONFOUND_DAYS of the start: setup changes and other recommendations."""
    lo = (start - timedelta(days=CONFOUND_DAYS)).strftime('%Y-%m-%d')
    hi = (start + timedelta(days=CONFOUND_DAYS)).strftime('%Y-%m-%d')
    days = (datetime.now() - start).days + CONFOUND_DAYS + 30
    out = [dict(kind='setting', day=c['day'], what=f"{c['profile']}: {c['what']} {c['change']}")
           for c in changes(con, days, (scope or {}).get('profiles')) if lo <= c['day'] <= hi]
    for r in a.execute("SELECT id, title, COALESCE(trial_at, applied_at) at FROM recs WHERE id != ? AND status IN ('trial', 'applied', 'reverted') "
                       "AND COALESCE(trial_at, applied_at) BETWEEN ? AND ?", (rec['id'], lo, hi + 'T99')):
        out.append(dict(kind='recommendation', day=day_of(r['at']), what=f"{r['id']} {r['title']}"))
    return out


def verify(con, a, rec, force=False):
    """Measures an applied (or trialled) recommendation with the strongest design the data allows."""
    key = rec['metric']
    started = rec['trial_at'] or rec['applied_at']
    if not started or key not in M:
        return None
    d0 = datetime.strptime(day_of(started), '%Y-%m-%d')
    D = lambda k: (d0 + timedelta(days=k)).strftime('%Y-%m-%d')
    W = WINDOW_DAYS
    arms = _arms(con, rec['id']) if rec['instruction'] else {}
    # Same data, same method, same answer: skip the work when nothing it reads has changed.
    n_req, last_ts = con.execute('SELECT COUNT(*), MAX(ts) FROM requests WHERE day >= ?', (D(-2 * W),)).fetchone()
    version = f'{METHOD}:{n_req}:{last_ts}:{len(arms)}:{rec["scope"] or ""}:{rec["expected_effect"]}'
    old = _json(rec['verdict_detail'])
    if not force and old and (old.get('repro') or {}).get('data_version') == version:
        return dict(old, cached=True)

    rows = sessions(con, D(-2 * W))
    scope, seed, exp = _scope(rec), _seed(rec['id'], key), rec['expected_effect']
    proj = lambda r: r['project']
    res = dict(metric=key, expected=exp, scope=scope, side_effects=[], confounders=[], segments=[], placebo=None, control=None, notes=[])
    pre = [r for r in rows if D(-2 * W) <= r['day'] < D(-W)]
    before = [r for r in rows if D(-W) <= r['day'] < D(0)]
    after = [r for r in rows if D(1) <= r['day'] < D(W)]
    if rec['instruction']:
        # An instruction is always measured by its A/B arms: only part of the sessions get it, so a before/after
        # would dilute it. Until arms are logged (the trial starts at the next new session) it is collecting.
        # 1. Randomized: sessions with the instruction vs without, in the same weeks. Strata: project and the
        # share in force (a trial at 50% and the 10% holdout after adopting are pooled within, never across).
        strata = lambda r: f"{r['project']}|{arms[r['sid']][1]}"
        trial = [r for r in rows if r['sid'] in arms and r['day'] >= D(0)]
        A = [r for r in trial if arms[r['sid']][0] == 'on']
        B = [r for r in trial if arms[r['sid']][0] != 'on']
        # Power from the holdout once it has enough sessions, else from the in-scope weeks before the trial.
        base = B if len(B) >= MIN_AFTER else [r for r in before if not scope or in_scope(r, scope)]
        method, windows = 'randomized', {'from': D(0)}
        design = lambda k, n, sd: estimate(_rel, [_groups(A, k, strata), _groups(B, k, strata)], sd, n)
    else:
        inside = (lambda xs: [r for r in xs if in_scope(r, scope)]) if scope else (lambda xs: xs)
        Ac = [r for r in after if not in_scope(r, scope)] if scope else []
        Bc = [r for r in before if not in_scope(r, scope)] if scope else []
        pre, before, after = inside(pre), inside(before), inside(after)
        A, B, base = after, before, before
        windows = {'pre': [D(-2 * W), D(-W)], 'before': [D(-W), D(0)], 'after': [D(1), D(W)]}
        if scope and min(len(Ac), len(Bc)) >= MIN_AFTER:
            # 2. Control group: the scoped sessions' change net of the other sessions' change (diff in diff).
            did = lambda at, bt, ac, bc: _ratio2(_rel(at, bt), _rel(ac, bc))
            method = 'control_group'
            design = lambda k, n, sd: estimate(did, [_groups(x, k, proj) for x in (A, B, Ac, Bc)], sd, n)
            ca, cb, cd, clo, chi = compare(Ac, Bc, key, seed + 2, B_SIDE, proj)
            res['control'] = dict(before=cb, after=ca, diff=cd, lo=clo, hi=chi, n_before=len(Bc), n_after=len(Ac))
        else:
            # 3. Before/after, standardized to the before period's mix of projects.
            method = 'before_after'
            design = lambda k, n, sd: estimate(_rel, [_groups(A, k, proj), _groups(B, k, proj)], sd, n)
            cov = _coverage(_groups(A, key, proj), _groups(B, key, proj))
            if B and cov < 0.5:
                res['notes'].append(f'only {100 * cov:.0f}% of the work before continued after (other projects); the comparison covers that part')
    diff, lo, hi = design(key, B_VERIFY, seed)
    if method == 'before_after' and len(pre) >= MIN_AFTER and len(B) >= MIN_AFTER:
        # Placebo: the same comparison one window earlier, when nothing was applied. A clear "effect" there is
        # drift already under way; the estimate is then taken net of it.
        gp, gb, ga = (_groups(x, key, proj) for x in (pre, B, A))
        p, plo, phi = estimate(_rel, [gb, gp], seed + 1, B_SIDE)
        sig = plo is not None and not (plo <= 0 <= phi)
        res['placebo'] = dict(diff=p, lo=plo, hi=phi, significant=sig, n=len(pre))
        if sig:
            res['unadjusted'] = dict(diff=diff, lo=lo, hi=hi)
            method = 'trend_adjusted'
            diff, lo, hi = estimate(lambda x, y, z: _ratio2(_rel(x, y), _rel(y, z)), [ga, gb, gp], seed, B_VERIFY)
    res.update(method=method, before=value(B, key), after=value(A, key), diff=diff, lo=lo, hi=hi, n_before=len(B), n_after=len(A))
    pace = len([r for r in rows if r['day'] >= _ago(27) and (not scope or in_scope(r, scope))]) / 28
    pw = power(base, key, exp if exp else 0.1, pace)
    res['power'] = pw
    if method != 'randomized':
        res['confounders'] = confounders(con, a, rec, d0, scope)
    res['repro'] = dict(version=METHOD, seed=seed, resamples=B_VERIFY, windows=windows, data_version=version,
                        sessions=hashlib.sha1(','.join(sorted(r['sid'] for r in A + B)).encode()).hexdigest()[:12])
    need = (pw or {}).get('trial' if method == 'randomized' else 'after')
    have = len(A) + len(B) if method == 'randomized' else len(A)
    if len(A) < MIN_AFTER or len(B) < MIN_AFTER or diff is None:
        res['verdict'] = 'collecting'
        res['why'] = (f'{len(A)} sessions with it, {len(B)} without' if method == 'randomized' else f'{len(A)} sessions after, {len(B)} before') + \
            (f'; about {need} needed for a clear answer on a {100 * abs(pw["effect"]):.0f}% change' if need else '')
        res['grade'] = grade_of(rec, res)
        return res
    for g in GUARDS:
        if g == key:
            continue
        gd, glo, ghi = design(g, B_SIDE, _seed(rec['id'], g))
        va, vb = value(A, g), value(B, g)
        if sense(g, gd, glo, ghi) == 'worse' and abs(gd) >= 0.1 and va is not None and vb is not None and abs(va - vb) >= GUARD_FLOOR[g]:
            res['side_effects'].append(dict(metric=g, label=M[g][1], before=vb, after=va, diff=gd, lo=glo, hi=ghi))
    # Per project: what helps in one kind of work can hurt in another.
    counts = {}
    for r in A:
        counts[r['project']] = counts.get(r['project'], 0) + 1
    for pj, _ in sorted(counts.items(), key=lambda kv: -kv[1]):
        sa, sb = [r for r in A if r['project'] == pj], [r for r in B if r['project'] == pj]
        if min(len(sa), len(sb)) < MIN_AFTER:
            continue
        va, vb, d, l, h = compare(sa, sb, key, _seed(rec['id'], pj), B_SIDE)
        res['segments'].append(dict(segment=pj or '(no project)', before=vb, after=va, diff=d, lo=l, hi=h, n_before=len(sb), n_after=len(sa), sense=sense(key, d, l, h)))
        if len(res['segments']) == 5:
            break
    if {'better', 'worse'} <= {x['sense'] for x in res['segments']}:
        res['notes'].append('it helped in some projects and hurt in others: see the per-project effects')
    s = sense(key, diff, lo, hi)
    if s == 'better':
        res['verdict'] = 'tradeoff' if res['side_effects'] else 'improved'
    elif s == 'worse':
        res['verdict'] = 'regressed'
    elif s == 'neutral':
        res['verdict'] = 'tradeoff' if res['side_effects'] else 'changed'
    else:
        # Flat. Settled as "no effect" once the interval rules out half the promised effect, or once there is
        # as much data as the power calculation asked for.
        rules_out = bool(exp) and lo is not None and hi is not None and ((exp < 0 and lo > exp / 2) or (exp > 0 and hi < exp / 2))
        res['verdict'] = 'no_effect' if rules_out or have >= max(SETTLED_AFTER, need or 0) else 'collecting'
        if res['verdict'] == 'collecting':
            res['why'] = 'no clear change yet' + (f'; about {need - have} more sessions for a clear answer' if need and need > have else '')
    res['grade'] = grade_of(rec, res)
    return res


def grade_of(rec, res=None):
    """A: randomized on this data. B: a controlled measurement on this data (a control group, or before/after
    with a placebo check) without confounders. C: this data's numbers (re-run SQL) and a primary source. D: weaker."""
    if res and res.get('verdict') not in (None, 'collecting'):
        if res['method'] == 'randomized':
            return 'A'
        controlled = res['method'] in ('control_group', 'trend_adjusted') or res.get('placebo') is not None
        if controlled and not res.get('confounders'):
            return 'B'
    checked = _json(rec['checked'], [])
    sources = _json(rec['sources'], [])
    data = any(c.get('sql') and not c.get('error') and c.get('rows') for c in checked)
    primary = any(isinstance(x, dict) and x.get('kind') == 'primary' for x in sources)
    return 'C' if data and primary else 'D'


def verify_all(con, a, force=False):
    """Re-checks every trialled or applied recommendation; stores a check whenever a verdict changes.
    Always over all profiles: a recommendation's scope says where it applies, not the dashboard's filter."""
    changed = []
    for rec in a.execute("SELECT * FROM recs WHERE status IN ('trial', 'applied') AND COALESCE(trial_at, applied_at) IS NOT NULL").fetchall():
        res = verify(con, a, rec, force)
        if not res or res.get('cached'):
            continue
        a.execute('UPDATE recs SET verdict = ?, verdict_at = ?, verdict_detail = ?, grade = ? WHERE id = ?',
                  (res['verdict'], now_iso(), json.dumps(res), res['grade'], rec['id']))
        if res['verdict'] != rec['verdict']:
            a.execute('INSERT INTO checks (rec_id, ts, verdict, before, after, diff, lo, hi, n_before, n_after, side_effects, method, grade) '
                      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', (rec['id'], now_iso(), res['verdict'], res['before'], res['after'], res['diff'], res['lo'],
                                                             res['hi'], res['n_before'], res['n_after'], json.dumps(res['side_effects']), res['method'], res['grade']))
            changed.append((rec['id'], rec['title'], rec['verdict'], res))
    a.commit()
    return changed


# ---------- recommendations ----------

def recs(a, status=None):
    sql, p = 'SELECT * FROM recs', []
    if status:
        sql += f' WHERE status IN ({",".join("?" * len(status))})'; p = list(status)
    out = []
    for r in a.execute(sql + ' ORDER BY created DESC', p):
        d = dict(r)
        for k, empty in (('sources', []), ('checked', []), ('scope', None), ('impact', None), ('power', None), ('warnings', []), ('verdict_detail', None)):
            d[k] = _json(d[k], empty)
        ev = _json(d['evidence'], d['evidence'])
        d['evidence'] = ev
        out.append(d)
    return out


def _norm(t):
    return ' '.join(sorted(set(w for w in WORD.findall((t or '').lower()) if w not in EN_STOP)))


# PRAGMAs that only describe the schema; every other one (query_only, writable_schema, …) is refused.
SAFE_PRAGMAS = {'table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'database_list'}


def _guard(action, arg1, *_):
    # ATTACH would open any other SQLite file on disk (a browser's cookies, another app's data) through this connection.
    if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_PRAGMA and (arg1 or '').lower() not in SAFE_PRAGMAS:
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def readonly(path, timeout=30):
    """A connection for SQL that did not come from this code (the research agent, the dashboard's SQL tab): it
    cannot write, attach another database file or change pragmas."""
    ro = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=timeout)
    ro.execute('PRAGMA query_only = 1')
    ro.set_authorizer(_guard)
    return ro


def _ro(con):
    """A read-only connection to the usage database, for SQL that came from the research agent."""
    path = _path(con)
    return readonly(path) if path else con


def run_query(ro, sql, limit=20, seconds=15):
    """Runs one query (read-only, time-limited): {cols, rows} or {error}."""
    deadline = time.time() + seconds
    ro.set_progress_handler(lambda: time.time() > deadline, 20000)
    try:
        cur = ro.execute(sql)
        rows = cur.fetchmany(limit)
        return {'cols': [c[0] for c in cur.description or []], 'rows': [list(r) for r in rows]}
    except (sqlite3.Error, ValueError) as ex:
        return {'error': str(ex) if time.time() <= deadline else f'took over {seconds}s'}
    finally:
        ro.set_progress_handler(None, 0)


def source(x):
    """A source as {url, title, kind, published, checked}; kind 'primary' for Anthropic's own pages."""
    d = dict(x) if isinstance(x, dict) else {'url': str(x)}
    url = (d.get('url') or '').lower()
    host = re.sub(r'^https?://(www\.)?', '', url)
    if not d.get('kind'):
        d['kind'] = 'primary' if any(host == h or host.startswith(h + '/') or host.split('/')[0].endswith('.' + h) or host.split('/')[0] == h for h in PRIMARY) else 'secondary'
    return {k: d.get(k) for k in ('url', 'title', 'kind', 'published', 'checked', 'quote') if d.get(k)}


def _num(v, lo=-0.95, hi=5.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return max(lo, min(hi, x)) if math.isfinite(x) else None


def appraise(con, rec, rows, pace):
    """What a recommendation is worth for this person, and how long its verdict will take.
    rows: the last 28 days of sessions (all profiles)."""
    key, scope, exp = rec['metric'], rec['scope'], rec['expected_effect']
    mine = [r for r in rows if in_scope(r, scope)] if scope else rows
    exposure = rec.get('exposure')
    if exposure is None and scope:
        total = sum(r['cost'] for r in rows)
        exposure = sum(r['cost'] for r in mine) / total if total else None
    impact = {}
    if exp is not None and exposure is not None:
        impact['metric_change'] = exposure * exp
        if key == 'cost_per_prompt':
            impact['usd_month'] = -exposure * exp * sum(r['cost'] for r in rows) * 30 / 28
    my_pace = len(mine) / 28 if rows else pace
    return exposure, impact or None, power(mine, key, exp if exp else 0.1, my_pace)


def record(con, a, payload, trigger='manual', model=None, run_id=None):
    """Stores a research run's output: {summary, recommendations: [...], notes: [...]}.
    Every evidence query is re-run here (read-only); its rows, not the model's numbers, are what is kept.
    Returns (run id, added, skipped, warnings per added id)."""
    run_id = run_id or uuid.uuid4().hex[:8]
    existing = {_norm(r['title']): r['id'] for r in a.execute("SELECT id, title FROM recs WHERE status IN ('proposed', 'accepted', 'trial', 'applied')")}
    ro = _ro(con)
    rows = sessions(con, _ago(27))
    added, skipped, warnings = [], [], {}
    for r in payload.get('recommendations') or []:
        title = (r.get('title') or '').strip()
        metric = r.get('metric') if r.get('metric') in M else 'cost_per_prompt'
        if not title:
            continue
        if _norm(title) in existing:
            skipped.append(title)
            continue
        rid = uuid.uuid4().hex[:6]
        goal = r.get('goal') if r.get('goal') in GOALS else M[metric][2]
        warn = []
        ev = r.get('evidence')
        items = ev if isinstance(ev, list) else ([{'claim': ev}] if ev else [])
        checked = []
        for it in items[:8]:
            it = it if isinstance(it, dict) else {'claim': str(it)}
            c = {'claim': it.get('claim'), 'sql': it.get('sql')}
            if c['sql']:
                c.update(run_query(ro, c['sql']), ran_at=now_iso())
                if c.get('error'):
                    warn.append(f"evidence query failed: {c['error']}")
            checked.append(c)
        if not any(c.get('sql') and not c.get('error') for c in checked):
            warn.append('no evidence query from this data: its numbers are not checked')
        sources = [source(x) for x in (r.get('sources') or [])]
        if not any(x['kind'] == 'primary' for x in sources):
            warn.append('no primary source')
        exp = _num(r.get('expected_effect'))
        if exp is None:
            warn.append('no numeric expected_effect: "no effect" can only be called after many sessions')
        scope = r.get('scope') if isinstance(r.get('scope'), dict) and (r['scope'].get('projects') or r['scope'].get('profiles')) else None
        exposure = None
        if r.get('exposure_sql'):
            q = run_query(ro, r['exposure_sql'], 1)
            exposure = _num(q['rows'][0][0] if q.get('rows') and q['rows'][0] else None, 0, 1)
            if exposure is None:
                warn.append(f"exposure query gave no share: {q.get('error') or q.get('rows')}")
        rec = {'metric': metric, 'scope': scope, 'expected_effect': exp, 'exposure': exposure}
        exposure, impact, pw = appraise(con, rec, rows, len(rows) / 28)
        if pw and pw['after'] is None and pw['trial'] > 4 * max(1, len(rows)):
            warn.append(f"a {100 * abs(pw['effect']):.0f}% change in {M[metric][1]} is too small to tell from noise in your data")
        instruction = (r.get('instruction') or '').strip()[:1500] or None
        row = {'checked': json.dumps(checked), 'sources': json.dumps(sources)}
        a.execute('''INSERT INTO recs (id, run_id, created, title, goal, metric, expected, rationale, evidence, action, apply_kind, effort, risk,
            sources, supersedes, status, status_at, hypothesis, expected_effect, scope, instruction, counter, checked, exposure, impact, power, grade, warnings)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                  (rid, run_id, now_iso(), title, goal, metric, r.get('expected'), r.get('rationale'), json.dumps(ev) if ev is not None else None,
                   r.get('action'), r.get('apply_kind') or r.get('applyKind') or ('instruction' if instruction else 'other'), r.get('effort'), r.get('risk'),
                   row['sources'], r.get('supersedes'), 'proposed', now_iso(), r.get('hypothesis'), exp, json.dumps(scope) if scope else None,
                   instruction, r.get('counter_evidence') or r.get('counter'), row['checked'], exposure, json.dumps(impact) if impact else None,
                   json.dumps(pw) if pw else None, grade_of(row), json.dumps(warn)))
        added.append(rid)
        if warn:
            warnings[rid] = warn
    if ro is not con:
        ro.close()
    for n in payload.get('notes') or []:
        if n.get('finding'):
            a.execute('INSERT INTO notes (run_id, ts, topic, finding, source, published, checked, kind) VALUES (?,?,?,?,?,?,?,?)',
                      (run_id, now_iso(), n.get('topic'), n['finding'], n.get('source'), n.get('published'), n.get('checked') or day_of(now_iso()),
                       source({'url': n['source']})['kind'] if n.get('source') else None))
    if a.execute('SELECT 1 FROM runs WHERE id = ?', (run_id,)).fetchone():
        a.execute("UPDATE runs SET finished = ?, summary = ?, recs = ?, status = 'done', model = COALESCE(?, model) WHERE id = ?",
                  (now_iso(), payload.get('summary'), len(added), model, run_id))
    else:
        a.execute("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?)", (run_id, now_iso(), now_iso(), 'research', trigger, model, payload.get('summary'), len(added), 'done'))
    a.commit()
    return run_id, added, skipped, warnings


def write_trials(a):
    """advisor-trials.json: the instructions the mod adds to sessions, each with the share of sessions that get it."""
    path = _path(a)
    if not path:
        return
    # scope: only sessions in these projects (~-relative, worktrees folded) or profiles are assigned an arm.
    items = [{'id': r['id'], 'instruction': r['instruction'], 'share': TRIAL_SHARE if r['status'] == 'trial' else 1 - HOLDOUT, 'scope': _scope(r)}
             for r in a.execute("SELECT id, instruction, status, scope FROM recs WHERE instruction IS NOT NULL AND instruction != '' AND status IN ('trial', 'applied')")]
    out = os.path.join(os.path.dirname(path), 'advisor-trials.json')
    with open(out + '.tmp', 'w') as f:
        json.dump({'trials': items}, f, indent=1)
    os.replace(out + '.tmp', out)


def set_status(con, a, rid, status, note=None, at=None):
    rec = a.execute('SELECT * FROM recs WHERE id = ?', (rid,)).fetchone()
    if not rec:
        raise ValueError(f'no recommendation {rid}')
    if status not in STATUSES:
        raise ValueError(f'status must be one of {", ".join(STATUSES)}')
    if status == 'trial' and not rec['instruction']:
        raise ValueError(f'{rid} is not an instruction to the model, so it cannot run as an A/B trial; apply it and it is measured before/after')
    ts = at or now_iso()
    applied_at, baseline, trial_at = rec['applied_at'], rec['baseline'], rec['trial_at']
    if status == 'trial' and not trial_at:
        trial_at = ts
    if status == 'applied':
        applied_at = ts
        baseline = value(sessions(con, (datetime.strptime(day_of(ts), '%Y-%m-%d') - timedelta(days=WINDOW_DAYS)).strftime('%Y-%m-%d'), day_of(ts)), rec['metric']) if rec['metric'] in M else None
    a.execute('UPDATE recs SET status = ?, status_at = ?, applied_at = ?, baseline = ?, trial_at = ?, note = COALESCE(?, note) WHERE id = ?',
              (status, now_iso(), applied_at, baseline, trial_at, note, rid))
    a.commit()
    write_trials(a)
    if status in ('applied', 'trial'):
        verify_all(con, a)
    return dict(a.execute('SELECT * FROM recs WHERE id = ?', (rid,)).fetchone())


def reproduce(con, a, rid):
    """Re-runs a recommendation's evidence queries and its verification from scratch, next to what was stored.
    Same sessions → the same numbers (seeded); new data → shows what moved."""
    rec = a.execute('SELECT * FROM recs WHERE id = ?', (rid,)).fetchone()
    if not rec:
        raise ValueError(f'no recommendation {rid}')
    ro = _ro(con)
    evidence = []
    for c in _json(rec['checked'], []):
        if not c.get('sql'):
            continue
        now = run_query(ro, c['sql'])
        evidence.append({'claim': c.get('claim'), 'sql': c['sql'], 'ran_at': c.get('ran_at'), 'then': c.get('rows'), 'now': now.get('rows'),
                         'error': now.get('error'), 'same': now.get('rows') == c.get('rows')})
    if ro is not con:
        ro.close()
    out = {'id': rid, 'title': rec['title'], 'evidence': evidence}
    old = _json(rec['verdict_detail'])
    fresh = verify(con, a, rec, force=True)
    if fresh:
        pick = lambda d: {k: d.get(k) for k in ('verdict', 'method', 'diff', 'lo', 'hi', 'n_before', 'n_after', 'grade')} if d else None
        same_sessions = bool(old) and (old.get('repro') or {}).get('sessions') == fresh['repro']['sessions']
        out['verification'] = {'stored': pick(old), 'now': pick(fresh), 'repro': fresh['repro'], 'sameSessions': same_sessions,
                               'identical': same_sessions and pick(old) == pick(fresh)}
    return out


def learning(a):
    """How the advice has fared so far, per goal and per kind of change: the advisor's own track record.
    successRate: (helped + 1) / (measured + 2), a Laplace estimate that does not jump to 0% or 100% on one case."""
    out = {}
    for r in a.execute("SELECT goal, apply_kind, status, verdict, grade FROM recs"):
        for key in (f'goal:{r["goal"]}', f'kind:{r["apply_kind"]}'):
            d = out.setdefault(key, {'proposed': 0, 'applied': 0, 'dismissed': 0, 'improved': 0, 'regressed': 0, 'no_effect': 0, 'tradeoff': 0, 'randomized': 0})
            d['proposed'] += 1
            if r['status'] in ('trial', 'applied', 'reverted'):
                d['applied'] += 1
            if r['status'] == 'dismissed':
                d['dismissed'] += 1
            if r['verdict'] in d:
                d[r['verdict']] += 1
            if r['grade'] == 'A':
                d['randomized'] += 1
    for d in out.values():
        measured = d['improved'] + d['regressed'] + d['no_effect'] + d['tradeoff']
        d['successRate'] = round((d['improved'] + 0.5 * d['tradeoff'] + 1) / (measured + 2), 2)
        d['measured'] = measured
    return out


# ---------- scheduling ----------

def due(a, every_days, claim=False, trigger='schedule', model=None, data_dir='.'):
    """Whether a research run is due (none finished within `every_days`, none started in the last 2 hours).
    With `claim`, atomically starts one and returns its id, so concurrent sessions start only one."""
    with open(os.path.join(data_dir, 'advisor.lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        last_done = a.execute("SELECT MAX(finished) FROM runs WHERE kind = 'research' AND status = 'done'").fetchone()[0]
        running = a.execute("SELECT id FROM runs WHERE kind = 'research' AND status = 'running' AND started >= ?",
                            ((datetime.now() - timedelta(hours=2)).isoformat(timespec='seconds'),)).fetchone()
        is_due = not running and (not last_done or last_done < (datetime.now() - timedelta(days=every_days)).isoformat(timespec='seconds'))
        if not (claim and is_due):
            return {'due': is_due, 'lastRun': last_done, 'running': running[0] if running else None}
        rid = uuid.uuid4().hex[:8]
        a.execute("INSERT INTO runs (id, started, kind, trigger_, model, status) VALUES (?,?,?,?,?,?)", (rid, now_iso(), 'research', trigger, model, 'running'))
        a.commit()
        return {'due': True, 'runId': rid, 'lastRun': last_done}


def notify(con, a):
    """Verdicts that changed since they were last announced (after re-verifying), marked as announced."""
    verify_all(con, a)
    out = []
    for r in a.execute("SELECT id, title, status, verdict, grade, verdict_detail FROM recs WHERE verdict IS NOT NULL AND verdict != 'collecting' AND verdict IS NOT notified_verdict"):
        d = json.loads(r['verdict_detail'] or '{}')
        out.append({'id': r['id'], 'title': r['title'], 'status': r['status'], 'verdict': r['verdict'], 'grade': r['grade'], 'method': d.get('method'),
                    'diff': d.get('diff'), 'metric': d.get('metric'), 'sideEffects': [s['label'] for s in d.get('side_effects') or []]})
        a.execute('UPDATE recs SET notified_verdict = verdict WHERE id = ?', (r['id'],))
    a.commit()
    return out


# ---------- the brief the research agent reads ----------

def _setup(con):
    out = {}
    for prof, data in con.execute('''SELECT profile, data FROM events WHERE ev = 'session_start' AND ts IN
            (SELECT MAX(ts) FROM events WHERE ev = 'session_start' GROUP BY profile)'''):
        d = json.loads(data or '{}')
        v = d.get('version')
        out[prof] = {'version': v.get('version') if isinstance(v, dict) else v, 'model': d.get('model'), 'settings': d.get('settings'), 'env': d.get('env')}
    ctx = {}
    for prof, cat, tokens in con.execute('''SELECT profile, category, MAX(tokens) FROM v_context WHERE ts IN
            (SELECT MAX(ts) FROM v_context GROUP BY profile) GROUP BY 1, 2'''):
        ctx.setdefault(prof, {})[cat] = tokens
    for prof, c in ctx.items():
        out.setdefault(prof, {})['contextBreakdown'] = c
    return out


SEGMENT_METRICS = ('cost_per_prompt', 'tokens_per_prompt', 'avg_context', 'cache_hit', 'whole_file_reads', 'requests_per_prompt',
                   'tool_error_rate', 'non_english_prompts', 'premium_share')


def segments(rows, by, top=8):
    """This person's usage split by project (or profile, entrypoint): where their work differs, the right
    change can differ too."""
    g = {}
    for r in rows:
        g.setdefault(r[by] or '(none)', []).append(r)
    total = sum(r['cost'] for r in rows) or 1
    out = []
    for k, rs in sorted(g.items(), key=lambda kv: -sum(r['cost'] for r in kv[1]))[:top]:
        d = {by: k, 'sessions': len(rs), 'spendShare': round(sum(r['cost'] for r in rs) / total, 3)}
        for m in SEGMENT_METRICS:
            v = value(rs, m)
            d[m] = None if v is None else round(v, 4)
        out.append(d)
    return out


def _notes(a, limit):
    out = []
    for r in a.execute('SELECT ts, topic, finding, source, published, checked, kind FROM notes ORDER BY id DESC LIMIT ?', (limit,)):
        d = dict(r)
        d['stale'] = (d['checked'] or day_of(d['ts'])) < _ago(STALE_NOTE_DAYS)
        out.append(d)
    return out


def brief(con, a, profiles=None, days=30):
    since = _ago(days - 1)
    every = sessions(con, min(since, _ago(TREND_WEEKS * 7 - 1)), profiles=profiles)
    rows = [r for r in every if r['day'] >= since]
    verify_all(con, a)
    pw, pp = _in('profile', profiles)
    q = lambda sql, p=(): [list(r) for r in con.execute(sql, list(p))]
    prompts = []
    for ts, proj, text in con.execute(f"""SELECT ts, project, text FROM prompts WHERE kind = 'prompt' AND agent_id IS NULL AND day >= ?{pw}
            ORDER BY RANDOM() LIMIT 40""", [since] + pp):
        prompts.append({'ts': ts, 'project': proj, 'english': is_english(text), 'text': (text or '')[:400]})
    fmt = lambda v: None if v is None else round(v, 4)
    return {
        'generatedAt': now_iso(), 'periodDays': days, 'sessions': len(rows), 'prompts': sum(r['prompts'] for r in rows),
        'spendUsd': round(sum(r['cost'] for r in rows), 2),
        'metricCatalog': [{'key': k, 'label': l, 'goal': g, 'lowerIsBetter': lo, 'unit': u} for k, l, g, _, _, _, lo, u in METRICS],
        'metrics': [{k: (fmt(v) if isinstance(v, float) else v) for k, v in t.items()} for t in trends(every)],
        'detectors': detectors(con, rows, since, profiles),
        'setup': _setup(con),
        'settingChanges': changes(con, 60, profiles)[:40],
        'recommendations': [{k: r[k] for k in ('id', 'created', 'title', 'goal', 'metric', 'action', 'apply_kind', 'scope', 'expected_effect', 'instruction',
                                                'status', 'applied_at', 'trial_at', 'grade', 'verdict', 'verdict_detail', 'note')} for r in recs(a)][:60],
        'trackRecord': learning(a),
        'notes': _notes(a, 40),
        # Who this person is as a user: where the money goes and how each part of their work behaves.
        'pace': {'sessionsPerDay': round(len([r for r in rows if r['day'] >= _ago(27)]) / 28, 2)},
        'segments': {'byProject': segments(rows, 'project'), 'byProfile': segments(rows, 'profile', 5), 'byEntrypoint': segments(rows, 'entrypoint', 5)},
        'byModel': q(f'''SELECT model, COUNT(*) requests, ROUND(TOTAL(cost_usd), 2) cost, ROUND(AVG(output)) avg_output FROM requests
            WHERE day >= ?{pw} GROUP BY 1 ORDER BY 3 DESC LIMIT 10''', [since] + pp),
        'byAgentType': q(f'''SELECT agent_type, model, COUNT(*) requests, ROUND(TOTAL(cost_usd), 2) cost FROM v_requests
            WHERE day >= ?{pw} GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 12''', [since] + pp),
        'topTools': q(f'''SELECT COALESCE(cmd, tool) what, COUNT(*) calls, TOTAL(result_chars) result_chars, TOTAL(is_error) errors FROM tool_uses
            WHERE day >= ?{pw} GROUP BY 1 ORDER BY 3 DESC LIMIT 15''', [since] + pp),
        'topSessions': q(f'''SELECT s.session_id, s.title, s.project, ROUND(TOTAL(r.cost_usd), 2) cost, COUNT(*) requests,
            MAX(r.input + r.cache_read + r.cache_write) max_context FROM requests r LEFT JOIN sessions s USING (session_id)
            WHERE r.day >= ?{pw.replace("profile", "r.profile")} GROUP BY r.session_id ORDER BY 4 DESC LIMIT 10''', [since] + pp),
        'samplePrompts': prompts,
    }


# ---------- views ----------

def dashboard(con, a, profiles=None, days=30):
    since = _ago(days - 1)
    every = sessions(con, min(since, _ago(TREND_WEEKS * 7 - 1)), profiles=profiles)
    rows = [r for r in every if r['day'] >= since]
    verify_all(con, a)
    return {
        'metrics': trends(every),
        'segments': segments(rows, 'project'),
        'detectors': detectors(con, rows, since, profiles),
        'recs': recs(a),
        'changes': changes(con, 90, profiles)[:60],
        'runs': [dict(r) for r in a.execute('SELECT * FROM runs ORDER BY started DESC LIMIT 20')],
        'notes': _notes(a, 30),
        'trackRecord': learning(a),
    }


def fmt_value(key, v):
    if v is None:
        return '–'
    unit = M[key][7]
    return f'${v:.3f}' if unit == 'usd' else f'{v:.1f}%' if unit == 'pct' else f'{v:.1f}s' if unit == 'sec' else f'{v:,.0f}' if v >= 100 else f'{v:.2f}'


def fmt_text(d):
    sign = lambda x: '' if x is None else f'{100 * x:+.0f}%'
    arrow = {'better': '▲ better', 'worse': '▼ worse', 'flat': '· flat', 'neutral': '·', None: ''}
    out = ['Advisor: last 7 days vs the 28 before (changes only when the 95% interval excludes zero)', '']
    for g in GOALS:
        out.append(g.upper())
        for t in d['metrics']:
            if t['goal'] == g:
                tr = '' if not t.get('trend') or t['trend'] == 'flat' else f"   8 weeks: {sign(t['slope'])}/week ({t['trend']}, p={t['slope_p']:.2f})"
                out.append(f"  {t['label']:<32} {fmt_value(t['metric'], t['current']):>10}  {sign(t['diff']):>6}  {arrow[t['direction']]:<9}{tr}")
    if d['detectors']:
        out += ['', 'FINDINGS']
        out += [f"  [{x['severity']}] {x['title']}: {x['detail']}" for x in d['detectors']]
    live = [r for r in d['recs'] if r['status'] in ('proposed', 'accepted', 'trial', 'applied')]
    if live:
        out += ['', 'RECOMMENDATIONS  (grade: A randomized on your data · B controlled measurement · C your data + primary source · D weaker)']
        for r in live:
            v = r['verdict_detail'] or {}
            verdict = f" → {r['verdict']} ({sign(v.get('diff'))} {M.get(r['metric'], ('', ''))[1]}, {v.get('method', '').replace('_', ' ')})" if r['verdict'] else ''
            out.append(f"  {r['id']}  [{r.get('grade') or '-'}] {r['status']:<9} {r['title']}{verdict}")
    last = d['runs'][0] if d['runs'] else None
    out += ['', f"Last research run: {last['finished'] or last['started']} ({last['status']})" if last else 'No research run yet: /analytics advise runs one.']
    out.append('Mark one: /analytics advise trial|applied|dismiss|accept <id>  ·  check one: /analytics advise reproduce <id>  ·  /dashboard advisor')
    return '\n'.join(out)
