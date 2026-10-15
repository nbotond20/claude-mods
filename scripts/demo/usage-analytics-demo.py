#!/usr/bin/env python3
"""Fake but realistic Claude Code history for the docs screenshots.

Writes a throwaway HOME with two profiles (~/.claude-work, ~/.claude-personal), 45 days of transcripts
(prompts, requests, tool calls, subagents), usage-analytics mod events (steps, tools, context, compactions,
holdout arms and mod actions) and budget-guard savings ledgers. Nothing is read from the real machine.

  python3 scripts/demo/usage-analytics-demo.py /tmp/ua-demo
  HOME=/tmp/ua-demo CLAUDE_USAGE_PORT=8799 python3 usage-analytics/bin/claude-usage ingest
  HOME=/tmp/ua-demo CLAUDE_USAGE_PORT=8799 python3 usage-analytics/bin/claude-usage serve --open
"""
import json, os, random, sys, uuid
from datetime import datetime, timedelta, timezone

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'ua-demo')
# OUT becomes HOME for the CLI: never write fake profiles into a real home.
if os.path.isdir(OUT) and os.listdir(OUT) and not os.path.exists(os.path.join(OUT, '.ua-demo')):
    sys.exit(f'{OUT} is not empty and was not made by this script; pass a new folder')
os.makedirs(OUT, exist_ok=True)
open(os.path.join(OUT, '.ua-demo'), 'w').close()
DAYS = 45
rng = random.Random(42)
NOW = datetime.now(timezone.utc).replace(microsecond=0)

PROJECTS = {
    'work': [('acme-web', ['main', 'feat/checkout-v2', 'fix/cart-race', 'feat/search-facets'], 0.34),
             ('billing-api', ['main', 'feat/invoice-pdf', 'fix/proration'], 0.26),
             ('mobile-app', ['develop', 'feat/offline-sync', 'fix/push-tokens'], 0.18),
             ('infra', ['main', 'chore/terraform-1.9'], 0.12),
             ('design-system', ['main', 'feat/date-picker'], 0.10)],
    'personal': [('dotfiles', ['main'], 0.3), ('trail-planner', ['main', 'feat/gpx-import'], 0.45), ('blog', ['main'], 0.25)],
}
TITLES = ['Add Apple Pay to checkout', 'Fix race in cart quantity updates', 'Invoice PDF rendering with line items',
          'Proration for mid-cycle plan changes', 'Offline sync queue for orders', 'Refresh expired push tokens',
          'Search facets: brand and price range', 'Upgrade Terraform providers', 'Date picker keyboard navigation',
          'Flaky e2e test on payment step', 'Migrate auth middleware to edge runtime', 'Speed up CI test sharding',
          'Webhook retries with backoff', 'Dark mode tokens for charts', 'Add GPX import to route editor',
          'Write post about SQLite WAL mode', 'zsh prompt cleanup', 'Dedupe customer records by email',
          'Pagination for orders endpoint', 'Review PR #482 feedback', 'Rate limit login attempts',
          'Explain the billing reconciliation job', 'Storybook stories for Table', 'Fix timezone bug in reports']
PROMPTS = ['can you look at why the cart total flickers when quantity changes quickly?',
           'add a test for the proration edge case where the plan changes on the last day',
           'the invoice PDF cuts off long product names, wrap them instead',
           'refactor this into a hook, keep the public API the same',
           'run the tests and fix whatever fails', 'ok ship it, open a PR',
           'why is this query doing a full table scan?', 'make the date picker work with arrow keys and PageUp/PageDown',
           'summarize what changed on this branch since main', 'add retries with exponential backoff to the webhook sender',
           'looks good, now update the docs', 'can we avoid the N+1 in the orders list?',
           'use the existing formatMoney helper instead', 'what does the reconciliation job do, step by step?',
           'bump terraform aws provider to 6.x and fix the plan diff', 'write a short post outline about WAL mode',
           'the e2e test is flaky on CI only, find out why', 'add a GPX importer that keeps elevation data']

# Follow-ups from someone the last turn annoyed, mildest first: they feed the Frustration and Quality tabs.
ANNOYED = ['no, use the existing formatMoney helper instead', 'that is not what I asked, keep the public API the same',
           'it still flickers when I change the quantity', 'wait, revert that, the tests were passing before',
           'the same error again, did you even run the tests?', 'why did you delete the proration test?',
           'nooo, not the migration file', 'I already said: no new dependencies!!', 'how many times do I have to say it, the date picker needs PageUp too',
           'WHY IS THE CHECKOUT TEST STILL FAILING', 'you broke the invoice PDF again??? undo it',
           'wtf, the cart total is wrong now', 'forget it, I will do it myself', 'this is useless, stop changing the webhook sender']
REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected."

# Asks a person types again and again, each with several wordings and a few details that change (paths, branches, numbers).
RECURRING = [
    ('release', 0.035, ['bump the version to {ver}, update the changelog and tag the release',
                        'cut a release {ver}: version bump, changelog entry, tag it',
                        'please bump version to {ver} and add a changelog entry, then tag',
                        'prepare release {ver} - bump version, changelog, tag']),
    ('ci', 0.03, ['check why CI failed on {branch} and fix it',
                  'CI is red on {branch}, find out why it failed and fix it',
                  'why did the CI run fail on branch {branch}? fix it',
                  'look at the failing CI checks on {branch} and fix them']),
    ('pr', 0.03, ['write the PR description for this branch',
                  'write a PR description for {branch}, summarize the changes and the test plan',
                  'draft the pull request description for this branch']),
    ('tests', 0.025, ['run the tests and fix what fails',
                      'run the test suite and fix whatever fails',
                      'run all tests, then fix the failures']),
    ('snap', 0.015, ['update the snapshot tests', 'the snapshots are outdated, update the snapshot tests',
                     'update snapshots in {file} and rerun']),
    ('lint', 0.02, ['fix the lint errors and the type errors', 'run lint and tsc and fix all errors',
                    'fix lint and type check errors in {file}']),
    ('changes', 0.02, ['summarize what changed since {branch}', 'summarize the changes on this branch since main',
                       'what changed on this branch compared to main? short summary']),
    ('dep', 0.012, ['upgrade the dependencies in {file} and fix what breaks',
                    'bump outdated dependencies, then fix the breakage']),
]
FILES = {'acme-web': ['src/cart/CartLine.tsx', 'src/cart/useCart.ts', 'src/checkout/ApplePay.tsx', 'src/search/Facets.tsx', 'src/api/client.ts', 'e2e/checkout.spec.ts'],
         'billing-api': ['app/invoices/pdf.py', 'app/billing/proration.py', 'app/webhooks/sender.py', 'tests/test_proration.py', 'app/models.py'],
         'mobile-app': ['src/sync/queue.ts', 'src/push/tokens.ts', 'src/screens/Orders.tsx', 'ios/Podfile'],
         'infra': ['modules/vpc/main.tf', 'envs/prod/main.tf', 'versions.tf'],
         'design-system': ['src/DatePicker/DatePicker.tsx', 'src/DatePicker/keyboard.ts', 'src/Table/Table.stories.tsx'],
         'dotfiles': ['.zshrc', 'starship.toml'], 'trail-planner': ['src/gpx/import.ts', 'src/routes/Editor.tsx'],
         'blog': ['posts/sqlite-wal.md']}
BASH = ['npm test', 'npm run lint', 'npx tsc --noEmit', 'git status', 'git diff --stat', 'git log --oneline -n 20',
        'pytest -q', 'pytest tests/test_proration.py -q', 'gh pr create --fill', 'gh pr view 482', 'terraform plan',
        'docker compose up -d db', 'npm run build', 'rg -n "formatMoney" src', 'ls -la']
SKILLS = ['systematic-debugging', 'test-driven-development', 'timesheet', 'frontend-design']
MCP = ['mcp__github__get_pull_request', 'mcp__linear__get_issue', 'mcp__sentry__get_issue']
PRICE = {'opus': (4, 20, 0.2, 5), 'sonnet': (2, 10, 0.2, 2.5), 'haiku': (0.1, 0.5, 0.01, 0.125), 'fable': (10, 50, 0.25, 12.5)}
MODEL = {'opus': 'claude-opus-5-5', 'sonnet': 'claude-sonnet-5-5', 'haiku': 'claude-haiku-5-5', 'fable': 'claude-fable-5-1'}
HOLDOUT = {'budget-guard': 0.10, 'lean-tools': 0.20, 'lsp-first': 0.20}
EFFECT = {'budget-guard': 1.30, 'lean-tools': 1.16, 'lsp-first': 1.10}  # holdout sessions cost this much more per prompt


def iso(t):
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f'{t.microsecond // 1000:03d}Z'


def ms(t):
    return int(t.timestamp() * 1000)


def cost(fam, inp, out, cr, cw):
    p = PRICE[fam]
    return (inp * p[0] + out * p[1] + cr * p[2] + cw * p[3]) / 1e6


