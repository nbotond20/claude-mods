"""Recurring asks: the prompts you keep typing, found without a model.

    prompts ──► normalize (paths, numbers, branches, quoted text out) ──► cluster paraphrases ──► rank
                                                                                                    │
         status: new / automated / dismissed  ◄── labels + a draft (a model, only when you start it) ◄┘

* Detection is deterministic and local. Each real prompt (kind 'prompt', main loop) is cut to the human text
  (code fences and pasted logs dropped, 400 chars kept), paths / URLs / ids / numbers / branch names / quoted
  strings are removed, words are lower-cased, stemmed lightly and stripped of stop words. What is left is a set
  of words. Prompts whose sets overlap by at least THRESHOLD (Jaccard) are one ask: identical
  normalized texts collapse first, then each text joins the best earlier cluster centre found through a
  prefix-filter index, so 50,000 prompts take a few seconds.
* A cluster is recurring when it has MIN_COUNT prompts on MIN_DAYS different days. Each gets its cost (every
  request until the next prompt, as in the Prompts tab), weekly counts and an "automatable" score.
* Labels (title, category, an automation and its ready-to-save draft) come from a model, only when the person
  starts `/analytics recurring classify`; they are stored in <data>/recurring.db next to a status per ask. An
  ask is found again after its wording drifts by matching its stored normalized text, so labels survive.
* For an ask marked automated, prompts per week before and after the date it was marked show whether it stopped.

Writes only <data>/recurring.db; reads usage.db.
"""
import hashlib, json, math, os, re, sqlite3, statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta

THRESHOLD = 0.55       # Jaccard overlap of the word sets for two prompts to be the same ask
MIN_COUNT = 3          # prompts in an ask
MIN_DAYS = 2           # on this many different days
POSTING_CAP = 400      # a shingle in more cluster centres than this does not pick candidates
CANDIDATES = 30        # centres compared per prompt, the ones sharing most rare shingles
HUMAN_CHARS = 400      # of a prompt that count (the rest is usually pasted)
MATCH = 0.6            # a stored ask is recognised again at this overlap of its normalized text
CATEGORIES = ('release/versioning', 'testing', 'review/PR', 'CI/debugging', 'docs', 'refactor', 'setup/env',
              'question/explain', 'data/reporting', 'other')
KINDS = ('slash_command', 'skill', 'hook', 'script', 'claude_md_rule', 'mod_setting', 'scheduled_task', 'none')
STATUSES = ('new', 'automated', 'dismissed')

DDL = '''
CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, norm TEXT, status TEXT DEFAULT 'new', status_at TEXT, note TEXT,
  title TEXT, category TEXT, auto_kind TEXT, draft TEXT, rationale TEXT, est_prompts_month REAL, est_usd_month REAL,
  labeled_at TEXT, model TEXT, run_id TEXT);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, ts TEXT, model TEXT, summary TEXT, labeled INTEGER);
'''

STOP = set('''a an the and or but if of to in on at for with from by as is are was were be been being am it its this that these those
i you we he she they me my your our us them his her their not no do does did done doing can could should would will shall may might
just so then than there here what which who whom how why when where while please also into onto about over under up down out off
have has had having let lets s t d ll re ve m dont doesnt didnt cant wont isnt arent wasnt couldnt shouldnt wouldnt im ive id youre
thats theres really very too some any all each every more most much many such own same other another again still now like need want
get got make made makes making use using used then first next after before once maybe actually basically ok okay yes yeah yep hey hi
hello thanks thank sure cool good great nice fine right well one two thing things stuff bit way
a az es hogy meg egy is nem de ez azt van volt lesz nekem neked kérlek légy'''.split())
_TRIVIAL = '''continue proceed retry go next done stop yes ok okay thanks thank sure yep nope lgtm approve approved agree
cancel again resume test please fine good great nice cool'''.split()

