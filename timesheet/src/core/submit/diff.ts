import { createHash } from 'node:crypto';
import { byCell, cellKey, cents, describeTarget } from './plan.ts';
import type { Cell, Diff, Plan, Snapshot } from './types.ts';

const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * What to write so the site matches the plan. Only empty cells are ever written: a planned cell
 * holding another value, or hours on any row/day the plan does not book, refuses the whole week,
 * as does a plan that is not well-formed (a cell twice, hours not positive).
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

  const planned = new Set<string>();
  for (const c of plan.cells) {
    const key = cellKey(c);
    if (planned.has(key)) return { kind: 'conflict', reasons: [`${describe(c)} is planned twice`] };
    if (!Number.isFinite(c.hours) || cents(c.hours) <= 0) return { kind: 'conflict', reasons: [`${describe(c)}: invalid planned hours (${c.hours})`] };
    planned.add(key);
  }

  const reasons: string[] = [];
  const write: Cell<T>[] = [];
  let unchanged = 0;
  for (const c of plan.cells) {
    const key = cellKey(c);
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
