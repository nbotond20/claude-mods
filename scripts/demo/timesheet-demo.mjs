#!/usr/bin/env node
// Seeds an isolated timesheet home with a fictional engineer's September-October 2026 so the
// web app and CLI can be screenshotted without any real data. Nothing here reads ~/.claude*,
// git repos, calendars or GitHub.
//
//   node scripts/demo/timesheet-demo.mjs <demo-dir>
//   # then, with the environment it prints:
//   HOME=<demo-dir>/home TIMESHEET_HOME=<demo-dir>/home/.timesheet TIMESHEET_SECRETS=file \
//     PATH=<node dir>:/usr/bin:/bin node --experimental-sqlite --no-warnings timesheet/bin/timesheet.js serve --port 4391
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demo = resolve(process.argv[2] ?? 'ts-demo');
const home = join(demo, 'home');
// Only a folder this script made (or a new, empty one) is wiped; never a real home.
if (existsSync(demo) && readdirSync(demo).length && !existsSync(join(demo, '.timesheet-demo'))) {
  console.error(`${demo} is not empty and was not made by this script; pass a new folder`);
  process.exit(1);
}
rmSync(demo, { recursive: true, force: true });
mkdirSync(join(home, '.timesheet'), { recursive: true });
writeFileSync(join(demo, '.timesheet-demo'), '');
mkdirSync(join(home, '.claude', 'projects'), { recursive: true }); // empty: no real sessions
process.env.HOME = home;
process.env.TIMESHEET_HOME = join(home, '.timesheet');
process.env.TIMESHEET_SECRETS = 'file';
process.env.TZ = 'Europe/Berlin';

const core = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../timesheet/src/core/')).href;
const { defaultConfig, computeKey } = await import(core + 'config.ts');
const { CATEGORIES } = await import(new URL('../../timesheet/test/example-categories.ts', import.meta.url).href);
const { Store } = await import(core + 'store.ts');
const { addDays, daysBetween, dayBounds, weekday } = await import(core + 'dates.ts');

const config = {
  ...defaultConfig(),
  categories: CATEGORIES, // made up: real task lists are company specific
  claudeDirs: [join(home, '.claude', 'projects')],
  claudeHistory: false,
  opencodeDirs: [],
  authorEmails: ['alex.morgan@example.com'],
  projects: ['acme-web', 'billing-api', 'mobile-app', 'infra', 'Internal'],
  defaultProject: 'Internal',
  timezone: 'Europe/Berlin',
  scope: {
    work: [
      { path: '~/work/acme-web/**', project: 'acme-web' },
      { path: '~/work/billing-api/**', project: 'billing-api' },
      { path: '~/work/mobile-app/**', project: 'mobile-app' },
      { path: '~/work/infra/**', project: 'infra' },
    ],
    personal: ['~/side/**'],
  },
  // fictional hosts and rules, only so the Submission preview can show a plan
  submit: {
    redmine: { url: 'https://redmine.example.com/work_time/index', fillOnly: true, rules: [['acme-web', 4101], ['billing-api', 4102], ['mobile-app', 4103], ['infra', 4104], ['Internal', 4100]].map(([project, issueId]) => ({ project, category: '*', target: { issueId, activity: 'Development' } })) },
    netsuite: { url: 'https://timesheets.example.com/', fillOnly: true, rules: ['acme-web', 'billing-api', 'mobile-app', 'infra', 'Internal'].map((project) => ({ project, category: '*', target: { project: `ACME Portfolio : ${project}`, task: 'Delivery' } })) },
  },
};
writeFileSync(join(home, '.timesheet', 'config.json'), JSON.stringify(config, null, 2));
const key = computeKey(config);
const store = new Store();