_FENCE = re.compile(r'```.*?(?:```|\Z)', re.S)
_TAGBLOCK = re.compile(r'<([a-z][\w-]*)>.*?</\1>', re.S)
_IMAGE = re.compile(r'\[(?:image|pasted)[^\]]*\]', re.I)
_URL = re.compile(r'(?:https?|ftp|file)://\S+|www\.\S+')
_QUOTED = re.compile(r'"[^"\n]{1,200}"|`[^`\n]{1,120}`|“[^”\n]{1,200}”|‘[^’\n]{1,120}’')
_EXTS = 'py ts tsx js jsx mjs cjs json md mdx yml yaml toml sh go rs java rb css scss html sql txt lock cfg ini tf swift kt kts php c h cpp hpp cs vue svelte env log csv xml gradle plist'
_PATH = re.compile(r'(?<![\w])(?:[~.]{0,2}/)?(?:[\w.@+-]+/)+[\w.@+-]*|\b[\w.-]+\.(?:' + _EXTS.replace(' ', '|') + r')\b', re.I)
_IDENT = re.compile(r'\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*|\w+_\w+|[A-Za-z]+(?:-[A-Za-z0-9]+){2,})\b')
_HEX = re.compile(r'\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b', re.I)
_NUM = re.compile(r'#?\b\d[\w.,:/-]*|#\d+')
_NOISE = re.compile(r'^\s*(?:at\s+\S|File\s+"|Traceback|\d{4}-\d\d-\d\d[T ]|\[\d\d:\d\d|\s*\^+\s*$|[\w.$]+(?:Error|Exception)\b)')
_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def human(text):
    """The part of a prompt a person typed: no fenced code, tags, image markers or pasted log lines; at most HUMAN_CHARS."""
    t = _FENCE.sub(' ', (text or '')[:3000])
    t = _TAGBLOCK.sub(' ', t)
    t = _IMAGE.sub(' ', t)
    lines = [ln for ln in t.splitlines() if ln.strip() and not _NOISE.match(ln)]
    return ' '.join(lines)[:HUMAN_CHARS]


def stem(w):
    if len(w) > 4 and w.endswith('ies'):
        w = w[:-3] + 'y'
    elif len(w) > 5 and w.endswith('ing'):
        w = w[:-3]
        if len(w) > 3 and w[-1] == w[-2] and w[-1] not in 'lsz':
            w = w[:-1]
    elif len(w) > 4 and w.endswith('ed'):
        w = w[:-2]
        if len(w) > 3 and w[-1] == w[-2] and w[-1] not in 'lsz':
            w = w[:-1]
    elif len(w) > 3 and w.endswith('s') and not w.endswith('ss'):
        w = w[:-1]
    if len(w) > 4 and w.endswith('e'):
        w = w[:-1]
    return w


TRIVIAL = {stem(w) for w in _TRIVIAL}


def tokens(text):
    """Stems of the words that carry the ask: paths, urls, ids, numbers, branches and quoted text removed."""
    t = human(text)
    t = _URL.sub(' ', t)
    t = _QUOTED.sub(' ', t)
    t = _PATH.sub(' ', t)
    t = _IDENT.sub(' ', t)
    t = _HEX.sub(' ', t)
    t = _NUM.sub(' ', t)
    t = t.lower().replace("'", '').replace('’', '')
    return [stem(w) for w in _WORD.findall(t) if w not in STOP and len(w) > 1]


def normalize(text, redact=None):
    """The normalized text of a prompt: its stems, in order (what the cluster id is hashed from)."""
    return ' '.join(tokens(redact(text) if redact else text))


def is_trivial(toks):
    return not toks or all(t in TRIVIAL for t in toks)


def shingles(toks):
    """The word set of an ask. Word order is ignored on purpose: paraphrases reorder, and a set still tells 'fix CI' from 'fix lint'."""
    return frozenset(toks)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    n = len(a & b)
    return n / (len(a) + len(b) - n)


def ask_id(norm):
    return hashlib.sha1(norm.encode()).hexdigest()[:8]