class Writer:
    def __init__(self):
        self.events = {}
        self.ledgers = []

    def ev(self, profile, sid, t, ev, **data):
        key = (profile, t.astimezone().strftime('%Y-%m-%d'), sid)
        self.events.setdefault(key, []).append({'ts': ms(t), 'ev': ev, 'sid': sid, 'profile': profile, **data})

    def flush(self):
        base = os.path.join(OUT, '.claude-mods', 'usage-analytics', 'events')
        for (profile, day, sid), rows in self.events.items():
            d = os.path.join(base, profile, day)
            os.makedirs(d, exist_ok=True)
            rows.sort(key=lambda r: r['ts'])
            with open(os.path.join(d, f"{sid}.{rows[0]['ts']}.demo.jsonl"), 'w') as f:
                f.write(''.join(json.dumps(r) + '\n' for r in rows))
        d = os.path.join(OUT, '.claude-mods', 'budget-guard', 'sessions')
        os.makedirs(d, exist_ok=True)
        for j in self.ledgers:
            json.dump(j, open(os.path.join(d, j['id'] + '.json'), 'w'))


W = Writer()


def tool_call(proj, cwd, fam_main):
    r = rng.random()
    files = FILES[proj]
    if r < 0.30:
        f = rng.choice(files)
        inp = {'file_path': f'{cwd}/{f}'}
        if rng.random() < 0.55:
            inp.update(offset=rng.randint(1, 300), limit=rng.choice([40, 80, 120]))
        return 'Read', inp, rng.randint(1500, 14000) if 'offset' not in inp else rng.randint(600, 4000)
    if r < 0.48:
        return 'Bash', {'command': rng.choice(BASH)}, rng.choice([300, 900, 2400, 6000, 18000, 24000])
    if r < 0.62:
        return 'Edit', {'file_path': f'{cwd}/{rng.choice(files)}', 'old_string': 'x' * 80, 'new_string': 'y' * 120}, 200
    if r < 0.70:
        return 'Grep', {'pattern': rng.choice(['formatMoney', 'useCart', 'def prorate', 'TODO', 'retry']), 'output_mode': 'content'}, rng.randint(400, 5000)
    if r < 0.79:
        return 'LSP', {'operation': rng.choice(['findReferences', 'goToDefinition', 'hover', 'documentSymbol'])}, rng.randint(200, 1800)
    if r < 0.83:
        return 'Write', {'file_path': f'{cwd}/{rng.choice(files)}', 'content': 'z' * 1500}, 120
    if r < 0.86:
        return 'Glob', {'pattern': '**/*.test.ts'}, 600
    if r < 0.89:
        return 'Skill', {'skill': rng.choice(SKILLS)}, 3000
    if r < 0.92:
        return rng.choice(MCP), {'id': 'ENG-1042'}, rng.randint(800, 6000)
    if r < 0.95:
        return 'WebFetch', {'url': rng.choice(['https://developer.mozilla.org/en-US/docs/Web/API', 'https://docs.python.org/3/library/sqlite3.html', 'https://registry.terraform.io/providers/hashicorp/aws'])}, 9000
    if r < 0.97:
        return 'WebSearch', {'query': 'stripe proration mid cycle invoice'}, 4000
    return 'TodoWrite', {'todos': []}, 100


ONE_VERB = ['add', 'remove', 'rename', 'extract', 'inline', 'memoize', 'validate', 'paginate', 'debounce', 'log', 'cache', 'sort', 'translate', 'animate',
            'throttle', 'split', 'merge', 'document', 'benchmark', 'profile', 'harden', 'simplify', 'migrate', 'mock', 'typecheck', 'stub', 'batch', 'index']
ONE_NOUN = ['the cart badge', 'user avatars', 'the export button', 'the settings modal', 'the invoice footer', 'search suggestions', 'the retry queue',
            'the onboarding checklist', 'currency rounding', 'the tooltip', 'the sidebar state', 'webhook signatures', 'the CSV importer', 'dark mode colors',
            'the pricing table', 'session timeouts', 'the audit log', 'the map markers', 'email templates', 'the upload progress bar', 'the refund flow',
            'tax rules', 'the coupon field', 'feature flags', 'the date range filter', 'push token refresh', 'the elevation chart', 'the tag cloud',
            'rate limit headers', 'the health endpoint', 'the nightly cleanup job', 'locale fallbacks', 'the drag handle', 'keyboard shortcuts', 'the cron parser']
ONE_WHY = ['it flickers on first load', 'support asked for it', 'we saw timeouts in prod last week', 'the old version confuses new users',
           'a customer reported wrong totals', 'it is slow with 10k rows', 'the design changed on Monday', 'QA found a crash on Safari',
           'it leaks memory after a long session', 'the API now returns nulls', 'we are dropping Node 18', 'legal wants it logged',
           'the spec says otherwise', 'it breaks the build on Windows', 'it is hard to test']
ONE_ADJ = ['', '', 'old', 'new', 'legacy', 'shared', 'mobile', 'admin', 'public', 'cached', 'nested', 'async', 'offline', 'beta']
ONE_AFTER = ['', '', ' for the Q4 launch', ' before the freeze', ' like we did for billing', ' for the Berlin office', ' per the RFC',
             ' for the partner API', ' on the staging box', ' after the migration', ' for large accounts', ' with the new copy']
