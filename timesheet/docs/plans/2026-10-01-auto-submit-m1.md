# Auto-submission, milestone 1: core, browser, inspect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the Redmine/NetSuite submission needs that does not depend on the real pages: mapping config, a pure planner and differ, run/catalog storage, a locked headed Chrome with its own profile, and `timesheet submit login|inspect|plan`, so the user can log in and capture sanitized page snapshots for milestone 2 (adapters, run orchestration, web UI).

**Architecture:** New folder `src/core/submit/`. `plan.ts` turns a week's `DayReport`s plus mapping rules into cells to write (or blocking reasons); `diff.ts` compares a plan with what a site holds and only ever allows writing into empty cells. `browser.ts` launches the installed Chrome through `playwright-core` with a profile in `~/.timesheet/browser` and a pid lock. `sanitize.ts` runs inside the page to produce a DOM copy without scripts, hidden-field values (CSRF tokens) or e-mails. Spec: `docs/specs/2026-10-01-auto-submit-design.md`.

**Tech Stack:** TypeScript on Node ≥ 22.18 (type stripping, no build for tests), `node:test`, `node:sqlite`, `playwright-core` (new runtime dependency, external to the esbuild bundle, loaded lazily).

**Conventions:** Tests run with `npm test` (all `test/*.test.ts`); a single file with `node --experimental-sqlite --no-warnings --test test/submit.test.ts`. Typecheck with `npm run typecheck`. Do not commit; the user commits.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/submit/types.ts` (create) | Shared types: systems, targets, rules, cells, plans, snapshots, diffs |
| `src/core/submit/plan.ts` (create) | Pure planner + target/cell keys + `describeTarget` |
| `src/core/submit/diff.ts` (create) | Pure differ + fingerprint |
| `src/core/submit/browser.ts` (create) | pid lock, lazy playwright import, `openBrowser` |
| `src/core/submit/sanitize.ts` (create) | In-page DOM sanitizer |
| `src/core/submit/inspect.ts` (create) | Saves sanitized HTML + screenshot of the current page |
| `src/core/config.ts` (modify) | `submit` section: defaults, merge, validation |
| `src/core/store.ts` (modify) | `submit_catalog`, `submit_runs` tables |
| `src/core/jobs.ts` (modify) | export `alive` |
| `src/cli.ts` (modify) | `submit` command, usage, doctor lines |
| `package.json`, `scripts/build-cli.mjs` (modify) | dependency + external |
| `skill/SKILL.md`, `README.md` (modify) | docs; the skill may plan, never submit |
| `test/submit.test.ts` (create) | all tests for this milestone |

---

### Task 1: Dependency

**Files:** Modify `package.json`, `scripts/build-cli.mjs`

- [ ] **Step 1: Install**

Run: `npm install playwright-core@^1.63.0`
Expected: `package.json` gains `"dependencies": { "playwright-core": "^1.63.0" }`. Do not run `npx playwright install`: we use the installed Google Chrome (`channel: 'chrome'`).

- [ ] **Step 2: Keep it out of the bundle** (it ships its own assets and must be resolved at runtime)

In `scripts/build-cli.mjs` change `external: ['node:*'],` to:

```js
  // Loaded lazily by `timesheet submit`; ships assets that cannot be bundled.
  external: ['node:*', 'playwright-core'],
```

- [ ] **Step 3: Verify**

Run: `npm run build:cli && node -e "import('playwright-core').then(m => console.log(typeof m.chromium.launchPersistentContext))"`
Expected: build succeeds; prints `function`.

---

### Task 2: Shared types

**Files:** Create `src/core/submit/types.ts`

- [ ] **Step 1: Write the file**

```ts
export type SystemId = 'redmine' | 'netsuite';
export const SYSTEMS: SystemId[] = ['redmine', 'netsuite'];

/** A row in Redmine Worktime: the issue (by ID, never by position) and the activity to select. */
export interface RedmineTarget {
  issueId: number;
  activity: string;
}

/** A row in the NetSuite weekly timesheet: option texts of the project and task selects. */
export interface NetsuiteTarget {
  project: string;
  task: string;
}

export interface TargetOf {
  redmine: RedmineTarget;
  netsuite: NetsuiteTarget;
}

/** Maps booked (project, category) to a row on the site. category "*" = any category of that project; an exact rule wins. */
export interface SubmitRule<T> {
  project: string;
  category: string;
  target: T;
}

export interface SubmitSystemConfig<T> {
  /** Start page, e.g. https://redmine.example.com/work_time/index or the NetSuite account URL */
  url: string;
  /** Fill and verify the inputs but leave Update/Save to the user */
  fillOnly: boolean;
  rules: SubmitRule<T>[];
}

/** Hours for one row on one day. */
export interface Cell<T> {
  date: string;
  target: T;
  hours: number;
}

export interface Plan<T> {
  system: SystemId;
  /** Monday of the week */
  week: string;
  /** Non-zero cells only, sorted by date then target */
  cells: Cell<T>[];
  /** Shown in review, do not block (e.g. "2026-10-01 is today") */
  notes: string[];
}

export type PlanResult<T> = { ok: true; plan: Plan<T> } | { ok: false; reasons: string[] };

/** Every non-zero value the site holds in the week, on any row (also rows we do not manage). */
export interface Snapshot<T> {
  week: string;
  cells: Cell<T>[];
}

export type Diff<T> =
  | { kind: 'noop' }
  | { kind: 'write'; cells: Cell<T>[]; unchanged: number }
  | { kind: 'conflict'; reasons: string[] };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

---

### Task 3: Config section

**Files:** Modify `src/core/config.ts`; Create `test/submit.test.ts`

- [ ] **Step 1: Write the failing tests** in `test/submit.test.ts`

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testConfig } from './helpers.ts';
import { defaultConfig, validateConfig } from '../src/core/config.ts';