def cluster(keys, counts, threshold=THRESHOLD):
    """Greedy centre assignment. keys: unique token tuples; counts: how many prompts each stands for.
    Returns [[key index, ...], ...], the first index of each list being the cluster centre (the most frequent text)."""
    sets = [shingles(k) for k in keys]
    df = Counter(s for sh in sets for s in sh)
    lens = [len(x) for x in sets]
    order = sorted(range(len(keys)), key=lambda i: (-counts[i], keys[i]))
    index = defaultdict(list)       # shingle -> clusters whose centre has it in its prefix
    groups, centres = [], []
    for i in order:
        sh = sorted(sets[i], key=lambda s: (df[s], s))
        li = lens[i]
        prefix = sh[:max(1, len(sh) - math.ceil(threshold * len(sh)) + 1)]
        best, best_j = -1, 0.0
        hits = Counter()
        for s_ in prefix:
            post = index.get(s_)
            if post and len(post) <= POSTING_CAP:
                hits.update(post)
        for g, _ in hits.most_common(CANDIDATES):
            ls = lens[centres[g]]
            if ls < threshold * li or li < threshold * ls:
                continue
            j = jaccard(sets[i], sets[centres[g]])
            if j > best_j or (j == best_j and j > 0 and g < best):
                best, best_j = g, j
        if best >= 0 and best_j >= threshold:
            groups[best].append(i)
        else:
            groups.append([i])
            centres.append(i)
            for s in prefix:
                index[s].append(len(groups) - 1)
    return groups


def _monday(day):
    d = datetime.strptime(day, '%Y-%m-%d')
    return (d - timedelta(days=d.weekday())).strftime('%Y-%m-%d')


def _clip(text, n, redact=None):
    t = ' '.join((redact(text) if redact else text or '').split())
    return t if len(t) <= n else t[:n - 1].rstrip() + '…'


def adb(data_dir):
    con = sqlite3.connect(os.path.join(data_dir, 'recurring.db'), timeout=30)
    con.executescript(DDL)
    con.commit()
    con.row_factory = sqlite3.Row
    return con


def _costs(con, since, uuids):
    """Cost and request count per prompt: every request of the session from the prompt until the session's next prompt."""
    out = {}
    q = '''WITH p AS (SELECT uuid, ts, session_id, LEAD(ts, 1, '9999') OVER (PARTITION BY session_id ORDER BY ts) next_ts
             FROM prompts WHERE kind = 'prompt' AND agent_id IS NULL
               AND session_id IN (SELECT DISTINCT session_id FROM prompts WHERE kind = 'prompt' AND agent_id IS NULL AND day >= ?))
           SELECT p.uuid, SUM(r.cost_usd), COUNT(r.msg_id) FROM p JOIN requests r
             ON r.session_id = p.session_id AND r.ts >= p.ts AND r.ts < p.next_ts GROUP BY p.uuid'''
    for u, c, n in con.execute(q, (since,)):
        if u in uuids:
            out[u] = (c or 0.0, n)
    return out


def _spread(rows, keys, n=5):
    """Up to n prompts that differ most from each other (farthest-first on their shingles)."""
    seen, pick = set(), []
    pool = [r for r in rows if r['key'] not in seen or not seen.add(r['key'])]
    if not pool:
        return []
    pick = [max(pool, key=lambda r: r['ts'])]
    while len(pick) < min(n, len(pool)):
        sets = [shingles(keys[p['key']]) for p in pick]
        cand = max((r for r in pool if r not in pick), key=lambda r: min(1 - jaccard(shingles(keys[r['key']]), s) for s in sets))
        pick.append(cand)
    return pick


