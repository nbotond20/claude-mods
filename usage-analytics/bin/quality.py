"""Output-quality signals: whether the work was good, not only what it cost.

Derived from data the import already has, plus one outside source (git):
  * corrections   a follow-up prompt that pushes back or asks for a redo ("no", "still broken", "revert that")
  * interrupts    the person stopped a turn ("[Request interrupted by user]")
  * rejections    the person said no to a proposed tool call
  * edit churn    an edit that rewrites lines Claude wrote earlier in the same turn (or rewrites a whole file it wrote)
  * checks        test / typecheck / lint / build commands, and whether the last one in a turn passed;
                  a piped command (`npm test | tail`) exits 0 even when tests fail, so the output is read for failure marks too
  * survival      the lines Claude wrote that are in the file at the next commit (within 3 days), and edited files committed
  * idle re-cache context written to the cache again after an idle gap (the cache expired)
Every rule is a heuristic and is written down here so the numbers can be checked against it.
"""
import bisect, os, re, subprocess, time, zlib
from datetime import datetime, timedelta, timezone

EDIT_TOOLS = ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')

# ---------- at import: per tool call ----------

# First match wins: a command that runs tests and builds counts as tests. Matched at the start of each
# command in a chain or pipe, after env assignments and runners (npx, uv run, python -m, …).
VERIFY_RULES = [
    ('test', re.compile(r'(pytest|vitest|jest|mocha|rspec|phpunit|ctest|unittest|playwright test|node --test)\b'
                        r'|(npm|pnpm|yarn|bun)( run)? test\b|(bun|go|cargo|deno|dotnet|mix|swift|flutter) test\b'
                        r'|make (test|check)\b|(gradlew?|\./gradlew|mvn) test\b|npm t\b')),
    ('typecheck', re.compile(r'(tsc|mypy|pyright|vue-tsc)\b|(npm|pnpm|yarn|bun) run (typecheck|type-check|check-types|types)\b'
                             r'|cargo check\b|go vet\b')),
    ('lint', re.compile(r'(eslint|biome|ruff|flake8|pylint|golangci-lint|shellcheck|stylelint|rubocop)\b|cargo clippy\b'
                        r'|prettier (--check|-c)\b|(npm|pnpm|yarn|bun) run lint\b')),
    ('build', re.compile(r'(npm|pnpm|yarn|bun) run build\b|(cargo|go|swift|dotnet) build\b|make\b|(gradlew?|\./gradlew) (build|assemble)\b'
                         r'|mvn (package|install|verify)\b|docker (compose )?build\b|xcodebuild\b|vite build\b|next build\b')),
]
RUNNERS = {'npx', 'bunx', 'pnpx', 'time', 'exec', 'env', 'command', 'nice'}
RUNNER_PAIRS = {('uv', 'run'), ('poetry', 'run'), ('pnpm', 'exec'), ('yarn', 'exec'), ('bundle', 'exec'), ('npm', 'exec'), ('pipenv', 'run')}


def _program(seg):
    """A command segment without env assignments, runners and `python -m`: what actually runs."""
    w = seg.split()
    while w:
        if '=' in w[0] and not w[0].startswith('-'):
            w = w[1:]
        elif w[0] in RUNNERS:
            w = w[1:]
        elif w[0] == 'timeout' and len(w) > 1:
            w = w[2:]
        elif len(w) > 1 and (w[0], w[1]) in RUNNER_PAIRS:
            w = w[2:]
        elif len(w) > 2 and re.fullmatch(r'python3?(\.\d+)?', w[0]) and w[1] == '-m':
            w = w[2:]
        elif w[0] in ('pnpm', 'npm', 'yarn') and len(w) > 2 and w[1].startswith('--filter'):
            w = [w[0]] + w[3 if '=' not in w[1] else 2:]
        else:
            break
    return ' '.join(w)


