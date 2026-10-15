"""Frustration meter: how annoyed the person was when they typed each prompt, from 0 (calm) to 100 (rage).

Every main-loop prompt gets a score: the sum of the weights of the signals it shows, capped at 100.
From the text (code blocks, pasted blocks and `inline code` are left out first):
  * swearing        fuck, shit, wtf, ffs, damn, kurva, bazdmeg, …
  * insult          stupid, idiot, useless, incompetent, …
  * giving up       "forget it", "never mind", "I'll do it myself", "this is ridiculous"
  * repeating self  "how many times", "I already said", "for the third time", "you keep", "megint"
  * blame           "you broke", "why did you", "what are you doing", "did you even"
  * correction      a push-back or redo (the rule in quality.is_correction)
  * shouting        in the prose lines (not code, SQL or diffs): two or more ALL-CAPS words making up a quarter of the
                    words (acronyms left out), or mostly upper-case letters
  * punctuation     !!, ???, ?!
  * elongation      "nooooo", "whyyyy"
  * terse           a correction of fewer than 20 characters ("no", "wrong", "fix it")
From what happened just before:
  * after interrupt the person stopped the previous turn
  * rejected calls  the person said no to a tool call in the previous turn (not counted on top of an interrupt:
                    a rejection usually stops the turn too, and saying no to a call is steering more than anger)
  * repeated ask    nearly the same words as one of the 3 prompts before it
Levels: calm 0, mild 1-24, annoyed 25-49, frustrated 50-74, rage 75+.
Each prompt is tied to the model (and effort) that answered the turn before it: the one being reacted to.
Every rule is a heuristic and is written down here so the numbers can be checked against it.
"""
import bisect, json, re
from datetime import datetime

import quality

VERSION = '1'  # bump when a rule or weight changes: every score is worked out again at the next import

WEIGHTS = {
    'swearing': 35, 'insult': 30, 'giving_up': 20, 'repeating_self': 15, 'blame': 10, 'correction': 15,
    'shouting': 15, 'punctuation': 10, 'elongation': 5, 'terse': 5,
    'after_interrupt': 10, 'rejected_calls': 10, 'repeated_ask': 15,
}
LEVELS = ((75, 'rage'), (50, 'frustrated'), (25, 'annoyed'), (1, 'mild'), (0, 'calm'))

SWEAR = re.compile(r"\b(fuck\w*|f+u+c+k+\w*|shit\w*|bullshit|wtf|ffs|omfg|stfu|damn\w*|goddamn\w*|crap|bloody hell|jesus christ"
                   r"|kurv\w*|bazd\w*|bazmeg|baszd?\w*|basszus|picsa\w*|a francba|geci\w*|szar(ul|t|ság|ságot)?)\b", re.I)
INSULT = re.compile(r"\b(stupid|idiot\w*|useless|dumb(ass)?|incompetent|moron\w*|pathetic|braindead|garbage(?! collect)|hülye\w*|béna|ostoba)\b", re.I)
GIVING_UP = re.compile(r"\b(forget (it|about it)|never ?mind|i give up|i'?ll do it myself|i'?ll just do it|just stop\b|this is (hopeless|useless|ridiculous|insane|a joke|a mess)"
                       r"|unbelievable|ridiculous|seriously\?|hagyd|feladom|inkább megcsinálom)", re.I)
REPEATING = re.compile(r"\b(how many times|for the (\w+ )?(second|third|fourth|fifth|nth|\d+(st|nd|rd|th)|last|hundredth) time|i (already|just) (said|told|asked)"
                       r"|as i (said|told you|asked|mentioned)|i keep (telling|saying|asking)|you keep\b|every single time|once again\b|yet again\b"
                       r"|stop (doing|adding|making|changing|using|writing)\b|megint|már (megint|mondtam)|hányszor)", re.I)
BLAME = re.compile(r"\b(you (broke|ruined|deleted|removed|ignored|forgot|missed|messed)|you (didn'?t|did not|don'?t|do not) (listen|read|follow|understand)"
                   r"|why (did|would|do|are) you|what (the hell|on earth) |what are you doing|did you even|are you (kidding|serious|even)\b|miért csináltad)", re.I)
PUNCT = re.compile(r'!{2,}|\?{3,}|\?!|!\?')
ELONG = re.compile(r'\b\w*([a-z])\1{3,}\w*\b', re.I)
CAPS_WORD = re.compile(r'\b[A-Z]{3,}\b')
ACRONYMS = {'API', 'APIS', 'JSON', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'URL', 'URLS', 'YAML', 'TOML', 'CORS', 'AUTH', 'README', 'TODO', 'FIXME',
            'NULL', 'TRUE', 'FALSE', 'UUID', 'SQL', 'CLI', 'SDK', 'MCP', 'LSP', 'PDF', 'CSV', 'XML', 'JWT', 'SSH', 'DNS', 'TCP', 'UDP',
            'AWS', 'GCP', 'ENV', 'PATH', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CRUD', 'UTC', 'ISO', 'NPM', 'CLAUDE', 'AGENTS', 'CHANGELOG',
            'LICENSE', 'IDE', 'DIFF', 'REDACTED', 'PNG', 'SVG', 'JPG', 'GIF', 'RAM', 'CPU', 'GPU', 'SSR', 'DOM', 'ESM', 'CJS', 'PR', 'PRS', 'LLM', 'TTL', 'KPI', 'KPIS',
            'ASAP', 'FYI', 'IMO', 'TBD', 'WIP', 'OK', 'OKAY', 'USD', 'EUR', 'HUF', 'MVP', 'QA', 'UI', 'UX', 'CI', 'CD', 'DB', 'ID', 'IDS'}