def detect(con, days=90, profiles=None, project=None, min_count=MIN_COUNT, min_days=MIN_DAYS, threshold=THRESHOLD,
           since=None, until=None, redact=None, today=None, headless=False):
    """Finds the recurring asks. Returns the clusters (strongest first) and the totals; no status or labels yet.
    Prompts of headless runs (`claude -p`, the SDK: entrypoint sdk-*) are already automated and left out unless headless."""
    today = today or datetime.now().strftime('%Y-%m-%d')
    since = since or ((datetime.now() - timedelta(days=days - 1)).strftime('%Y-%m-%d') if days else '0000-00-00')
    w, p = ["kind = 'prompt'", 'agent_id IS NULL', 'day >= ?'], [since]
    if until:
        w.append('day <= ?'); p.append(until)
    if profiles:
        w.append(f'profile IN ({",".join("?" * len(profiles))})'); p += list(profiles)
    if project:
        w.append('project LIKE ?'); p.append(f'%{project}%')
    if not headless:
        w.append("session_id NOT IN (SELECT session_id FROM sessions WHERE entrypoint LIKE 'sdk%')")
    rows = []
    texts = {}
    for u, prof, sid, ts, day, proj, chars, text in con.execute(
            f'SELECT uuid, profile, session_id, ts, day, project, chars, text FROM prompts WHERE {" AND ".join(w)} ORDER BY ts', p):
        if not day:
            continue
        toks = tuple(tokens(text))
        rows.append({'uuid': u, 'profile': prof, 'session': sid, 'ts': ts or '', 'day': day, 'project': proj, 'chars': chars or 0,
                     'text': text or '', 'toks': toks})
    trivial = sum(1 for r in rows if is_trivial(r['toks']))
    rows = [r for r in rows if not is_trivial(r['toks'])]
    uniq = {}
    for r in rows:
        r['key'] = uniq.setdefault(r['toks'], len(uniq))
    keys = [None] * len(uniq)
    for k, i in uniq.items():
        keys[i] = k
    counts = Counter(r['key'] for r in rows)
    groups = cluster(keys, [counts[i] for i in range(len(keys))], threshold) if keys else []
    which = {}
    for g, members in enumerate(groups):
        for i in members:
            which[i] = g
    by_group = defaultdict(list)
    for r in rows:
        by_group[which[r['key']]].append(r)

    first_day = min((r['day'] for r in rows), default=today)
    start = max(since, first_day) if since != '0000-00-00' else first_day
    span = max(14, (datetime.strptime(today, '%Y-%m-%d') - datetime.strptime(start, '%Y-%m-%d')).days + 1)
    per_month = lambda n: round(n * 30.4 / span, 1)
    kept = []
    for g, members in by_group.items():
        if len(members) >= min_count and len({r['day'] for r in members}) >= min_days:
            kept.append((g, members))
    wk0 = _monday(start)
    weeks = []
    d = datetime.strptime(wk0, '%Y-%m-%d')
    last = datetime.strptime(_monday(today), '%Y-%m-%d')
    while d <= last:
        weeks.append(d.strftime('%Y-%m-%d'))
        d += timedelta(days=7)
    weeks = weeks[-52:]
    widx = {w_: i for i, w_ in enumerate(weeks)}

    costs = _costs(con, since, {r['uuid'] for _, ms in kept for r in ms}) if kept else {}
    clusters = []
    for g, members in kept:
        cnt = Counter(r['key'] for r in members)
        uniq_keys = list(cnt)
        centre = groups[g][0]
        if len(uniq_keys) <= 80:
            sh = {k: shingles(keys[k]) for k in uniq_keys}
            medoid = max(uniq_keys, key=lambda k: (sum(cnt[o] * jaccard(sh[k], sh[o]) for o in uniq_keys), cnt[k], -k))
        else:
            medoid = centre
        norm = ' '.join(keys[medoid])
        msh = shingles(keys[medoid])
        wording = sum(jaccard(shingles(keys[r['key']]), msh) for r in members) / len(members)
        ex_rows = [r for r in members if r['key'] == medoid]
        exemplar = max(ex_rows, key=lambda r: r['ts'])['text']
        weekly = [0] * len(weeks)
        for r in members:
            i = widx.get(_monday(r['day']))
            if i is not None:
                weekly[i] += 1
        cs = [costs[r['uuid']][0] for r in members if r['uuid'] in costs]
        total_cost = sum(cs)
        n_days = len({r['day'] for r in members})
        weeks_hit = sum(1 for x in weekly if x) / max(1, len(weeks))
        med_chars = int(statistics.median(r['chars'] for r in members))
        pm = per_month(len(members))
        usd_month = round(total_cost * 30.4 / span, 2)
        score, reason = rank(len(members), n_days, pm, weeks_hit, wording, med_chars, usd_month)
        projects = Counter(r['project'] or '?' for r in members).most_common(5)
        profs = Counter(r['profile'] or '?' for r in members).most_common(5)
        clusters.append({
            'id': ask_id(norm), 'norm': norm, 'exemplar': _clip(exemplar, 280, redact),
            'samples': [_clip(r['text'], 240, redact) for r in _spread(members, keys, 5)],
            'count': len(members), 'sessions': len({r['session'] for r in members}), 'days': n_days,
            'projects': [[a, b] for a, b in projects], 'profiles': [[a, b] for a, b in profs],
            'firstSeen': min(r['day'] for r in members), 'lastSeen': max(r['day'] for r in members),
            'weekly': weekly, 'perMonth': pm,
            'costTotal': round(total_cost, 2), 'costMedian': round(statistics.median(cs), 3) if cs else None, 'costPerMonth': usd_month,
            'medianChars': med_chars, 'wording': round(wording, 2), 'score': score, 'reason': reason,
            '_days': sorted(r['day'] for r in members), '_shingles': msh,
        })
    clusters.sort(key=lambda c: (-c['score'], -c['count'], c['id']))
    total = len(rows)
    rec = sum(c['count'] for c in clusters)
    cmd = con.execute(f"SELECT COUNT(*) FROM prompts WHERE kind = 'command' AND day >= ?{' AND day <= ?' if until else ''}"
                      + (f' AND profile IN ({",".join("?" * len(profiles))})' if profiles else '') + (' AND project LIKE ?' if project else ''),
                      [since] + ([until] if until else []) + list(profiles or []) + ([f'%{project}%'] if project else [])).fetchone()[0]
    all_cost = sum(v[0] for v in costs.values())
    return {
        'generatedAt': datetime.now().isoformat(timespec='seconds'), 'days': days, 'since': start, 'until': until or today,
        'params': {'minCount': min_count, 'minDays': min_days, 'threshold': threshold},
        'prompts': total, 'trivial': trivial, 'slashCommands': cmd, 'recurring': rec,
        'recurringShare': round(rec / total, 3) if total else 0.0,
        'perMonth': per_month(rec), 'costTotal': round(sum(c['costTotal'] for c in clusters), 2),
        'costPerMonth': round(sum(c['costPerMonth'] for c in clusters), 2),
        'clusterCount': len(clusters), 'weeks': weeks,
        'weeklyRecurring': [sum(c['weekly'][i] for c in clusters) for i in range(len(weeks))],
        'weeklyAll': _weekly_all(rows, widx, len(weeks)),
        'clusters': clusters,
    }