// --- story catalogue: [project, category, summary, ticket, branch, commit subjects, prompts, edited files]
const S = {
  checkout: ['acme-web', 'Feature Build', 'Redesign the checkout page: new address step and order summary', 'ACME-1423', 'feature/ACME-1423-checkout-redesign', ['Add address step to checkout flow', 'Extract OrderSummary component', 'Wire shipping estimate into summary'], ['Split the checkout form into steps and keep the cart state in the URL', 'Why does the summary flash on step change?'], ['src/checkout/AddressStep.tsx', 'src/checkout/OrderSummary.tsx']],
  e2e: ['acme-web', 'QA', 'Playwright end-to-end tests for the cart and checkout', 'ACME-1431', 'test/ACME-1431-cart-e2e', ['Add cart e2e specs', 'Stabilise flaky coupon test'], ['Write a Playwright test for applying a coupon at checkout'], ['e2e/cart.spec.ts', 'e2e/fixtures/coupons.ts']],
  header: ['acme-web', 'Polish', 'Fix sticky header overlap on Safari and tidy nav spacing', 'ACME-1440', 'fix/ACME-1440-sticky-header', ['Fix sticky header on Safari 17'], ['The header overlaps the hero on Safari, find the cause'], ['src/layout/Header.css']],
  webhooks: ['billing-api', 'Connectors', 'Payment provider webhooks: signature checks and retry with backoff', 'BILL-208', 'feature/BILL-208-webhook-retries', ['Verify webhook signatures', 'Retry failed webhook handlers with backoff'], ['Add exponential backoff to the webhook consumer', 'Add a dead-letter table for webhooks that keep failing'], ['src/webhooks/consumer.ts', 'src/webhooks/retry.ts', 'migrations/0042_dead_letter.sql']],
  invoices: ['billing-api', 'Feature Build', 'Invoice PDF generation and monthly statement endpoint', 'BILL-219', 'feature/BILL-219-invoice-pdf', ['Render invoices to PDF', 'Add GET /statements/:month'], ['Generate an invoice PDF from the existing template'], ['src/invoices/pdf.ts', 'src/routes/statements.ts']],
  dupes: ['billing-api', 'Firefighting', 'Duplicate invoice emails after a queue redelivery', 'BILL-231', 'fix/BILL-231-duplicate-emails', ['Make invoice email sending idempotent', 'Add regression test for redelivery'], ['Customers got the invoice email twice, find out why'], ['src/mail/send-invoice.ts', 'test/mail.spec.ts']],
  sync: ['mobile-app', 'Feature Build', 'Offline sync queue: persist pending mutations and replay on reconnect', 'MOB-377', 'feature/MOB-377-offline-queue', ['Persist pending mutations in SQLite', 'Replay queue on reconnect', 'Handle conflicting edits'], ['Design a queue for offline edits that survives app restarts'], ['src/sync/queue.ts', 'src/sync/replay.ts']],
  links: ['mobile-app', 'Polish', 'Deep links from push notifications to the order screen', 'MOB-390', 'feat/MOB-390-push-deeplinks', ['Route push payloads to order screen'], ['Open the order screen when the push notification is tapped'], ['src/notifications/router.ts']],
  testflight: ['mobile-app', 'Release', 'Release 4.12: TestFlight build and store notes', 'MOB-401', 'release/4.12', ['Bump version to 4.12', 'Update release notes'], ['Prepare the 4.12 release checklist'], ['CHANGELOG.md', 'app.config.ts']],
  vpc: ['infra', 'Platform Build', 'Terraform: staging VPC peering and private subnets', 'INFRA-91', 'feature/INFRA-91-vpc-peering', ['Add VPC peering module', 'Private subnets for staging'], ['Peer the staging and shared-services VPCs without overlapping CIDRs'], ['modules/network/peering.tf', 'envs/staging/main.tf']],
  certs: ['infra', 'Platform Care', 'Rotate expiring TLS certificates and automate renewal checks', 'INFRA-97', 'chore/INFRA-97-cert-rotation', ['Rotate edge certificates', 'Add expiry alert'], ['List certificates that expire within 30 days'], ['modules/edge/certs.tf']],
  alerts: ['infra', 'Platform Care', 'Tune Grafana alerts: fewer pages, better runbook links', 'INFRA-102', 'chore/INFRA-102-alert-tuning', ['Raise error-rate alert threshold', 'Link runbooks from alerts'], ['Which alerts paged us most last month?'], ['dashboards/alerts.yaml']],
  review: ['acme-web', 'Discovery', 'Code reviews and technical notes for the checkout API contract', 'ACME-1423', '', [], ['Summarise the open comments on the checkout PR'], ['docs/checkout-api.md']],
};
const MEET = {
  standup: ['Daily standup', 'Meetings'],
  planning: ['Sprint planning', 'Meetings'],
  retro: ['Sprint retrospective', 'Meetings'],
  design: ['Checkout design sync', 'Specs'],
  oncall: ['Incident review: duplicate emails', 'Firefighting'],
  oneone: ['1:1 with Sam', 'Coordination'],
};
// weekday -> [start hh:mm, end, story | meeting:key]
const PLAN = {
  1: [['09:30', '09:45', 'm:standup'], ['09:45', '11:50', 'sync'], ['13:00', '14:30', 'm:planning'], ['14:30', '17:40', 'checkout']],
  2: [['09:30', '09:45', 'm:standup'], ['09:50', '12:30', 'checkout'], ['13:30', '15:00', 'webhooks'], ['15:00', '15:30', 'm:design'], ['15:30', '17:50', 'e2e']],
  3: [['09:30', '09:45', 'm:standup'], ['09:50', '12:20', 'webhooks'], ['13:20', '15:20', 'invoices'], ['15:30', '16:00', 'm:oneone'], ['16:00', '18:00', 'vpc']],
  4: [['09:30', '09:45', 'm:standup'], ['09:50', '12:00', 'sync'], ['12:00', '12:40', 'links'], ['13:40', '15:10', 'certs'], ['15:10', '17:40', 'checkout']],
  5: [['09:30', '09:45', 'm:standup'], ['09:50', '11:40', 'alerts'], ['11:40', '12:30', 'header'], ['13:30', '14:30', 'm:retro'], ['14:30', '16:50', 'testflight']],
};
const VARY = { // per-date story swaps so the weeks differ
  checkout: ['checkout', 'review', 'checkout'], webhooks: ['webhooks', 'dupes', 'invoices'], sync: ['sync', 'links', 'sync'], vpc: ['vpc', 'certs', 'alerts'], e2e: ['e2e', 'header', 'e2e'],
};
const OTHER = {
  '2026-09-16': ['Photo gallery side project', 'personal', '~/side/photo-gallery', 'Resize thumbnails in the gallery', 20, '19:10'],
  '2026-09-30': ['Dotfiles cleanup', 'personal', '~/side/dotfiles', 'Tidy shell aliases', 25, '20:00'],
  '2026-10-06': ['Photo gallery side project', 'personal', '~/side/photo-gallery', 'Add album sorting', 40, '19:30'],
  '2026-10-09': ['Photo gallery side project', 'personal', '~/side/photo-gallery', 'Fix EXIF orientation', 30, '19:00'],
  '2026-10-10': ['Weekend hack', 'personal', '~/side/photo-gallery', 'Album sorting follow-ups', 90, '10:30'],
};