STRIP = re.compile(r'```.*?(```|$)|<pasted_content\b.*?(</pasted_content>|$)|`[^`\n]*`|\[Image #\d+\]|https?://\S+|(?<!\w)[~./][\w./-]+', re.S)


def clean(text):
    """What the person typed: no code, pasted blocks, links or paths."""
    return STRIP.sub(' ', text or '').strip()


CODE_LINE = re.compile(r'[{};=<>()\[\]|]|^\s*([-+@#$*>]|diff\b|index\b)', re.I)


def _shouting(t):
    prose = ' '.join(ln for ln in t.split('\n') if not CODE_LINE.search(ln))
    words = re.findall(r'[A-Za-z]{2,}', prose)
    caps = [w for w in CAPS_WORD.findall(prose) if w not in ACRONYMS]
    if len(caps) >= 2 and len(caps) >= 0.25 * len(words):
        return True
    letters = [c for c in prose if c.isalpha()]
    return len(letters) >= 12 and sum(c.isupper() for c in letters) / len(letters) >= 0.7


def text_signals(text):
    """The signals a prompt's own words show."""
    t = clean(text)[:2000]
    if not t:
        return []
    out = [name for name, rx in (('swearing', SWEAR), ('insult', INSULT), ('giving_up', GIVING_UP), ('repeating_self', REPEATING),
                                 ('blame', BLAME), ('punctuation', PUNCT), ('elongation', ELONG)) if rx.search(t)]
    if quality.is_correction(text):
        out.append('correction')
        if len(t) < 20:
            out.append('terse')
    if _shouting(t):
        out.append('shouting')
    return out


def _words(text):
    return set(re.findall(r'\w{3,}', clean(text).lower()))


def similar(a, b):
    """Nearly the same ask: word overlap (Jaccard) of 0.6 or more, both at least 4 words."""
    if len(a) < 4 or len(b) < 4:
        return False
    return len(a & b) / len(a | b) >= 0.6


def score(signals):
    return min(100, sum(WEIGHTS[s] for s in signals))


def level(s):
    return next(name for lo, name in LEVELS if s >= lo)


# ---------- the mood table ----------

DDL = '''CREATE TABLE IF NOT EXISTS mood (uuid TEXT PRIMARY KEY, profile TEXT, session_id TEXT, ts TEXT, day TEXT, hour INTEGER,
  weekday INTEGER, project TEXT, model TEXT, effort TEXT, chars INTEGER, score INTEGER, level TEXT, signals TEXT);
CREATE INDEX IF NOT EXISTS mood_day ON mood (day);
CREATE INDEX IF NOT EXISTS mood_session ON mood (session_id);'''


def _local(ts):
    try:
        d = datetime.fromisoformat(ts.replace('Z', '+00:00')).astimezone()
        return d.hour, int(d.strftime('%w'))
    except Exception:
        return None, None


def session_rows(con, sid):
    """One mood row per main-loop prompt of a session."""
    msgs = con.execute("""SELECT uuid, profile, ts, day, project, kind, chars, text FROM prompts WHERE session_id = ? AND agent_id IS NULL
        AND kind IN ('prompt', 'interrupt') AND ts IS NOT NULL ORDER BY ts""", (sid,)).fetchall()
    if not msgs:
        return []
    reqs = con.execute('SELECT ts, model, effort FROM requests WHERE session_id = ? AND agent_id IS NULL AND ts IS NOT NULL ORDER BY ts', (sid,)).fetchall()
    req_ts = [r[0] for r in reqs]
    rejected = [r[0] for r in con.execute("SELECT ts FROM tool_uses WHERE session_id = ? AND flag = 'rejected' AND ts IS NOT NULL ORDER BY ts", (sid,))]
    out, prev_ts, after_interrupt, recent = [], '', False, []
    for uuid, profile, ts, day, project, kind, chars, text in msgs:
        if kind == 'interrupt':
            after_interrupt = True
            continue
        sig = text_signals(text)
        if after_interrupt:
            sig.append('after_interrupt')
        elif prev_ts and bisect.bisect_left(rejected, ts) > bisect.bisect_left(rejected, prev_ts):
            sig.append('rejected_calls')
        w = _words(text)
        if any(similar(w, r) for r in recent):
            sig.append('repeated_ask')
        i = bisect.bisect_left(req_ts, ts)
        model, effort = (reqs[i - 1] if i else reqs[0] if reqs else (None, None, None))[1:]
        hour, weekday = _local(ts)
        s = score(sig)
        out.append((uuid, profile, sid, ts, day, hour, weekday, project, model, effort, chars, s, level(s), json.dumps(sig)))
        prev_ts, after_interrupt, recent = ts, False, (recent + [w])[-3:]
    return out


def refresh(con, sids=None):
    """Score the prompts of these sessions again (all of them when the table is new or a rule changed). Returns sessions scored."""
    con.executescript(DDL)
    v = con.execute("SELECT v FROM meta WHERE k = 'mood_version'").fetchone()
    if sids is None or not v or v[0] != VERSION:
        con.execute('DELETE FROM mood')
        sids = [r[0] for r in con.execute("SELECT DISTINCT session_id FROM prompts WHERE agent_id IS NULL AND kind = 'prompt'")]
    for sid in sids:
        con.execute('DELETE FROM mood WHERE session_id = ?', (sid,))
        con.executemany('INSERT OR REPLACE INTO mood VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', session_rows(con, sid))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('mood_version', ?)", (VERSION,))
    con.commit()
    return len(sids)