def _weekly_all(rows, widx, n):
    out = [0] * n
    for r in rows:
        i = widx.get(_monday(r['day']))
        if i is not None:
            out[i] += 1
    return out


def rank(n, days, per_month, weeks_hit, wording, med_chars, usd_month):
    """How automatable an ask looks, 0-100: how often it comes, how steadily, how stable its wording is, how short, what it costs."""
    freq = min(1.0, math.log2(1 + per_month) / math.log2(1 + 40))
    cost = min(1.0, usd_month / 25.0)
    short = 1.0 if med_chars <= 300 else max(0.4, 300 / med_chars)
    score = 100 * freq * (0.5 + 0.5 * weeks_hit) * (0.5 + 0.5 * min(1.0, wording / 0.8)) * (0.6 + 0.4 * cost) * (0.7 + 0.3 * short)
    bits = [f'{n} times on {days} days']
    bits.append('every week' if weeks_hit >= 0.8 else 'most weeks' if weeks_hit >= 0.5 else 'in bursts')
    bits.append('near-identical wording' if wording >= 0.7 else 'similar wording' if wording >= 0.5 else 'varied wording')
    if med_chars > 600:
        bits.append('long prompts (context-heavy)')
    if usd_month >= 0.5:
        bits.append(f'~${usd_month:.2f}/month')
    return round(min(100.0, score), 1), ', '.join(bits)


# ---------- stored labels and status ----------