def verify_kind(cmd):
    """test | typecheck | lint | build for a shell command that checks the work, else None."""
    if not cmd:
        return None
    progs = [_program(s) for s in re.split(r'&&|\|\||[;|\n(){}]', cmd)]
    for kind, rx in VERIFY_RULES:
        if any(rx.match(p) for p in progs if p):
            return kind
    return None


FAIL_RE = re.compile(r'\b[1-9]\d* (failed|failing|failures?|fail|errors?)\b|^\s*FAIL\b|^\(fail\) |^FAILED\b|\bTests?:\s+[1-9]\d* failed'
                     r'|\berror TS\d{4}\b|Traceback \(most recent call last\)|\bnpm ERR!|\bERR_PNPM_|^error(\[E\d+\])?:'
                     r'|^\s*(×|✗|✕)\s|\bAssertionError\b|\bexit (code|status) [1-9]\d*\b|\bExit code [1-9]\d*\b'
                     r'|\bBUILD FAILED\b|\bCompilation failed\b', re.M)
REJECT_RE = re.compile(r"^(The user doesn't want to (proceed|take this action)|User rejected)")
DENY_RE = re.compile(r'^Permission to use \S+ has been denied|has been denied by')


def result_flag(text):
    """rejected (the person said no) | denied (a rule or hook said no) | fail (the output shows a failure) | None."""
    if not text:
        return None
    head = text[:300].lstrip()
    if REJECT_RE.match(head) or head.startswith('[Request interrupted by user for tool use]'):
        return 'rejected'
    if DENY_RE.search(head):
        return 'denied'
    sample = text if len(text) <= 6000 else text[:2000] + '\n' + text[-4000:]
    return 'fail' if FAIL_RE.search(sample) else None


def _line_ok(s):
    return len(s) >= 4 and any(c.isalnum() for c in s)


def line_hash(s):
    return format(zlib.crc32(s.encode('utf-8', 'replace')), '08x')


def written(name, inp):
    """(lines written, space-separated hashes of the distinct meaningful lines) for an edit tool's input, else (None, None).
    Only hashes are kept: enough to find the lines again in a later commit, nothing of the code itself."""
    if name not in EDIT_TOOLS or not isinstance(inp, dict):
        return None, None
    parts = []
    if name == 'Write':
        parts = [inp.get('content')]
    elif name == 'Edit':
        parts = [inp.get('new_string')]
    elif name == 'MultiEdit':
        parts = [e.get('new_string') for e in inp.get('edits') or [] if isinstance(e, dict)]
    elif name == 'NotebookEdit':
        parts = [inp.get('new_source')]
    lines = [ln.strip() for p in parts if isinstance(p, str) for ln in p.split('\n')]
    lines = [ln for ln in lines if ln]
    hs = list(dict.fromkeys(line_hash(ln) for ln in lines if _line_ok(ln)))[:400]
    return len(lines), ' '.join(hs)


def replaced(name, inp):
    """Space-separated hashes of the lines an Edit or MultiEdit replaces, else None: with `written`, this finds
    Claude rewriting lines it wrote itself a moment ago."""
    if name not in ('Edit', 'MultiEdit') or not isinstance(inp, dict):
        return None
    parts = [inp.get('old_string')] if name == 'Edit' else [e.get('old_string') for e in inp.get('edits') or [] if isinstance(e, dict)]
    hs = {line_hash(ln.strip()) for p in parts if isinstance(p, str) for ln in p.split('\n') if _line_ok(ln.strip())}
    return ' '.join(sorted(hs))[:9000]


# ---------- per follow-up prompt ----------

CORRECTION_START = re.compile(
    r"^(no\b(?! (need|worries|problem|rush))|nope\b|wrong\b|incorrect\b|not (quite|what|that|right|working)\b|that'?s (not|wrong|incorrect|broken)\b"
    r"|th(is|at) (is|isn'?t|was|wasn'?t) (wrong|broken|not|incorrect)|it (still|didn'?t|doesn'?t|did not|does not)\b"
    r"|(doesn'?t|didn'?t|does not|did not) work|undo\b|revert\b|roll ?back\b|try again\b|you (broke|forgot|missed|didn'?t|did not|removed|deleted|ignored)\b"
    r"|why did you\b|i (said|asked|told you|meant)\b|stop\b|wait\b|nem\b|rossz\b|még mindig\b|megint\b)", re.I)