describe('submit config', () => {
  it('defaults to off, fill-only, no rules, and is valid', () => {
    const c = defaultConfig();
    assert.deepEqual(c.submit.redmine, { url: '', fillOnly: true, rules: [] });
    assert.deepEqual(c.submit.netsuite, { url: '', fillOnly: true, rules: [] });
    assert.deepEqual(validateConfig(testConfig()), []);
  });

  it('rejects bad URLs, unknown names, duplicates and incomplete targets', () => {
    const c = testConfig();
    c.submit.redmine.url = 'http://redmine.local';
    c.submit.redmine.rules = [
      { project: 'Nope', category: 'Development', target: { issueId: 1, activity: 'Fejlesztés' } },
      { project: 'Default', category: 'Bogus', target: { issueId: 2, activity: 'Fejlesztés' } },
      { project: 'Default', category: '*', target: { issueId: 0, activity: '' } },
      { project: 'Default', category: '*', target: { issueId: 3, activity: 'Fejlesztés' } },
    ];
    c.submit.netsuite.rules = [{ project: 'Default', category: 'Testing', target: { project: '', task: 'Testing' } }];
    const errors = validateConfig(c);
    assert.ok(errors.includes('submit.redmine.url must start with https://'));
    assert.ok(errors.includes('submit.redmine rule uses unknown project "Nope"'));
    assert.ok(errors.includes('submit.redmine rule uses unknown category "Bogus"'));
    assert.ok(errors.includes('submit.redmine rule Default / * needs a positive issueId and an activity'));
    assert.ok(errors.includes('submit.redmine has two rules for Default / *'));
    assert.ok(errors.includes('submit.netsuite rule Default / Testing needs a project and a task'));
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (`c.submit` is undefined).

- [ ] **Step 3: Implement** in `src/core/config.ts`

Add the import at the top:

```ts
import type { NetsuiteTarget, RedmineTarget, SubmitRule, SubmitSystemConfig } from './submit/types.ts';
```

Add to `interface Config` after `categories: Category[];`:

```ts
  /** Entering booked hours into Redmine (Worktime) and NetSuite (weekly timesheet) through the browser */
  submit: { redmine: SubmitSystemConfig<RedmineTarget>; netsuite: SubmitSystemConfig<NetsuiteTarget> };
```

Add to the object returned by `defaultConfig()` after `categories: DEFAULT_CATEGORIES,`:

```ts
    submit: { redmine: { url: '', fillOnly: true, rules: [] }, netsuite: { url: '', fillOnly: true, rules: [] } },
```

In `loadConfig()` add after `classifier: { ...base.classifier, ...user.classifier },`:

```ts
    submit: {
      redmine: { ...base.submit.redmine, ...user.submit?.redmine },
      netsuite: { ...base.submit.netsuite, ...user.submit?.netsuite },
    },
```

In `validateConfig()` add before `return errors;`:

```ts
  for (const system of ['redmine', 'netsuite'] as const) {
    const s = c.submit?.[system];
    if (!s) {
      errors.push(`submit.${system} is missing`);
      continue;
    }
    if (s.url && !/^https:\/\/[^/\s]+/.test(s.url)) errors.push(`submit.${system}.url must start with https://`);
    if (typeof s.fillOnly !== 'boolean') errors.push(`submit.${system}.fillOnly must be true or false`);
    if (!Array.isArray(s.rules)) {
      errors.push(`submit.${system}.rules must be a list`);
      continue;
    }
    const seen = new Set<string>();
    for (const r of s.rules as SubmitRule<Partial<RedmineTarget & NetsuiteTarget>>[]) {
      if (!c.projects?.includes(r.project)) errors.push(`submit.${system} rule uses unknown project "${r.project}"`);
      if (r.category !== '*' && !c.categories?.some((x) => x.name === r.category)) errors.push(`submit.${system} rule uses unknown category "${r.category}"`);
      const key = `${r.project}\u0000${r.category}`;
      if (seen.has(key)) errors.push(`submit.${system} has two rules for ${r.project} / ${r.category}`);
      seen.add(key);
      const t = r.target ?? {};
      if (system === 'redmine' && !(Number.isInteger(t.issueId) && t.issueId! > 0 && t.activity?.trim()))
        errors.push(`submit.redmine rule ${r.project} / ${r.category} needs a positive issueId and an activity`);
      if (system === 'netsuite' && !(t.project?.trim() && t.task?.trim()))
        errors.push(`submit.netsuite rule ${r.project} / ${r.category} needs a project and a task`);
    }
  }
```

`computeKey` stays unchanged: submission settings do not affect computed days.

- [ ] **Step 4: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts && npm run typecheck`
Expected: PASS, no type errors.

---

### Task 4: Planner

**Files:** Create `src/core/submit/plan.ts`; Modify `test/submit.test.ts`

- [ ] **Step 1: Add failing tests** to `test/submit.test.ts`

Add imports at the top:

```ts
import { buildPlan, cellKey, describeTarget } from '../src/core/submit/plan.ts';
import type { RedmineTarget, SubmitRule } from '../src/core/submit/types.ts';
import type { DayReport, DayStatus } from '../src/core/types.ts';
```

Add:

```ts
const WEEK = '2026-09-28'; // Monday

function day(date: string, entries: [string, string, number][], status: DayStatus = 'final', warnings: string[] = []): DayReport {
  return {
    date, status, computedAt: '', blocks: [], summary: '', warnings, paths: {}, outOfOffice: false,
    target: 8, realTotal: 0, total: 0,
    entries: entries.map(([project, category, hours]) => ({ project, category, capex: false, real: hours, hours })),
  };
}

const RULES: SubmitRule<RedmineTarget>[] = [
  { project: 'NLP', category: '*', target: { issueId: 9888, activity: 'Fejlesztés' } },
  { project: 'NLP', category: 'Team Meeting', target: { issueId: 13, activity: 'Megbeszélés, egyeztetés' } },
  { project: 'NLP', category: 'Testing', target: { issueId: 9888, activity: 'Fejlesztés' } },
];

const plan = (reports: DayReport[], today = '2026-10-04', rules = RULES, exists?: (t: RedmineTarget) => boolean) =>
  buildPlan({ system: 'redmine', week: WEEK, reports, today, rules, exists });

describe('submit plan', () => {
  it('maps exact rules before wildcards, sums cells that share a target, skips zero hours', () => {
    const r = plan([day('2026-09-28', [['NLP', 'Development', 5], ['NLP', 'Testing', 2.25], ['NLP', 'Team Meeting', 0.75], ['NLP', 'Requirements', 0]])]);
    assert.ok(r.ok);
    // Sorted by date, then by the target's key (activity before issueId): "Fejlesztés" < "Megbeszélés…".
    assert.deepEqual(r.plan.cells, [
      { date: '2026-09-28', target: { issueId: 9888, activity: 'Fejlesztés' }, hours: 7.25 },
      { date: '2026-09-28', target: { issueId: 13, activity: 'Megbeszélés, egyeztetés' }, hours: 0.75 },
    ]);
    assert.deepEqual(r.plan.notes, []);
  });

  it('ignores days after today and notes today', () => {
    const r = plan([day('2026-09-28', [['NLP', 'Development', 8]]), day('2026-09-29', [['NLP', 'Development', 3]], 'today')], '2026-09-29');
    assert.ok(r.ok);
    assert.equal(r.plan.cells.length, 2);
    assert.deepEqual(r.plan.notes, ['2026-09-29 is today: its hours may still change']);
  });

  it('blocks on unmapped entries, partial or missing days and targets gone from the site', () => {
    const r = plan(
      [day('2026-09-28', [['Other', 'Development', 8]]), day('2026-09-29', [['NLP', 'Development', 8]], 'partial', ['claude: failed'])],
      '2026-09-30',
    );
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.reasons, [
      '2026-09-28: no redmine mapping for Other / Development',
      '2026-09-29: day is partial (claude: failed); fix or recompute it first',
      '2026-09-30: not computed yet',
    ]);
    const gone = plan([day('2026-09-28', [['NLP', 'Development', 8]])], '2026-09-28', RULES, (t) => t.issueId !== 9888);
    assert.deepEqual(!gone.ok && gone.reasons, ['2026-09-28: NLP / Development maps to #9888 · Fejlesztés, which is no longer on redmine']);
  });

  it('rejects a week that does not start on Monday', () => {
    assert.throws(() => buildPlan({ system: 'redmine', week: '2026-09-29', reports: [], today: '2026-10-04', rules: RULES }), /Monday/);
  });

  it('keys cells independently of property order', () => {
    assert.equal(cellKey({ date: 'd', target: { a: 1, b: 2 } }), cellKey({ date: 'd', target: { b: 2, a: 1 } }));
    assert.equal(describeTarget('netsuite', { project: 'Acme : NLP', task: 'Testing' }), 'Acme : NLP · Testing');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (cannot find module `plan.ts`).

- [ ] **Step 3: Implement** `src/core/submit/plan.ts`

```ts
import { addDays, daysBetween, weekStart } from '../dates.ts';
import type { DayReport } from '../types.ts';
import type { Cell, NetsuiteTarget, PlanResult, RedmineTarget, SubmitRule, SystemId } from './types.ts';

/** Hours as integer hundredths, so 0.1 + 0.2 equals 0.3. */
export const cents = (hours: number): number => Math.round(hours * 100);

export function targetKey(target: object): string {
  return JSON.stringify(Object.entries(target).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function cellKey(cell: { date: string; target: object }): string {
  return `${cell.date} ${targetKey(cell.target)}`;
}

export function byCell(a: Cell<object>, b: Cell<object>): number {
  return a.date.localeCompare(b.date) || targetKey(a.target).localeCompare(targetKey(b.target));
}

export function describeTarget(system: SystemId, target: object): string {
  if (system === 'redmine') {
    const t = target as RedmineTarget;
    return `#${t.issueId} · ${t.activity}`;
  }
  const t = target as NetsuiteTarget;
  return `${t.project} · ${t.task}`;
}

export function findRule<T>(rules: SubmitRule<T>[], project: string, category: string): SubmitRule<T> | undefined {
  return rules.find((r) => r.project === project && r.category === category) ?? rules.find((r) => r.project === project && r.category === '*');
}

export interface PlanInput<T> {
  system: SystemId;
  /** Monday */
  week: string;
  reports: DayReport[];
  today: string;
  rules: SubmitRule<T>[];
  /** Whether the target is still offered by the site (from discovery); omitted = not checked */
  exists?: (target: T) => boolean;
}

/**
 * The cells to enter for a week, from the booked hours. Any doubt (a day not computed or
 * partial, an entry without a mapping, a mapping to something the site no longer offers)
 * blocks the whole week for this system instead of entering part of it.
 */
export function buildPlan<T extends object>(input: PlanInput<T>): PlanResult<T> {
  if (weekStart(input.week) !== input.week) throw new Error(`${input.week} is not a Monday`);
  const reasons: string[] = [];
  const notes: string[] = [];
  const byDate = new Map(input.reports.map((r) => [r.date, r]));
  const cells = new Map<string, Cell<T>>();

  for (const date of daysBetween(input.week, addDays(input.week, 6))) {
    if (date > input.today) continue;
    const report = byDate.get(date);
    if (!report) {
      reasons.push(`${date}: not computed yet`);
      continue;
    }
    if (report.status === 'partial') {
      reasons.push(`${date}: day is partial (${report.warnings[0] ?? 'a source or the classifier failed'}); fix or recompute it first`);
      continue;
    }
    if (report.status === 'today') notes.push(`${date} is today: its hours may still change`);
    for (const e of report.entries) {
      if (cents(e.hours) <= 0) continue;
      const rule = findRule(input.rules, e.project, e.category);
      if (!rule) {
        reasons.push(`${date}: no ${input.system} mapping for ${e.project} / ${e.category}`);
        continue;
      }
      if (input.exists && !input.exists(rule.target)) {
        reasons.push(`${date}: ${e.project} / ${e.category} maps to ${describeTarget(input.system, rule.target)}, which is no longer on ${input.system}`);
        continue;
      }
      const key = cellKey({ date, target: rule.target });
      const before = cells.get(key);
      cells.set(key, { date, target: rule.target, hours: ((before ? cents(before.hours) : 0) + cents(e.hours)) / 100 });
    }
  }

  if (reasons.length) return { ok: false, reasons };
  return { ok: true, plan: { system: input.system, week: input.week, cells: [...cells.values()].sort(byCell), notes } };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: PASS.

---

### Task 5: Differ and fingerprint

**Files:** Create `src/core/submit/diff.ts`; Modify `test/submit.test.ts`

- [ ] **Step 1: Add failing tests**

Add import:

```ts
import { diff, fingerprint } from '../src/core/submit/diff.ts';
import type { Plan } from '../src/core/submit/types.ts';
```

Add:

```ts
describe('submit diff', () => {
  const dev = { issueId: 9888, activity: 'Fejlesztés' };
  const meet = { issueId: 13, activity: 'Megbeszélés, egyeztetés' };
  const p: Plan<RedmineTarget> = {
    system: 'redmine', week: WEEK, notes: [],
    cells: [{ date: '2026-09-28', target: dev, hours: 7.3 }, { date: '2026-09-29', target: meet, hours: 1 }],
  };

  it('writes into an empty week', () => {
    assert.deepEqual(diff(p, { week: WEEK, cells: [] }), { kind: 'write', cells: p.cells, unchanged: 0 });
  });

  it('is a no-op when everything is already there (rounding-safe), and writes only what is missing', () => {
    assert.deepEqual(diff(p, { week: WEEK, cells: [{ date: '2026-09-28', target: { activity: 'Fejlesztés', issueId: 9888 }, hours: 7.1 + 0.2 }, p.cells[1]] }), { kind: 'noop' });
    assert.deepEqual(diff(p, { week: WEEK, cells: [p.cells[1]] }), { kind: 'write', cells: [p.cells[0]], unchanged: 1 });
  });

  it('refuses when a planned cell holds another value or the site has hours we do not book', () => {
    const r = diff(p, {
      week: WEEK,
      cells: [{ date: '2026-09-28', target: dev, hours: 2 }, { date: '2026-09-30', target: meet, hours: 0.5 }],
    });
    assert.deepEqual(r, {
      kind: 'conflict',
      reasons: [
        '2026-09-28 #9888 · Fejlesztés: 2.00 h already entered, plan says 7.30 h',
        '2026-09-30 #13 · Megbeszélés, egyeztetés: 0.50 h entered that the timesheet does not book',
      ],
    });
  });

  it('refuses a snapshot of another week or with duplicate cells', () => {
    assert.equal(diff(p, { week: '2026-10-05', cells: [] }).kind, 'conflict');
    assert.equal(diff(p, { week: WEEK, cells: [p.cells[1], p.cells[1]] }).kind, 'conflict');
  });

  it('fingerprints plan + snapshot independently of order', () => {
    const a = fingerprint(p, { week: WEEK, cells: [p.cells[1]] });
    assert.equal(a, fingerprint({ ...p, cells: [...p.cells].reverse() }, { week: WEEK, cells: [p.cells[1]] }));
    assert.notEqual(a, fingerprint(p, { week: WEEK, cells: [] }));
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (cannot find module `diff.ts`).

- [ ] **Step 3: Implement** `src/core/submit/diff.ts`

```ts
import { createHash } from 'node:crypto';
import { byCell, cellKey, cents, describeTarget } from './plan.ts';
import type { Cell, Diff, Plan, Snapshot } from './types.ts';

const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * What to write so the site matches the plan. Only empty cells are ever written: a planned cell
 * holding another value, or hours on any row/day the plan does not book, refuses the whole week.
 */
export function diff<T extends object>(plan: Plan<T>, snapshot: Snapshot<T>): Diff<T> {
  if (snapshot.week !== plan.week) return { kind: 'conflict', reasons: [`read the week of ${snapshot.week}, planned ${plan.week}`] };
  const describe = (c: Cell<T>) => `${c.date} ${describeTarget(plan.system, c.target)}`;

  const site = new Map<string, number>();
  for (const c of snapshot.cells) {
    const key = cellKey(c);
    if (site.has(key)) return { kind: 'conflict', reasons: [`${describe(c)} appears twice on the site`] };
    site.set(key, cents(c.hours));
  }

  const reasons: string[] = [];
  const write: Cell<T>[] = [];
  let unchanged = 0;
  const planned = new Set<string>();
  for (const c of plan.cells) {
    const key = cellKey(c);
    planned.add(key);
    const there = site.get(key) ?? 0;
    const want = cents(c.hours);
    if (there === want) unchanged++;
    else if (there === 0) write.push(c);
    else reasons.push(`${describe(c)}: ${fmt(there)} h already entered, plan says ${fmt(want)} h`);
  }
  for (const c of [...snapshot.cells].sort(byCell))
    if (!planned.has(cellKey(c)) && cents(c.hours) !== 0) reasons.push(`${describe(c)}: ${fmt(cents(c.hours))} h entered that the timesheet does not book`);

  if (reasons.length) return { kind: 'conflict', reasons };
  return write.length ? { kind: 'write', cells: write, unchanged } : { kind: 'noop' };
}

/** Identifies exactly what the user reviewed: any change to the plan or the site invalidates a confirmation. */
export function fingerprint<T extends object>(plan: Plan<T>, snapshot: Snapshot<T>): string {
  const cells = (list: Cell<T>[]) => list.map((c) => [cellKey(c), cents(c.hours)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = { system: plan.system, week: plan.week, plan: cells(plan.cells), site: [snapshot.week, cells(snapshot.cells)] };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: PASS.

---

### Task 6: Storage for catalogs and runs

**Files:** Modify `src/core/store.ts`; Modify `test/submit.test.ts`

- [ ] **Step 1: Add failing tests**

Add import:

```ts
import { Store } from '../src/core/store.ts';
```

Add:

```ts
describe('submit store', () => {
  it('keeps the latest catalog per system and runs newest first', () => {
    const s = new Store(':memory:');
    assert.equal(s.submitCatalog('redmine'), null);
    s.saveSubmitCatalog('redmine', { user: 'Nuszpl Botond', issues: [] });
    s.saveSubmitCatalog('redmine', { user: 'Nuszpl Botond', issues: [{ id: 13 }] });
    assert.deepEqual(s.submitCatalog('redmine')?.data, { user: 'Nuszpl Botond', issues: [{ id: 13 }] });

    const base = { system: 'redmine' as const, week: WEEK, fillOnly: true, screenshots: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' };
    s.saveSubmitRun({ ...base, id: 'a', status: 'conflict', error: 'x' });
    s.saveSubmitRun({ ...base, id: 'b', status: 'filled', plan: { cells: [] }, createdAt: '2026-10-01T11:00:00Z' });
    s.saveSubmitRun({ ...base, id: 'a', status: 'aborted', error: 'y' });
    const runs = s.submitRuns('redmine', WEEK);
    assert.deepEqual(runs.map((r) => [r.id, r.status]), [['b', 'filled'], ['a', 'aborted']]);
    assert.deepEqual(runs[0].plan, { cells: [] });
    assert.equal(runs[1].error, 'y');
    assert.deepEqual(s.submitRuns('netsuite'), []);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (`s.submitCatalog is not a function`).

- [ ] **Step 3: Implement** in `src/core/store.ts`

Add import:

```ts
import type { SystemId } from './submit/types.ts';
```

Add after `JobRow`:

```ts
/** saved/filled/noop end well; blocked/conflict/aborted wrote nothing; failed = check the site by hand. */
export type SubmitRunStatus = 'running' | 'saved' | 'filled' | 'noop' | 'blocked' | 'conflict' | 'aborted' | 'failed';

/** One submission attempt for one system and week, kept as an audit trail. */
export interface SubmitRun {
  id: string;
  system: SystemId;
  week: string;
  status: SubmitRunStatus;
  fillOnly: boolean;
  fingerprint?: string;
  plan?: unknown;
  /** Snapshot read before writing */
  before?: unknown;
  /** Cells written */
  written?: unknown;
  /** Snapshot read back after saving */
  after?: unknown;
  error?: string;
  screenshots: string[];
  createdAt: string;
  updatedAt: string;
}
```

In the constructor's `CREATE TABLE` block add:

```sql
      CREATE TABLE IF NOT EXISTS submit_catalog (
        system TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        discovered_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submit_runs (
        id TEXT PRIMARY KEY,
        system TEXT NOT NULL,
        week TEXT NOT NULL,
        status TEXT NOT NULL,
        fill_only INTEGER NOT NULL,
        fingerprint TEXT,
        detail TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
```

Add methods before `close()`:

```ts
  submitCatalog<T = unknown>(system: SystemId): { data: T; discoveredAt: string } | null {
    const row = this.db.prepare('SELECT data, discovered_at FROM submit_catalog WHERE system = ?').get(system) as any;
    return row ? { data: JSON.parse(row.data), discoveredAt: row.discovered_at } : null;
  }

  saveSubmitCatalog(system: SystemId, data: unknown, discoveredAt = new Date().toISOString()): void {
    this.db.prepare('INSERT OR REPLACE INTO submit_catalog VALUES (?, ?, ?)').run(system, JSON.stringify(data), discoveredAt);
  }

  saveSubmitRun(r: SubmitRun): void {
    const detail = JSON.stringify({ plan: r.plan, before: r.before, written: r.written, after: r.after, screenshots: r.screenshots });
    this.db
      .prepare('INSERT OR REPLACE INTO submit_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.system, r.week, r.status, r.fillOnly ? 1 : 0, r.fingerprint ?? null, detail, r.error ?? null, r.createdAt, r.updatedAt);
  }

  /** Newest first. */
  submitRuns(system?: SystemId, week?: string): SubmitRun[] {
    const rows = this.db
      .prepare('SELECT * FROM submit_runs WHERE (? IS NULL OR system = ?) AND (? IS NULL OR week = ?) ORDER BY created_at DESC')
      .all(system ?? null, system ?? null, week ?? null, week ?? null) as any[];
    return rows.map((row) => {
      const d = JSON.parse(row.detail);
      return {
        id: row.id, system: row.system, week: row.week, status: row.status, fillOnly: !!row.fill_only,
        ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
        ...(d.plan !== undefined ? { plan: d.plan } : {}),
        ...(d.before !== undefined ? { before: d.before } : {}),
        ...(d.written !== undefined ? { written: d.written } : {}),
        ...(d.after !== undefined ? { after: d.after } : {}),
        ...(row.error ? { error: row.error } : {}),
        screenshots: d.screenshots ?? [],
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    });
  }
```

- [ ] **Step 4: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts && npm run typecheck`
Expected: PASS, no type errors.

---

### Task 7: Browser lock and launch

**Files:** Modify `src/core/jobs.ts`; Create `src/core/submit/browser.ts`; Modify `test/submit.test.ts`

- [ ] **Step 1: Export `alive`** in `src/core/jobs.ts`: change `function alive(` to `export function alive(`.

- [ ] **Step 2: Add failing tests**

Add imports:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, chromeAvailable, openBrowser } from '../src/core/submit/browser.ts';
```

Add:

```ts
describe('submit browser lock', () => {
  it('allows one holder, replaces a stale lock and releases only its own', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'lock-')), 'browser.lock');
    const release = acquireLock(path);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    assert.throws(() => acquireLock(path), /already in use by process/);
    release();
    assert.equal(existsSync(path), false);

    writeFileSync(path, '999999999');
    const again = acquireLock(path);
    assert.equal(readFileSync(path, 'utf8'), String(process.pid));
    writeFileSync(path, '123'); // someone else's now
    again();
    assert.equal(readFileSync(path, 'utf8'), '123');
  });
});

describe('submit browser', { skip: !chromeAvailable() && 'Google Chrome not installed' }, () => {
  it('opens a headless Chrome with a private profile and releases the lock on close', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    const lockPath = join(profileDir, '..', `lock-${process.pid}`);
    const session = await openBrowser({ headless: true, profileDir, lockPath });
    await session.page.setContent('<h1>ok</h1>');
    assert.equal(await session.page.textContent('h1'), 'ok');
    await session.close();
    assert.equal(existsSync(lockPath), false);
  });
});
```

- [ ] **Step 3: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (cannot find module `browser.ts`).

- [ ] **Step 4: Implement** `src/core/submit/browser.ts`

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { HOME } from '../config.ts';
import { alive } from '../jobs.ts';

/** Chrome profile used only for submissions: holds the Redmine/NetSuite login cookies, never passwords. */
export const PROFILE_DIR = join(HOME, 'browser');
export const LOCK_PATH = join(HOME, 'browser.lock');

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
};

export function chromeAvailable(): boolean {
  return (CHROME_PATHS[process.platform] ?? []).some((p) => existsSync(p));
}

/** One submission browser at a time: returns a release function, throws if a live process holds the lock. */
export function acquireLock(path = LOCK_PATH): () => void {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(path, 'utf8'));
    if (alive(pid)) throw new Error(`the submission browser is already in use by process ${pid}`);
    rmSync(path, { force: true });
    writeFileSync(path, String(process.pid), { flag: 'wx' });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
}

export async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core is missing: reinstall timesheet, or run `npm install` in the checkout');
  }
}

export interface BrowserSession {
  context: BrowserContext;
  /** The first tab */
  page: Page;
  /** The tab the user looked at last (they may open new ones) */
  current(): Page;
  close(): Promise<void>;
}

export interface OpenOptions {
  headless?: boolean;
  profileDir?: string;
  lockPath?: string;
}

/** Starts the installed Google Chrome with the submission profile (visible unless headless). */
export async function openBrowser(opts: OpenOptions = {}): Promise<BrowserSession> {
  const release = acquireLock(opts.lockPath);
  try {
    const { chromium } = await loadPlaywright();
    const dir = opts.profileDir ?? PROFILE_DIR;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const context = await chromium
      .launchPersistentContext(dir, { channel: 'chrome', headless: opts.headless ?? false, viewport: null })
      .catch((e: Error) => {
        throw new Error(/is not found|executable doesn't exist/i.test(e.message) ? 'Google Chrome is required for submission; install it from google.com/chrome' : e.message);
      });
    context.on('close', release);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      current: () => context.pages().at(-1) ?? page,
      close: async () => {
        try {
          await context.close();
        } finally {
          release();
        }
      },
    };
  } catch (e) {
    release();
    throw e;
  }
}
```

- [ ] **Step 5: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts && npm run typecheck`
Expected: PASS (the browser test runs on a machine with Chrome, is skipped otherwise), no type errors.

---

### Task 8: In-page sanitizer and capture

**Files:** Create `src/core/submit/sanitize.ts`, `src/core/submit/inspect.ts`; Modify `test/submit.test.ts`

- [ ] **Step 1: Add failing tests**

Add import:

```ts
import { capture } from '../src/core/submit/inspect.ts';
```

Add inside `describe('submit browser', …)` (it shares the Chrome skip):

```ts
  it('captures structure and visible values without scripts, tokens or e-mails', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'profile-'));
    const session = await openBrowser({ headless: true, profileDir, lockPath: join(profileDir, '..', `lock2-${process.pid}`) });
    try {
      await session.page.setContent(`
        <script>window.secret = 1</script><style>h1{}</style>
        <form action="/work_time/update" method="post">
          <input type="hidden" name="authenticity_token" value="SECRET-CSRF">
          <h2>Monthly Report (Test User) <span>someone@example.com</span></h2>
          <a href="/issues/9888">Feature #9888</a>
          <input type="text" name="new_time_entry[9888][hours]" id="h9888" data-x="1" style="color:red">
          <select name="act"><option value="1">Fejlesztés</option><option value="2">Megbeszélés</option></select>
          <!-- a comment -->
        </form>`);
      await session.page.fill('#h9888', '7.5');
      await session.page.selectOption('select', '2');
      const dir = mkdtempSync(join(tmpdir(), 'inspect-'));
      const files = await capture(session.page, 'redmine', 'Worktime Day!', dir);
      const html = readFileSync(files.html, 'utf8');
      assert.match(files.html, /redmine\/.+-worktime-day\.html$/);
      assert.ok(existsSync(files.png));
      assert.doesNotMatch(html, /window\.secret|SECRET-CSRF|someone@example\.com|<style|a comment|color:red/);
      assert.match(html, /name="authenticity_token"/);
      assert.match(html, /href="\/issues\/9888"/);
      assert.match(html, /id="h9888"[^>]*value="7\.5"|value="7\.5"[^>]*id="h9888"/);
      assert.match(html, /data-x="1"/);
      assert.match(html, /<option value="2" selected="">Megbeszélés<\/option>/);
      assert.match(html, /&lt;email&gt;|<email>/);
    } finally {
      await session.close();
    }
  });
```

- [ ] **Step 2: Run, expect failure**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts`
Expected: FAIL (cannot find module `inspect.ts`).

- [ ] **Step 3: Implement** `src/core/submit/sanitize.ts`

```ts
/// <reference lib="dom" />

/**
 * Runs inside the page through page.evaluate, so it must stay self-contained (no imports, no
 * outer variables). Returns a copy of the DOM with what selectors are built from (structure,
 * ids, names, classes, data-*, links, labels, text, current form values) and without scripts,
 * styles, comments, hidden-field values (CSRF tokens), passwords or e-mail addresses.
 */
export function sanitizeDocument(): string {
  const KEEP = new Set(['id', 'name', 'class', 'type', 'role', 'for', 'title', 'href', 'action', 'method', 'colspan', 'rowspan', 'disabled', 'readonly', 'checked', 'selected', 'multiple', 'aria-label', 'placeholder', 'value', 'onclick', 'onchange']);
  const DROP = 'script,style,link,meta,noscript,iframe,svg,canvas,template,img,video,audio,object,embed';
  const SECRET = /token|csrf|nonce|secret|passw|session|auth/i;
  const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const root = document.documentElement.cloneNode(true) as HTMLElement;

  // Current values live in properties, not attributes: copy them from the live fields (same order in the clone).
  const live = [...document.querySelectorAll('input, textarea, select')];
  const copies = [...root.querySelectorAll('input, textarea, select')];
  live.forEach((field, i) => {
    const copy = copies[i];
    if (!copy) return;
    if (field instanceof HTMLSelectElement) {
      [...field.options].forEach((o, j) => {
        const c = copy.querySelectorAll('option')[j];
        if (!c) return;
        if (o.selected) c.setAttribute('selected', '');
        else c.removeAttribute('selected');
      });
      return;
    }
    const input = field as HTMLInputElement | HTMLTextAreaElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'hidden' || type === 'password' || SECRET.test(input.getAttribute('name') ?? '') || SECRET.test(input.id)) {
      copy.removeAttribute('value');
      copy.textContent = '';
    } else if (type === 'checkbox' || type === 'radio') {
      if ((input as HTMLInputElement).checked) copy.setAttribute('checked', '');
      else copy.removeAttribute('checked');
    } else if (input instanceof HTMLTextAreaElement) {
      copy.textContent = clip(input.value, 200);
    } else {
      copy.setAttribute('value', clip(input.value, 200));
    }
  });

  root.querySelectorAll(DROP).forEach((el) => el.remove());

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === Node.COMMENT_NODE) comments.push(node);
    else if (node.nodeType === Node.TEXT_NODE) node.textContent = clip((node.textContent ?? '').replace(EMAIL, '<email>'), 300);
    else {
      const el = node as Element;
      for (const attr of [...el.attributes]) {
        if (!KEEP.has(attr.name) && !attr.name.startsWith('data-')) el.removeAttribute(attr.name);
        else el.setAttribute(attr.name, clip(attr.value.replace(EMAIL, '<email>'), attr.name.startsWith('on') ? 120 : 200));
      }
    }
  }
  comments.forEach((c) => c.parentNode?.removeChild(c));

  return `<!doctype html>\n${root.outerHTML}`;
}
```

- [ ] **Step 4: Implement** `src/core/submit/inspect.ts`

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { HOME } from '../config.ts';
import { sanitizeDocument } from './sanitize.ts';
import type { SystemId } from './types.ts';

export const INSPECT_DIR = join(HOME, 'inspect');

/** The page URL without query parameters that look like secrets. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (/token|csrf|nonce|secret|auth|code|session/i.test(key)) url.searchParams.set(key, '…');
    return url.toString();
  } catch {
    return '';
  }
}

/** Saves a sanitized DOM copy and a full-page screenshot of the page; both stay local until the user shares them. */
export async function capture(page: Page, system: SystemId, label: string, dir = INSPECT_DIR): Promise<{ html: string; png: string }> {
  const out = join(dir, system);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
  const base = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}`);
  const html = await page.evaluate(sanitizeDocument);
  writeFileSync(`${base}.html`, `<!-- ${safeUrl(page.url()).replace(/--/g, '- -')} -->\n${html}`, { mode: 0o600 });
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  return { html: `${base}.html`, png: `${base}.png` };
}
```

- [ ] **Step 5: Run, expect pass**

Run: `node --experimental-sqlite --no-warnings --test test/submit.test.ts && npm run typecheck`
Expected: PASS, no type errors. If the bundled build later breaks `page.evaluate(sanitizeDocument)` (esbuild helper injection), verify in Task 10 Step 3.

---

### Task 9: CLI `submit login|inspect|plan` and doctor

**Files:** Modify `src/cli.ts`

- [ ] **Step 1: Imports** — add near the other core imports:

```ts
import { PROFILE_DIR } from './core/submit/browser.ts';
import { buildPlan, describeTarget } from './core/submit/plan.ts';
import { SYSTEMS } from './core/submit/types.ts';
import type { SubmitRule, SystemId } from './core/submit/types.ts';
```

`browser.ts` only loads `playwright-core` inside `openBrowser`, so the static import costs nothing for other commands. `inspect.ts` imports playwright types only.

- [ ] **Step 2: Usage** — add to `USAGE` after the `github remove` line:

```
  timesheet submit login <redmine|netsuite>     log in once in the submission browser (SSO/MFA); the session is kept
  timesheet submit inspect <redmine|netsuite>   save sanitized snapshots of pages you open (for building the automation)
  timesheet submit plan [week]                  what would be entered in Redmine and NetSuite (read-only, --json)
```

- [ ] **Step 3: Command** — add before `// ---------- setup ----------`:

```ts
// ---------- submission ----------

function systemArg(value: string | undefined): SystemId {
  if (value === 'redmine' || value === 'netsuite') return value;
  fail('expected redmine or netsuite');
}

async function submitPlan(arg: string | undefined) {
  const monday = resolveWeek(arg);
  const sunday = addDays(monday, 6);
  if (monday > today()) fail(`${monday} is in the future`);
  const e = engine();
  await computeResumable(e, monday, sunday, false);
  const reports = await e.days(monday, sunday);
  const results = SYSTEMS.map((system) => ({
    system,
    ...buildPlan({ system, week: monday, reports, today: today(), rules: e.config.submit[system].rules as SubmitRule<object>[] }),
  }));
  if (flags.json) {
    console.log(JSON.stringify({ week: monday, systems: results }, null, 2));
    return;
  }
  for (const r of results) {
    console.log(`\n${r.system}${e.config.submit[r.system].fillOnly ? ' (fill only)' : ''}:`);
    if (!r.ok) {
      for (const reason of r.reasons) console.log(`  ✗ ${reason}`);
      continue;
    }
    if (!r.plan.cells.length) console.log('  (nothing to enter)');
    for (const c of r.plan.cells) console.log(`  ${c.date}  ${describeTarget(r.system, c.target).padEnd(44)} ${c.hours.toFixed(2)}`);
    for (const n of r.plan.notes) console.log(`  ⚠ ${n}`);
  }
}

async function submitCmd() {
  const [sub, arg] = args;
  if (sub === 'plan') return submitPlan(arg);
  if (sub !== 'login' && sub !== 'inspect') fail('usage: timesheet submit login|inspect <redmine|netsuite> | plan [week]');
  const system = systemArg(arg);
  const url = loadConfig().submit[system].url;
  if (!url) fail(`set the ${system} address first: timesheet config set submit.${system}.url https://…`);
  const { openBrowser } = await import('./core/submit/browser.ts');
  const { capture, INSPECT_DIR } = await import('./core/submit/inspect.ts');
  const session = await openBrowser();
  const rl = prompter();
  try {
    await session.page.goto(url);
    if (sub === 'login') {
      await rl.question(`Log in to ${system} in the browser window, then press Enter here. `);
      console.log(`Session kept in ${contractHome(PROFILE_DIR)}.`);
      return;
    }
    console.error('Log in if needed and open a page to capture (Redmine: Worktime for a day; NetSuite: the weekly timesheet in edit mode).');
    console.error('Then type a short label and press Enter. An empty line finishes.');
    for (;;) {
      const label = (await rl.question('label> ')).trim();
      if (!label) break;
      const files = await capture(session.current(), system, label);
      console.error(`  saved ${contractHome(files.html)} (+ .png)`);
    }
    console.error(`Look through ${contractHome(join(INSPECT_DIR, system))} before sharing: screenshots show your own data.`);
  } finally {
    rl.close();
    await session.close();
  }
}
```

- [ ] **Step 4: Dispatch** — in `main()` add after `case 'github': return githubCmd();`:

```ts
    case 'submit':
      return submitCmd();
```

- [ ] **Step 5: Doctor** — in `doctor()` before `if (problems.length) process.exitCode = 1;`:

```ts
  console.log('Submission:');
  for (const s of SYSTEMS) {
    const c = config.submit[s];
    line(!!c.url, `${s}: ${c.url || 'no address (submit.' + s + '.url)'} · ${c.rules.length} mapping rule(s) · ${c.fillOnly ? 'fill only' : 'saves'}`);
  }
  line(existsSync(PROFILE_DIR), `browser profile ${contractHome(PROFILE_DIR)}${existsSync(PROFILE_DIR) ? '' : ' (created by `timesheet submit login`)'}`);
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm test`
Expected: no type errors; all tests pass.

Run: `node bin/timesheet.js submit plan last`
Expected: for each system either `✗ … no redmine mapping for …` lines (no rules yet) or `(nothing to enter)`; no stack trace.

Run: `node bin/timesheet.js submit login redmine`
Expected: `timesheet: set the redmine address first: …` while `submit.redmine.url` is empty.

---

### Task 10: Docs and bundle check

**Files:** Modify `skill/SKILL.md`, `README.md`, `docs/specs/2026-10-01-auto-submit-design.md`

- [ ] **Step 1: Skill** — append to `skill/SKILL.md`:

```markdown
## Submission (Redmine, NetSuite)

- You may show what would be entered: `timesheet submit plan [week] --json` (read-only). Relay blocking reasons as they are.
- Never run anything that enters data (`timesheet submit week …`), and never run `timesheet submit login|inspect`: they open a browser for the user. Tell the user the command instead.
```

- [ ] **Step 2: README** — add a section after *GitHub tokens*:

```markdown
## Submitting to Redmine and NetSuite (in progress)

There are no API keys, so the timesheet drives the real pages in a separate Chrome window with its own profile (`~/.timesheet/browser`). You log in there yourself (SSO, MFA); only the session cookies are kept, never passwords.

```sh
timesheet config set submit.redmine.url https://redmine.example.com/work_time/index
timesheet submit login redmine        # log in once in the window
timesheet submit plan last            # what would be entered (read-only)
timesheet submit inspect netsuite     # save sanitized page snapshots for building the automation
```

Booked hours map to Redmine issue + activity and NetSuite project + task through `submit.<system>.rules` (`{ "project", "category" | "*", "target" }`). Anything unmapped, a partial day, or hours already on the site that differ from the plan stops that system for the whole week, with nothing entered.
```

- [ ] **Step 3: Bundle check** (the CLI ships as `dist/timesheet.mjs`)

Run: `npm run build:cli && node dist/timesheet.mjs submit plan last >/dev/null && echo ok`
Expected: `ok`.

Check that the bundled sanitizer stays self-contained (`page.evaluate` sends its source text to the page, where esbuild helpers do not exist):

Run: `grep -c '__name' dist/timesheet.mjs`
Expected: `0` (esbuild injects `__name` only with `keepNames: true`; never enable it in `scripts/build-cli.mjs`).

- [ ] **Step 4: Spec** — in `docs/specs/2026-10-01-auto-submit-design.md`, replace the NetSuite mapping bullet with:

```markdown
  - NetSuite: `(project, category)` → `{ project, task }` option texts (NetSuite tasks can depend on the project), same rule shape and `*` wildcard as Redmine. Pre-filled when option texts equal our names exactly; the user confirms.
```

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test`
Expected: all pass.

---

## Handoff to milestone 2

With this milestone done, the user runs `timesheet submit login` and `timesheet submit inspect` for both systems (Redmine: Worktime for a day with and without existing entries, after Update; NetSuite: weekly timesheet empty, filled, a project/task dropdown open, after Save) and shares the reviewed snapshots. Milestone 2 plans, from those snapshots: the two adapters (`checkLogin`, `discover`, `read`, `fill`, `save`) with local HTML fixtures, `run.ts` (confirm by fingerprint, re-read before write, verify after save, audit in `submit_runs`), `timesheet submit week`, and the web Submit panel + wizard mapping step.