def _attach(a, report):
    """Adds each cluster's stored status and label (found by id, else by the overlap of its normalized text), its
    effect since it was marked automated, and the stored asks that no longer show up."""
    stored = [dict(r) for r in a.execute('SELECT * FROM asks')]
    for s in stored:
        s['_sh'] = shingles(s['norm'].split()) if s['norm'] else frozenset()
    today = datetime.now().strftime('%Y-%m-%d')
    used = set()
    for c in report['clusters']:
        hit = next((s for s in stored if s['id'] == c['id']), None)
        if not hit:
            cand = [(jaccard(c['_shingles'], s['_sh']), s) for s in stored if s['id'] not in used]
            cand = [x for x in cand if x[0] >= MATCH]
            hit = max(cand, key=lambda x: x[0])[1] if cand else None
        c['status'], c['label'], c['effect'] = 'new', None, None
        if hit:
            used.add(hit['id'])
            c['id'] = hit['id']
            c['status'] = hit['status'] or 'new'
            c['statusAt'] = hit['status_at']
            c['note'] = hit['note']
            if hit['title'] or hit['auto_kind']:
                c['label'] = {'title': hit['title'], 'category': hit['category'], 'automation': {'kind': hit['auto_kind'], 'draft': hit['draft']},
                              'rationale': hit['rationale'], 'estPromptsMonth': hit['est_prompts_month'], 'estUsdMonth': hit['est_usd_month'],
                              'labeledAt': hit['labeled_at'], 'model': hit['model']}
            if c['status'] == 'automated' and hit['status_at']:
                c['effect'] = effect(c['_days'], hit['status_at'][:10], today, c['firstSeen'])
    report['retired'] = [{'id': s['id'], 'title': s['title'], 'statusAt': s['status_at'], 'status': s['status']}
                         for s in stored if s['status'] == 'automated' and s['id'] not in used]
    for c in report['clusters']:
        c.pop('_days', None); c.pop('_shingles', None)
    return report


def effect(days_list, at, today, first_seen):
    """Prompts per week in the (up to) 28 days before the date it was marked automated against the days since."""
    d_at = datetime.strptime(at, '%Y-%m-%d')
    d_now = datetime.strptime(today, '%Y-%m-%d')
    before_days = max(7, min(28, (d_at - datetime.strptime(first_seen, '%Y-%m-%d')).days))
    lo = (d_at - timedelta(days=before_days)).strftime('%Y-%m-%d')
    nb = sum(1 for d in days_list if lo <= d < at)
    na = sum(1 for d in days_list if d >= at)
    after_days = (d_now - d_at).days + 1
    b, af = nb / before_days * 7, na / max(1, after_days) * 7
    if after_days < 7:
        verdict = 'too early'
    elif b == 0:
        verdict = 'no baseline'
    elif af <= 0.2 * b:
        verdict = 'stopped'
    elif af <= 0.6 * b:
        verdict = 'dropped'
    else:
        verdict = 'unchanged'
    return {'at': at, 'beforePerWeek': round(b, 1), 'afterPerWeek': round(af, 1), 'afterDays': after_days, 'verdict': verdict}


def report(con, a, **kw):
    """The full picture: detection joined with the stored statuses and labels."""
    return _attach(a, detect(con, **kw))


def _find(con, a, rid, **kw):
    for days in (kw.get('days', 90), 0):
        r = _attach(a, detect(con, **{**kw, 'days': days}))
        for c in r['clusters']:
            if c['id'] == rid:
                return c
        if not kw.get('days', 90) or kw.get('since'):
            break
    return None


def _upsert(a, c, **fields):
    a.execute('INSERT OR IGNORE INTO asks (id, norm) VALUES (?, ?)', (c['id'], c['norm']))
    a.execute('UPDATE asks SET norm = ? WHERE id = ?', (c['norm'], c['id']))
    for k, v in fields.items():
        a.execute(f'UPDATE asks SET {k} = ? WHERE id = ?', (v, c['id']))
    a.commit()


def set_status(con, a, rid, status, note=None, at=None, **kw):
    if status not in STATUSES:
        raise ValueError(f'status must be one of {", ".join(STATUSES)}')
    c = _find(con, a, rid, **kw)
    if not c:
        raise ValueError(f'no recurring ask {rid}')
    _upsert(a, c, status=status, status_at=(at or datetime.now().isoformat(timespec='seconds')) if status != 'new' else None, note=note)
    return {'id': c['id'], 'status': status, 'exemplar': c['exemplar']}