ONE_FORM = ['{v} {n} in {f}, {w}', '{w}, so {v} {n} ({f})', 'can you {v} {n}? {w}', 'in {f}: {v} {n} because {w}', '{v} {n}. context: {w}',
            'I think we should {v} {n} - {w}. look at {f} first']


def one_off(proj):
    return (rng.choice(ONE_FORM).format(v=rng.choice(ONE_VERB), n=(rng.choice(ONE_ADJ) + ' ' + rng.choice(ONE_NOUN)).strip(), w=rng.choice(ONE_WHY), f=rng.choice(FILES[proj])) + rng.choice(ONE_AFTER))


def ask_text(proj, branch, t):
    r = rng.random()
    acc = 0.0
    for fam, share, variants in RECURRING:
        acc += share * 1.6
        if r < acc:
            if fam == 'changes' and t > NOW - timedelta(days=21):   # automated three weeks ago: the ask stopped
                return one_off(proj)
            return rng.choice(variants).format(ver=f'{rng.randint(1, 4)}.{rng.randint(0, 19)}.{rng.randint(0, 9)}', branch=branch,
                                                file=rng.choice(FILES[proj]))
    return rng.choice(PROMPTS) if r < acc + 0.08 else one_off(proj)


def session(profile, start, proj, branch, arms, live=False):
    sid = str(uuid.UUID(int=rng.getrandbits(128)))
    cwd = f'{OUT}/code/{proj}'
    pdir = os.path.join(OUT, '.' + profile, 'projects', '-' + cwd.strip('/').replace('/', '-'))
    os.makedirs(pdir, exist_ok=True)
    lines = []
    mult = 1.0
    for mod, arm in arms.items():
        if arm == 'holdout':
            mult *= EFFECT[mod]
    fam_main = rng.choices(['opus', 'sonnet', 'fable'], [0.72, 0.24, 0.04])[0]
    effort = rng.choices(['medium', 'high', 'low'], [0.7, 0.2, 0.1])[0]
    common = {'sessionId': sid, 'cwd': cwd, 'gitBranch': branch, 'version': rng.choice(['2.3.4', '2.3.5', '2.3.7']), 'entrypoint': 'cli', 'userType': 'external'}
    t = start
    n_prompts = rng.randint(2, 9) if not live else 4
    ctx = rng.randint(18000, 26000)
    total, prompts_n, tool_bytes = 0.0, 0, 0
    parent = None
    W.ev(profile, sid, t, 'session_start', configDir=f'{OUT}/.{profile}')
    for mod, arm in arms.items():
        W.ev(profile, sid, t, 'mod', mod=mod, kind='arm', arm=arm, holdout=HOLDOUT[mod])
        if arm == 'on' and mod in ('lean-tools', 'lsp-first'):
            W.ev(profile, sid, t, 'mod', mod=mod, kind='guide', arm=arm, chars=rng.randint(600, 900))
        if arm == 'on' and mod == 'lsp-first':
            W.ev(profile, sid, t, 'mod', mod=mod, kind='schema_upfront', arm=arm, chars=1900)
        if arm == 'on' and mod == 'budget-guard':   # its Haiku classifier and keep-alive pings: Mod spend
            W.ev(profile, sid, t, 'mod', mod=mod, kind='classify', arm=arm, purpose='route', model='claude-haiku-5-5', inputChars=rng.randint(300, 4000))
            if rng.random() < 0.4:
                W.ev(profile, sid, t + timedelta(minutes=20), 'mod', mod=mod, kind='classify', arm=arm, purpose='new_task', model='claude-haiku-5-5', inputChars=rng.randint(400, 900))
            if rng.random() < 0.15:
                tok = rng.randint(60000, 140000)
                W.ev(profile, sid, t + timedelta(minutes=40), 'mod', mod=mod, kind='keepalive', arm=arm, model=MODEL['opus'], tokens=tok, cacheRead=tok - 200,
                     cacheWrite=200, input=16, output=4, costUsd=round(tok * 0.2e-6 + 200 * 5e-6, 4), hit=True)
    cats = [('System prompt', 3100), ('System tools', 14800), ('MCP tools', rng.choice([1200, 2600, 4100])), ('Custom agents', 650),
            ('Memory files', rng.randint(900, 2400)), ('Skills', 2300), ('Messages', 0)]
    W.ev(profile, sid, t, 'context', why='start', totalTokens=sum(c[1] for c in cats), rawMaxTokens=1000000,
         categories=[{'name': n, 'tokens': v} for n, v in cats])
    W.ev(profile, sid, t, 'system_prompt', model=MODEL[fam_main], chars=sum(c[1] for c in cats[:2]) * 4,
         sections=[{'id': s, 'chars': c} for s, c in [('identity', 1200), ('tone', 2600), ('tools', 6400), ('env', 900), ('claude_md', 5200), ('mods', 2100)]])
    annoy = {'opus': 0.12, 'sonnet': 0.2, 'fable': 0.08}[fam_main] * (1.6 if start.astimezone().hour >= 17 else 1.0)
    for i in range(n_prompts):
        text = ask_text(proj, branch, t)
        if i and rng.random() < annoy:
            text = ANNOYED[min(len(ANNOYED) - 1, int(rng.random() ** 1.8 * len(ANNOYED)))]
            if rng.random() < 0.3:
                lines.append({**common, 'type': 'user', 'uuid': str(uuid.uuid4()), 'parentUuid': parent, 'timestamp': iso(t - timedelta(seconds=20)),
                              'message': {'role': 'user', 'content': '[Request interrupted by user]'}})
        if i == 0 and rng.random() < 0.25:
            text = f'<command-name>/{rng.choice(["review", "budget", "analytics", "timesheet", "lean status"])}</command-name>'
        u = str(uuid.uuid4())
        lines.append({**common, 'type': 'user', 'uuid': u, 'parentUuid': parent, 'timestamp': iso(t), 'message': {'role': 'user', 'content': text}})
        parent = u
        prompts_n += 1
        steps = rng.randint(2, 11)
        for s in range(steps):
            t += timedelta(seconds=rng.randint(4, 35))
            if live and t > NOW - timedelta(seconds=20):
                break
            cw = rng.randint(800, 6000)
            cr = int(ctx * mult)
            out = int(rng.randint(150, 2200) * mult)
            mid = 'msg_' + uuid.uuid4().hex[:24]
            ntools = 0 if s == steps - 1 else rng.choices([1, 2, 3, 4], [0.55, 0.25, 0.13, 0.07])[0]
            blocks = [{'type': 'text', 'text': 'Working on it.' * rng.randint(1, 20)}]
            calls = []
            for _ in range(ntools):
                name, inp, res = tool_call(proj, cwd, fam_main)
                if arms.get('lean-tools') == 'holdout' and name == 'Bash':
                    res = int(res * 1.6)
                tid = 'toolu_' + uuid.uuid4().hex[:22]
                blocks.append({'type': 'tool_use', 'id': tid, 'name': name, 'input': inp})
                calls.append((tid, name, inp, res))
            if s == 1 and rng.random() < 0.35:
                tid = 'toolu_' + uuid.uuid4().hex[:22]
                at = rng.choice(['Explore', 'general-purpose', 'Plan'])
                blocks.append({'type': 'tool_use', 'id': tid, 'name': 'Agent', 'input': {'subagent_type': at, 'description': 'Find usages', 'prompt': 'Find every caller of the cart total', 'model': 'haiku' if at == 'Explore' else None}})
                total += subagent(profile, pdir, sid, common, t, at, tid, proj, cwd)
                calls.append((tid, 'Agent', {}, 2400))
            fam = fam_main if rng.random() > 0.05 else 'haiku'
            usage = {'input_tokens': rng.randint(3, 40), 'output_tokens': out, 'cache_read_input_tokens': cr,
                     'cache_creation_input_tokens': cw, 'cache_creation': {'ephemeral_5m_input_tokens': cw, 'ephemeral_1h_input_tokens': 0},
                     'service_tier': 'standard', 'speed': 'standard'}
            lines.append({**common, 'type': 'assistant', 'uuid': str(uuid.uuid4()), 'parentUuid': parent, 'timestamp': iso(t), 'requestId': 'req_' + uuid.uuid4().hex[:20],
                          'effort': effort, 'message': {'id': mid, 'model': MODEL[fam], 'role': 'assistant', 'content': blocks,
                                                        'stop_reason': 'tool_use' if calls else 'end_turn', 'usage': usage}})
            c = cost(fam, usage['input_tokens'], out, cr, cw)
            total += c
            W.ev(profile, sid, t, 'step', model=MODEL[fam], effort=effort, index=s, usage={'in': usage['input_tokens'], 'out': out, 'cr': cr, 'cw': cw},
                 stop='tool_use' if calls else 'end_turn', ms=rng.randint(2500, 28000), ttftMs=int(rng.lognormvariate(7.0, 0.35)) + (600 if fam == 'opus' else 0), answerChars=len(blocks[0]['text']))
            ctx += cw + out
            for tid, name, inp, res in calls:
                t += timedelta(seconds=rng.uniform(0.3, 6))
                err = rng.random() < 0.04
                no = name in ('Bash', 'Edit', 'Write') and rng.random() < annoy / 6
                lines.append({**common, 'type': 'user', 'uuid': str(uuid.uuid4()), 'parentUuid': parent, 'timestamp': iso(t),
                              'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tid, 'is_error': err or no,
                                                                       'content': REJECTED if no else 'r' * res}]}})
                tool_bytes += res
                ctx += res // 4
                W.ev(profile, sid, t, 'tool', tool=name, ms=rng.randint(40, 9000 if name == 'Bash' else 900), inChars=len(json.dumps(inp)), resultChars=res, isError=err)
                if name == 'Bash' and res >= 18000:
                    if arms.get('lean-tools') == 'on':
                        W.ev(profile, sid, t, 'mod', mod='lean-tools', kind='cap', arm='on', bytesAll=res * 3, bytesKept=res)
                    if arms.get('budget-guard') == 'on' and rng.random() < 0.5:
                        W.ev(profile, sid, t, 'mod', mod='budget-guard', kind='trim', arm='on', bytesAll=res * 2, bytesKept=res // 2)
                if name == 'Grep' and arms.get('lsp-first'):
                    arm = arms['lsp-first']
                    if arm == 'on':
                        W.ev(profile, sid, t, 'mod', mod='lsp-first', kind='nudge', arm=arm, nudge='grep-symbol', chars=240)
                    W.ev(profile, sid, t, 'mod', mod='lsp-first', kind='nudge_outcome', arm=arm, nudge='grep-symbol', followed=int(rng.random() < (0.7 if arm == 'on' else 0.3)), total=1)
                if name == 'Read' and 'offset' not in inp and arms.get('lean-tools'):
                    arm = arms['lean-tools']
                    W.ev(profile, sid, t, 'mod', mod='lean-tools', kind='nudge_outcome', arm=arm, nudge='ranged-read', followed=int(rng.random() < (0.62 if arm == 'on' else 0.35)), total=1)
            if ctx > 200000:
                before = ctx
                ctx = rng.randint(30000, 48000)
                W.ev(profile, sid, t, 'compact', trigger='auto', tokensBefore=before, tokensAfter=ctx, ms=rng.randint(18000, 60000))
                lines.append({**common, 'type': 'system', 'subtype': 'compact_boundary', 'uuid': str(uuid.uuid4()), 'timestamp': iso(t), 'compactMetadata': {'trigger': 'auto', 'preTokens': before}})
        W.ev(profile, sid, t, 'measure', context={'tokens': ctx, 'percent': round(100 * ctx / 1000000, 1)}, costUsd=round(total, 4),
             rateLimits={'five_hour': {'used_percentage': rng.randint(5, 60)}, 'seven_day': {'used_percentage': rng.randint(10, 70)}})
        if live and t > NOW - timedelta(seconds=30):
            break
        t += timedelta(seconds=rng.randint(30, 600))
    if rng.random() < 0.08:
        lines.append({**common, 'type': 'system', 'subtype': 'api_error', 'uuid': str(uuid.uuid4()), 'timestamp': iso(t), 'error': {'status': 529, 'message': 'Overloaded'}, 'retryAttempt': 1})
    lines.append({'type': 'ai-title', 'sessionId': sid, 'aiTitle': rng.choice(TITLES)})
    lines.append({'type': 'cost-state', 'sessionId': sid, 'totalCostUSD': round(total, 4), 'totalAPIDuration': rng.randint(60000, 900000),
                  'totalToolDuration': rng.randint(20000, 300000), 'totalDuration': int((t - start).total_seconds() * 1000),
                  'totalLinesAdded': rng.randint(5, 600), 'totalLinesRemoved': rng.randint(0, 250)})
    with open(os.path.join(pdir, sid + '.jsonl'), 'w') as f:
        f.write(''.join(json.dumps(x) + '\n' for x in lines))
    if 'budget-guard' in arms:
        on = arms['budget-guard'] == 'on'
        saved = {}
        if on:
            saved['route-agents'] = {'usd': round(total * rng.uniform(0.04, 0.09), 4), 'count': rng.randint(1, 4)}
            if fam_main != 'opus':
                saved['route-session'] = {'usd': round(total * rng.uniform(0.25, 0.45), 4), 'count': 1}
            if rng.random() < 0.4:
                saved['output-trim'] = {'usd': round(rng.uniform(0.05, 0.6), 4), 'count': rng.randint(1, 5)}
            if rng.random() < 0.2:
                saved['new-task'] = {'usd': round(rng.uniform(0.4, 2.5), 4), 'count': 1}
            if rng.random() < 0.15:
                saved['guards'] = {'usd': round(rng.uniform(0.05, 0.4), 4), 'count': rng.randint(1, 3)}
        W.ledgers.append({'profile': profile, 'id': sid, 'day': start.astimezone().strftime('%Y-%m-%d'), 'spent': round(total, 4),
                          'spentByDay': {start.astimezone().strftime('%Y-%m-%d'): round(total, 4)}, 'saved': saved, 'arm': arms['budget-guard']})
    return t


def subagent(profile, pdir, sid, common, t, agent_type, tool_use_id, proj, cwd):
    aid = uuid.uuid4().hex[:17]
    d = os.path.join(pdir, sid, 'subagents')
    os.makedirs(d, exist_ok=True)
    fam = 'haiku' if agent_type == 'Explore' else rng.choice(['sonnet', 'opus'])
    json.dump({'agentType': agent_type, 'description': 'Find usages', 'toolUseId': tool_use_id, 'spawnDepth': 1}, open(os.path.join(d, f'agent-{aid}.meta.json'), 'w'))
    lines, total, ctx = [], 0.0, 12000
    lines.append({**common, 'type': 'user', 'uuid': str(uuid.uuid4()), 'parentUuid': None, 'isSidechain': True, 'agentId': aid, 'timestamp': iso(t),
                  'message': {'role': 'user', 'content': 'Find every caller of the cart total and report file:line'}})
    for s in range(rng.randint(3, 9)):
        t += timedelta(seconds=rng.randint(2, 9))
        out, cw = rng.randint(100, 900), rng.randint(500, 4000)
        name, inp, res = tool_call(proj, cwd, fam)
        tid = 'toolu_' + uuid.uuid4().hex[:22]
        lines.append({**common, 'type': 'assistant', 'uuid': str(uuid.uuid4()), 'isSidechain': True, 'agentId': aid, 'timestamp': iso(t),
                      'message': {'id': 'msg_' + uuid.uuid4().hex[:24], 'model': MODEL[fam], 'content': [{'type': 'tool_use', 'id': tid, 'name': name, 'input': inp}],
                                  'stop_reason': 'tool_use', 'usage': {'input_tokens': 10, 'output_tokens': out, 'cache_read_input_tokens': ctx, 'cache_creation_input_tokens': cw}}})
        lines.append({**common, 'type': 'user', 'uuid': str(uuid.uuid4()), 'isSidechain': True, 'agentId': aid, 'timestamp': iso(t),
                      'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': tid, 'content': 'r' * res}]}})
        total += cost(fam, 10, out, ctx, cw)
        ctx += cw + res // 4
    with open(os.path.join(d, f'agent-{aid}.jsonl'), 'w') as f:
        f.write(''.join(json.dumps(x) + '\n' for x in lines))
    return total