CORRECTION_ANY = re.compile(
    r"\b(revert (that|this|it|the|your)|undo (that|this|it|the|your)|you broke|that'?s (wrong|incorrect|not right)"
    r"|not what i (asked|wanted|meant)|(doesn'?t|didn'?t|does not|did not) work|this is wrong|same (error|issue|problem)"
    r"|you (didn'?t|did not) (fix|do|change)|are you sure|the fixes i asked|(error|errors|failure) above|as i (said|asked)|i already (said|told)"
    r"|still (see|seeing|get|getting|has|have|is|isn'?t|not|broken|fail\w*|the same|there|happen\w*|show\w*|doesn'?t|don'?t|can'?t|no)"
    r"|fuck\w*|wtf|ffs)\b", re.I)
# Screenshots and pasted blocks come first in many prompts; what the person typed follows them.
LEAD = re.compile(r'^(\s*(\[Image #\d+\]|<pasted_content\b.*?</pasted_content>))+', re.S)


def is_correction(text):
    """A follow-up that pushes back, asks for a redo, or pastes an error from what was just done."""
    t = LEAD.sub('', text or '').strip()[:600]
    if not t:
        return False
    return bool(CORRECTION_START.match(t) or CORRECTION_ANY.search(t) or re.fullmatch(r'fix( (it|this|that))?[.!]*', t, re.I)
                or FAIL_RE.search(t))


# ---------- per session ----------