def record(con, a, payload, model=None, redact=None, **kw):
    """Stores a model's labels. Returns (run id, ids labelled, warnings). Ids must be asks the detection finds now."""
    items = payload.get('clusters') or payload.get('labels') or []
    r = detect(con, **kw)
    r = _attach(a, r)
    known = {c['id']: c for c in r['clusters']}
    done, warn = [], []
    now = datetime.now().isoformat(timespec='seconds')
    for it in items:
        c = known.get(str(it.get('id', '')))
        if not c:
            warn.append(f'{it.get("id")}: not a recurring ask in this data (skipped)')
            continue
        auto = it.get('automation') or {}
        kind = auto.get('kind') or it.get('kind') or 'none'
        if kind not in KINDS:
            warn.append(f'{c["id"]}: automation kind "{kind}" is not one of {", ".join(KINDS)} (stored as none)')
            kind = 'none'
        cat = it.get('category') if it.get('category') in CATEGORIES else 'other'
        if it.get('category') not in CATEGORIES:
            warn.append(f'{c["id"]}: category "{it.get("category")}" is not one of {", ".join(CATEGORIES)} (stored as other)')
        draft = (redact(auto.get('draft')) if redact else auto.get('draft')) or ''
        if kind != 'none' and not draft.strip():
            warn.append(f'{c["id"]}: automation {kind} without a draft')
        num = lambda v, cap: None if not isinstance(v, (int, float)) else round(max(0.0, min(float(v), cap)), 2)
        pm = num(it.get('est_prompts_month'), c['perMonth'])
        um = num(it.get('est_usd_month'), c['costPerMonth'])
        if isinstance(it.get('est_prompts_month'), (int, float)) and pm != it['est_prompts_month']:
            warn.append(f'{c["id"]}: est_prompts_month capped at the {c["perMonth"]} prompts/month seen')
        if kind == 'none':
            pm, um = 0.0, 0.0
        _upsert(a, c, title=str(it.get('title') or c['exemplar'])[:140], category=cat, auto_kind=kind, draft=draft[:8000],
                rationale=str(it.get('rationale') or '')[:1200], est_prompts_month=pm if pm is not None else c['perMonth'] if kind != 'none' else 0,
                est_usd_month=um if um is not None else c['costPerMonth'] if kind != 'none' else 0, labeled_at=now, model=model)
        done.append(c['id'])
    rid = hashlib.sha1(f'{now}{done}'.encode()).hexdigest()[:8]
    a.execute('INSERT INTO runs VALUES (?,?,?,?,?)', (rid, now, model, str(payload.get('summary') or '')[:1000], len(done)))
    a.commit()
    return rid, done, warn


def brief(con, a, limit=25, relabel=False, **kw):
    """The asks worth labelling, as JSON for a model: redacted and clipped samples, never whole prompts."""
    r = report(con, a, **kw)
    cands = [c for c in r['clusters'] if c['status'] == 'new' and (relabel or not c['label'])][:limit]
    cmds = [{'command': x, 'uses': n} for x, n in con.execute(
        """SELECT substr(text, instr(text, '<command-name>') + 14, instr(text, '</command-name>') - instr(text, '<command-name>') - 14) c, COUNT(*) n
           FROM prompts WHERE kind = 'command' AND instr(text, '<command-name>') > 0 AND day >= ? GROUP BY 1 ORDER BY n DESC LIMIT 25""", (r['since'],))]
    return {
        'generatedAt': r['generatedAt'], 'since': r['since'], 'prompts': r['prompts'], 'recurringShare': r['recurringShare'],
        'categories': list(CATEGORIES), 'automationKinds': list(KINDS),
        'slashCommandsUsed': cmds,
        'clusters': [{k: c[k] for k in ('id', 'exemplar', 'samples', 'count', 'days', 'sessions', 'projects', 'perMonth', 'costTotal',
                                        'costMedian', 'costPerMonth', 'medianChars', 'wording', 'score', 'reason', 'firstSeen', 'lastSeen')}
                     | ({'label': c['label']} if c['label'] else {}) for c in cands],
        'recordFormat': {'summary': 'one line', 'clusters': [{'id': 'from clusters[].id', 'title': 'short, imperative',
                         'category': '|'.join(CATEGORIES), 'automation': {'kind': '|'.join(KINDS), 'draft': 'the text to save, ready to use'},
                         'rationale': 'why this automation, and what it will not cover', 'est_prompts_month': 0, 'est_usd_month': 0}]},
    }