def headless(profile, t, cwd, model, ctx, out, entry='sdk-cli', n=1, agent=None, sid=None):
    """A run nobody typed a prompt for: claude -p / SDK (its own session) or a mod's agent (inside a session)."""
    sid = sid or str(uuid.UUID(int=rng.getrandbits(128)))
    pdir = os.path.join(OUT, '.' + profile, 'projects', '-' + cwd.strip('/').replace('/', '-').replace('.', '-'))
    common = {'sessionId': sid, 'cwd': cwd, 'version': '2.3.7', 'entrypoint': entry, 'userType': 'external'}
    lines, total = [{**common, 'type': 'user', 'uuid': str(uuid.uuid4()), 'timestamp': iso(t), 'message': {'role': 'user', 'content': 'Classify this work log.'}}], 0.0
    for _ in range(n):
        t += timedelta(seconds=rng.randint(3, 20))
        cw = int(ctx * rng.uniform(0.85, 1.15))
        o = int(out * rng.uniform(0.6, 1.4))
        lines.append({**common, 'type': 'assistant', 'uuid': str(uuid.uuid4()), 'timestamp': iso(t), 'requestId': 'req_' + uuid.uuid4().hex[:20],
                      'message': {'id': 'msg_' + uuid.uuid4().hex[:24], 'model': MODEL[model], 'role': 'assistant', 'content': [{'type': 'text', 'text': '{}'}],
                                  'stop_reason': 'end_turn', 'usage': {'input_tokens': 4, 'output_tokens': o, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': cw}}})
        total += cost(model, 4, o, 0, cw)
    os.makedirs(pdir, exist_ok=True)
    if agent:
        d = os.path.join(pdir, sid, 'subagents')
        os.makedirs(d, exist_ok=True)
        aid = uuid.uuid4().hex[:17]
        json.dump({'agentType': agent, 'description': agent, 'toolUseId': 'toolu_' + uuid.uuid4().hex[:22], 'spawnDepth': 1}, open(os.path.join(d, f'agent-{aid}.meta.json'), 'w'))
        lines = [{**x, 'isSidechain': True, 'agentId': aid, 'entrypoint': 'cli'} for x in lines]
        path = os.path.join(d, f'agent-{aid}.jsonl')
    else:
        path = os.path.join(pdir, sid + '.jsonl')
    with open(path, 'w') as f:
        f.write(''.join(json.dumps(x) + '\n' for x in lines))
    return total


def background(today):
    """The timesheet classifier once a workday (sent Claude Code's whole prompt until 9 days ago), a nightly SDK script and the advisor now and then."""
    for back in range(DAYS, 0, -1):
        day = today - timedelta(days=back)
        if day.weekday() < 5:
            lean = back <= 9
            headless('claude-work', day + timedelta(hours=18, minutes=rng.randint(0, 50)), f'{OUT}/.timesheet/classifier', 'sonnet',
                     rng.randint(3200, 3900) if lean else rng.randint(26000, 36000), rng.randint(500, 1400))
            if rng.random() < 0.5:   # a recompute after an edit
                headless('claude-work', day + timedelta(hours=19, minutes=rng.randint(0, 50)), f'{OUT}/.timesheet/classifier', 'sonnet',
                         rng.randint(3200, 3900) if lean else rng.randint(26000, 36000), rng.randint(500, 1400))
        for _ in range(rng.randint(0, 2)):
            headless('claude-work', day + timedelta(hours=2, minutes=rng.randint(0, 120)), f'{OUT}/code/billing-api', 'sonnet', rng.randint(20000, 45000),
                     rng.randint(400, 2000), entry='sdk-py', n=rng.randint(3, 7))
        if back % 7 == 3:
            headless('claude-work', day + timedelta(hours=10), f'{OUT}/code/acme-web', 'sonnet', rng.randint(20000, 40000), rng.randint(800, 2500),
                     entry='cli', n=rng.randint(6, 14), agent='usage-analytics:advisor')
        if back % 11 == 5:
            headless('claude-work', day + timedelta(hours=11), f'{OUT}/code/acme-web', 'sonnet', rng.randint(15000, 25000), rng.randint(1500, 3000),
                     entry='cli', n=rng.randint(2, 4), agent='usage-analytics:recurring')


def main():
    for profile in ('claude-work', 'claude-personal'):
        os.makedirs(os.path.join(OUT, '.' + profile, 'projects'), exist_ok=True)
    today = NOW.astimezone().replace(hour=0, minute=0, second=0)
    for back in range(DAYS, -1, -1):
        day = today - timedelta(days=back)
        weekend = day.weekday() >= 5
        ramp = 0.7 + 0.5 * (DAYS - back) / DAYS  # usage grows over the period
        plan = []
        if not weekend:
            plan += [('claude-work', rng.uniform(8.5, 18.0)) for _ in range(max(2, int(rng.randint(8, 13) * ramp)))]
        if weekend or rng.random() < 0.35:
            plan += [('claude-personal', rng.uniform(19.0, 22.5) if not weekend else rng.uniform(10, 18)) for _ in range(rng.randint(2, 4))]
        for profile, hour in plan:
            start = day + timedelta(hours=hour)
            if start.astimezone(timezone.utc) > NOW - timedelta(minutes=50):
                continue
            projs = PROJECTS['work' if profile == 'claude-work' else 'personal']
            proj, branches, _ = rng.choices(projs, [p[2] for p in projs])[0]
            arms = {m: 'holdout' if rng.random() < h else 'on' for m, h in HOLDOUT.items()}
            session(profile, start, proj, rng.choice(branches), arms)
    background(today)
    # sessions running right now, for the Live tab
    for proj, branch, mins in (('acme-web', 'feat/checkout-v2', 42), ('billing-api', 'feat/invoice-pdf', 18)):
        session('claude-work', NOW - timedelta(minutes=mins), proj, branch, {m: 'on' for m in HOLDOUT}, live=True)
    for tool, chars, deferred in [('Bash', 4200, 0), ('Read', 2100, 0), ('Edit', 1800, 0), ('Write', 900, 0), ('Grep', 2600, 0), ('Glob', 700, 0),
                                  ('Agent', 5200, 0), ('LSP', 1900, 0), ('WebFetch', 1100, 1), ('WebSearch', 900, 1), ('mcp__github__get_pull_request', 650, 1)]:
        W.ev('claude-work', 'schema', NOW - timedelta(hours=1), 'tool_schema', tool=tool, chars=chars, deferred=deferred)
    W.flush()
    cfg = os.path.join(OUT, '.claude-mods', 'usage-analytics', 'config.json')
    json.dump({'profileDirs': [f'{OUT}/.claude-work', f'{OUT}/.claude-personal'], 'port': 8799, 'dashboard': 'on-demand'}, open(cfg, 'w'))
    print(OUT)


main()