def _dt(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00'))
    except Exception:
        return None


IDLE_S = 300  # the default prompt cache lives 5 minutes


def session_quality(con, sids):
    """Quality numerators and denominators per session id."""
    out = {s: dict(followups=0, corrections=0, interrupts=0, rejections=0, edits=0, churn_edits=0, turns_q=0,
                   edit_turns=0, verify_turns=0, verify_turns_edit=0, verify_pass=0, idle_rewrite=0, cw_main=0,
                   lines_written=0, lines_kept=0, files_edited=0, files_committed=0, model=None, effort=None) for s in sids}
    for i in range(0, len(sids), 500):
        chunk = sids[i:i + 500]
        q = ','.join('?' * len(chunk))
        starts = {}
        for sid, ts, kind, text in con.execute(f"""SELECT session_id, ts, kind, text FROM prompts WHERE agent_id IS NULL
                AND kind IN ('prompt', 'interrupt') AND session_id IN ({q}) ORDER BY session_id, ts""", chunk):
            r = out[sid]
            if kind == 'interrupt':
                r['interrupts'] += 1
                continue
            if sid in starts:
                r['followups'] += 1
                r['corrections'] += is_correction(text)
            starts.setdefault(sid, []).append(ts or '')
        turns = {}
        for sid, ts, tool, file, verify, err, flag, wrote, repl in con.execute(f"""SELECT session_id, ts, tool, file, verify, is_error, flag, wrote, replaced FROM tool_uses
                WHERE session_id IN ({q}) AND ts IS NOT NULL AND (verify IS NOT NULL OR tool IN ({','.join('?' * len(EDIT_TOOLS))}) OR flag = 'rejected')
                ORDER BY session_id, ts""", chunk + list(EDIT_TOOLS)):
            r = out[sid]
            if flag == 'rejected':
                r['rejections'] += 1
                continue
            t = turns.setdefault(sid, {}).setdefault(bisect.bisect_right(starts.get(sid, []), ts), {'files': {}, 'last': None})
            if tool in EDIT_TOOLS:
                if not err and file:
                    r['edits'] += 1
                    mine = t['files'].get(file)
                    if mine is not None and (tool == 'Write' or (repl and not mine.isdisjoint(repl.split()))):
                        r['churn_edits'] += 1
                    t['files'].setdefault(file, set()).update((wrote or '').split())
            elif verify and flag != 'denied':
                t['last'] = not err and flag != 'fail'
        for sid, ts_ in turns.items():
            r = out[sid]
            for t in ts_.values():
                r['turns_q'] += 1
                r['edit_turns'] += bool(t['files'])
                if t['last'] is not None:
                    r['verify_turns'] += 1
                    r['verify_turns_edit'] += bool(t['files'])
                    r['verify_pass'] += t['last']
        prev, models = {}, {}
        for sid, ts, cr, cw, model, effort in con.execute(f"""SELECT session_id, ts, cache_read, cache_write, model, effort FROM requests
                WHERE agent_id IS NULL AND session_id IN ({q}) ORDER BY session_id, ts""", chunk):
            m = models.setdefault(sid, {})
            m[(model, effort)] = m.get((model, effort), 0) + 1
            out[sid]['cw_main'] += cw or 0
            d = _dt(ts)
            p = prev.get(sid)
            if p and d and (d - p).total_seconds() > IDLE_S and (cw or 0) > (cr or 0):
                out[sid]['idle_rewrite'] += cw or 0
            if d:
                prev[sid] = d
        for sid, m in models.items():
            # the model (and effort) that answered most of the main loop's requests
            out[sid]['model'], out[sid]['effort'] = max(m.items(), key=lambda kv: kv[1])[0]
        for sid, lw, lk, fe, fc in con.execute(f"""SELECT session_id, lines_written, lines_kept, files_edited, files_committed
                FROM git_outcomes WHERE state = 'done' AND session_id IN ({q})""", chunk):
            out[sid].update(lines_written=lw or 0, lines_kept=lk or 0, files_edited=fe or 0, files_committed=fc or 0)
    return out


# ---------- git: did the edits ship? ----------

SETTLE_DAYS = 3      # a file not committed this long after the edit counts as not shipped
RECHECK_H = 6        # a session still waiting for commits is looked at again after this long
GIT_TIMEOUT = 10


# Read-only lookups in repos Claude edited, which may be cloned from anywhere: a repo's own config must
# not get a program run (fsmonitor, textconv and external diff drivers, pager, credential prompts).
GIT_SAFE = ('-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager')
GIT_ENV = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_PAGER': 'cat', 'GIT_EXTERNAL_DIFF': '', 'GIT_OPTIONAL_LOCKS': '0'}


def _git(root, *args):
    try:
        p = subprocess.run(['git', *GIT_SAFE, '-C', root, *args], capture_output=True, stdin=subprocess.DEVNULL,
                           env=GIT_ENV, timeout=GIT_TIMEOUT)
        return p.stdout.decode('utf-8', 'replace') if p.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


class Repos:
    def __init__(self):
        self.roots = {}

    def root(self, path):
        d = os.path.dirname(path)
        while d and not os.path.isdir(d):
            nd = os.path.dirname(d)
            if nd == d:
                return None
            d = nd
        if d not in self.roots:
            r = _git(d, 'rev-parse', '--show-toplevel')
            self.roots[d] = r.strip() if r else None
        return self.roots[d]


def _epoch(ts):
    d = _dt(ts)
    return int(d.timestamp()) if d else None


def outcome(con, sid, repos, now=None):
    """Survival of one session's edits: (state, row). state: done | pending | no_repo."""
    now = now or time.time()
    files = {}
    for file, ts, wrote in con.execute(f"""SELECT file, ts, wrote FROM tool_uses WHERE session_id = ? AND tool IN ({','.join('?' * len(EDIT_TOOLS))})
            AND COALESCE(is_error, 0) = 0 AND wrote IS NOT NULL AND file IS NOT NULL ORDER BY ts""", (sid, *EDIT_TOOLS)):
        f = files.setdefault(file, {'hashes': set(), 'last': ts})
        f['hashes'].update(wrote.split())
        f['last'] = max(f['last'] or '', ts or '')
    row = dict(repos=set(), files_edited=0, files_committed=0, lines_written=0, lines_kept=0, commits=set())
    pending = False
    for file, f in files.items():
        if not f['hashes'] or not os.path.isabs(file):
            continue
        root = repos.root(file)
        t = _epoch(f['last'])
        if not root or t is None:
            continue
        rel = os.path.relpath(file, root)
        if rel.startswith('..'):
            continue
        log = _git(root, 'log', '--no-textconv', '--no-ext-diff', '--all', '--format=%H %ct', f'--since={t}', f'--until={t + SETTLE_DAYS * 86400}', '--', rel)
        if log is None:
            continue
        commits = [ln.split() for ln in log.splitlines() if ln.strip()]
        if not commits and now - t < SETTLE_DAYS * 86400:
            pending = True
            continue
        row['repos'].add(root)
        row['files_edited'] += 1
        row['lines_written'] += len(f['hashes'])
        if commits:
            first = min(commits, key=lambda c: int(c[1]))[0]
            row['files_committed'] += 1
            row['commits'].add(first)
            body = _git(root, 'show', '--no-textconv', '--no-ext-diff', f'{first}:{rel}') or ''
            have = {line_hash(ln.strip()) for ln in body.split('\n') if _line_ok(ln.strip())}
            row['lines_kept'] += len(f['hashes'] & have)
    state = 'pending' if pending else 'done' if row['files_edited'] else 'no_repo'
    return state, row


def refresh_git(con, budget_s=20.0, limit=None, now=None):
    """Work out survival for sessions with edits that have none yet, newest first, until the time budget is spent.
    Sessions still waiting for a commit are looked at again later; the rest are settled for good."""
    t0, now = time.time(), now or time.time()
    recheck = datetime.fromtimestamp(now - RECHECK_H * 3600).isoformat(timespec='seconds')
    quiet = datetime.fromtimestamp(now - 1800, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    todo = [r[0] for r in con.execute(f"""SELECT s.session_id FROM sessions s LEFT JOIN git_outcomes g ON g.session_id = s.session_id
            WHERE s.last_ts < ? AND (g.session_id IS NULL OR (g.state = 'pending' AND g.checked_at < ?))
              AND EXISTS (SELECT 1 FROM tool_uses u WHERE u.session_id = s.session_id AND u.wrote IS NOT NULL)
            ORDER BY s.last_ts DESC""", (quiet, recheck))]
    repos, n = Repos(), 0
    for sid in todo[:limit] if limit else todo:
        if time.time() - t0 > budget_s:
            break
        state, r = outcome(con, sid, repos, now)
        con.execute('INSERT OR REPLACE INTO git_outcomes VALUES (?,?,?,?,?,?,?,?,?)',
                    (sid, datetime.fromtimestamp(now).isoformat(timespec='seconds'), state, ','.join(sorted(r['repos'])) or None,
                     r['files_edited'], r['files_committed'], r['lines_written'], r['lines_kept'], len(r['commits'])))
        n += 1
    con.commit()
    return n, len(todo)


# ---------- report ----------

COLUMNS = [('cost/prompt', 'cost_per_prompt'), ('corr/100', 'correction_rate'), ('intr/100', 'interrupt_rate'),
           ('rej/100', 'rejection_rate'), ('churn %', 'edit_churn'), ('check ok %', 'verify_pass'),
           ('checked %', 'verify_coverage'), ('kept %', 'edit_survival'), ('shipped %', 'files_shipped')]


def compare_table(rows, by, value, top=12, min_sessions=5):
    """Cost and quality side by side per group (model, effort, project, …): where a cheaper setting gives the same results."""
    groups = {}
    for r in rows:
        groups.setdefault(by(r) or '(none)', []).append(r)
    out = []
    for g, rs in sorted(groups.items(), key=lambda kv: -sum(r['cost'] for r in kv[1]))[:top]:
        if len(rs) < min_sessions:
            continue
        out.append([g, len(rs)] + [value(rs, k) for _, k in COLUMNS])
    return ['group', 'sessions'] + [c for c, _ in COLUMNS], out