def fmt_text(r, limit=15):
    out = [f"Recurring asks: {r['since']} to {r['until']}  ({r['prompts']:,} prompts, {r['trivial']:,} one-word replies left out)", '']
    if not r['clusters']:
        out.append(f"No ask came up {r['params']['minCount']}+ times on {r['params']['minDays']}+ days. Try a longer --days or a lower --min.")
        return '\n'.join(out)
    out.append(f"{r['clusterCount']} recurring asks cover {r['recurring']:,} prompts ({100 * r['recurringShare']:.0f}% of them), "
               f"about {r['perMonth']:.0f} a month and ~${r['costPerMonth']:.2f} a month. {r['slashCommands']:,} more went through slash commands.")
    out.append('')
    out.append(f"{'id':<9}{'times':>6}{'days':>5}{'$/month':>9}{'score':>6}  {'status':<10} ask")
    for c in r['clusters'][:limit]:
        title = (c['label'] or {}).get('title') or c['exemplar']
        auto = ((c['label'] or {}).get('automation') or {}).get('kind')
        ef = c.get('effect')
        tail = f"  -> {auto}" if auto and auto != 'none' else ''
        if ef:
            tail += f"  [{ef['beforePerWeek']}/wk before, {ef['afterPerWeek']}/wk since: {ef['verdict']}]"
        out.append(f"{c['id']:<9}{c['count']:>6}{c['days']:>5}{c['costPerMonth']:>9.2f}{c['score']:>6.0f}  {c['status']:<10} {_clip(title, 70)}{tail}")
    if r['clusterCount'] > limit:
        out.append(f"... and {r['clusterCount'] - limit} more (--limit N, or --json)")
    for x in r.get('retired') or []:
        out.append(f"{x['id']:<9} gone since {str(x['statusAt'])[:10]}: {x['title'] or 'an automated ask'} (the ask stopped)")
    unl = sum(1 for c in r['clusters'] if c['status'] == 'new' and not c['label'])
    out += ['', (f'{unl} not labelled yet: /analytics recurring classify drafts a title, a category and an automation for each. ' if unl else '')
            + 'Mark one: /analytics recurring automated|dismiss <id>  ·  details: /analytics recurring show <id>  ·  /dashboard recurring']
    return '\n'.join(out)


def fmt_one(c):
    L = c['label'] or {}
    A = L.get('automation') or {}
    out = [f"{c['id']}  {L.get('title') or c['exemplar']}", f"status {c['status']}" + (f" since {str(c.get('statusAt'))[:10]}" if c.get('statusAt') else ''),
           f"{c['count']} times on {c['days']} days in {c['sessions']} sessions, {c['firstSeen']} to {c['lastSeen']}; ~{c['perMonth']}/month, ${c['costPerMonth']}/month; score {c['score']} ({c['reason']})",
           '', 'Samples:'] + [f'  - {s}' for s in c['samples']]
    if c.get('effect'):
        e = c['effect']
        out += ['', f"Since marked automated ({e['at']}): {e['beforePerWeek']}/week before, {e['afterPerWeek']}/week after {e['afterDays']} days: {e['verdict']}"]
    if L:
        out += ['', f"{L.get('category')}: {A.get('kind')}  (saves ~{L.get('estPromptsMonth')} prompts and ~${L.get('estUsdMonth')} a month)", L.get('rationale') or '']
        if A.get('draft'):
            out += ['', 'Draft:', A['draft']]
    return '\n'.join(out)