const T = (date, hm) => { const [h, m] = hm.split(':').map(Number); return dayBounds(date)[0] + (h * 60 + m) * 60_000; };
const sha = (n) => (Math.imul(n, 2654435761) >>> 0).toString(16).padStart(8, '0') + '0c3f9a1e5d7b2468ace0f13579bdf2468ace0f13'.slice(8);
const wd = (p) => join('/Users/alex/work', p);

function build(date, day) {
  const blocks = [];
  let plan = PLAN[weekday(date)] ?? [];
  const seed = Number(date.replaceAll('-', '')) % 3;
  const low = date === '2026-10-02';
  if (low) plan = [['09:30', '09:45', 'm:standup'], ['10:00', '11:45', 'header'], ['11:45', '12:20', 'review']];
  plan.forEach(([a, b, what], i) => {
    const start = T(date, a), end = T(date, b), minutes = (end - start) / 60_000;
    const base = { id: blocks.length + 1, start, end, measured: Math.round(minutes * 0.93 * 100) / 100 };
    if (what.startsWith('m:')) {
      const [title, cat] = MEET[what.slice(2)];
      blocks.push({ ...base, kind: 'meeting', project: 'Internal', sources: ['calendar'], branches: [], paths: [], texts: [title], hint: 'Meetings', allocations: [{ category: cat, fraction: 1 }], summary: title, items: [] , measured: minutes });
      return;
    }
    let key = what; const v = VARY[what]; if (v && !low && date !== '2026-09-07') key = v[(seed + i) % 3];
    const [project, category, summary, ticket, branch, commits, prompts, files] = S[key];
    const path = wd(project);
    const n = commits.length;
    const sessions = [{ id: `0b${(start / 1e5 | 0).toString(16)}-demo-${i}`, source: 'claude', path, profile: join(home, '.claude') }];
    const cs = commits.map((s, k) => ({ hash: sha(start / 6e4 + k), repo: path, subject: `${ticket}: ${s}`, added: 40 + ((k * 37 + i * 11) % 160), removed: 5 + ((k * 13) % 50), files: files.slice(0, 2).map((f, j) => ({ path: f, added: 30 + j * 12, removed: 4 + j * 3 })) }));
    const work = { edits: files.map((f, j) => ({ path: f, added: 60 - j * 15, removed: 8 + j * 4 })), reads: 18 + i * 5, shell: 6 + i, web: i % 2, commands: ['pnpm test', 'git diff', 'pnpm lint'].slice(0, 2 + (i % 2)) };
    const item = { id: `${base.id}.1`, start, end, sources: n ? ['claude', 'git'] : ['claude'], path, branch: branch || undefined, sessions, commits: cs, work, texts: prompts, summary, measured: base.measured };
    // a small fake Claude Code transcript, so the "sessions" counts in Settings are not zero
    const tdir = join(home, '.claude', 'projects', path.replaceAll('/', '-')); mkdirSync(tdir, { recursive: true });
    prompts.forEach((text, k) => {
      const at = (ms) => new Date(ms).toISOString(); const t0 = start + k * 20 * 60_000;
      const line = (type, t, message) => JSON.stringify({ type, timestamp: at(t), cwd: path, gitBranch: branch, sessionId: sessions[0].id, message }) + '\n';
      appendFileSync(join(tdir, sessions[0].id + '.jsonl'), line('user', t0, { role: 'user', content: text }) + line('assistant', t0 + 90_000, { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }));
    });
    blocks.push({ ...base, kind: 'work', project, sources: item.sources, branches: branch ? [branch] : [], paths: [path], texts: [...prompts, ...commits.map((c) => `${ticket}: ${c}`)], hint: 'Feature Build', allocations: [{ category, fraction: 1 }], summary: `${ticket}: ${summary}`, sessions, commits: cs, items: [item] });
  });
  const other = [];
  if (OTHER[date]) {
    const [, kind, p, text, mins, at] = OTHER[date];
    const start = T(date, at);
    other.push({ id: 1, start, end: start + mins * 60_000, kind, sources: ['claude'], branches: [], paths: [p], texts: [text], summary: text, measured: mins, items: [] });
  }
  const meetings = blocks.filter((b) => b.kind === 'meeting').length;
  const prompts = blocks.reduce((s, b) => s + (b.items ?? []).reduce((t, it) => t + it.texts.length, 0), 0);
  const commits = blocks.reduce((s, b) => s + (b.commits?.length ?? 0), 0);
  const projects = [...new Set(blocks.filter((b) => b.kind === 'work').map((b) => b.project))];
  const summary = blocks.filter((b) => b.kind === 'work').map((b) => b.summary.replace(/^[A-Z]+-\d+: /, '')).join('; ') + '.';
  return { date, status: 'final', computedAt: new Date(Date.parse(date + 'T00:00:00Z') + 2 * 86400_000).toISOString(), blocks, summary, warnings: [], paths: {}, outOfOffice: false, computeKey: key, retry: false, activity: { prompts, commits, github: 0, meetings, repos: projects.length }, other, classifyKey: 'demo' + date };
}

const from = '2026-09-01', last = '2026-10-12';
for (const date of daysBetween(from, last)) {
  const w = weekday(date);
  if (w === 0 || w === 6) { if (OTHER[date]) store.saveDay({ ...build(date), blocks: [], summary: '', activity: { prompts: 0, commits: 0, github: 0, meetings: 0, repos: 0 } }); continue; }
  store.saveDay(build(date));
}
for (const date of daysBetween(from, '2026-10-01')) if (weekday(date) % 6) store.setMark(date, 'locked', true, 'submitted');
store.editHours('2026-10-06', 'billing-api', 'Connectors', 3);
store.editBlock('2026-10-07', 1, 'Meetings');
store.close();
console.log(`demo home: ${home}\nrun with:\n  HOME=${home} TIMESHEET_HOME=${home}/.timesheet TIMESHEET_SECRETS=file PATH=${dirname(process.execPath)}:/usr/bin:/bin TZ=Europe/Berlin \\\n  (unset CLAUDE_CONFIG_DIR XDG_DATA_HOME first) \\\n  node --experimental-sqlite --no-warnings timesheet/bin/timesheet.js serve --port 4391`);
