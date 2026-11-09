import { createHash } from 'node:crypto';
import { byCell, cellKey, cents, describeTarget } from './plan.ts';
import { addDays } from '../dates.ts';
import type { Cell, Diff, Plan, Snapshot, SystemId } from './types.ts';

const SITE: Record<SystemId, string> = { redmine: 'Redmine', netsuite: 'NetSuite' };

const fmt = (c: number) => (c / 100).toFixed(2);

/**
 * What to write so the site matches the plan. Only empty cells are ever written. A planned cell
 * holding another value, or hours on a row the plan does not book, holds back that day only: it is
 * listed in `held` (date → reasons) and nothing is written on it, while the other days still are.
 * A plan or snapshot that is not well-formed (another week, a cell twice, hours not positive) refuses
 * the whole week, and so does a week where every difference is held back and nothing is left to write.
 *
 * Days outside `inScope` (e.g. the previous month's days of a week, when entering a month) are left
 * out entirely, on both sides. Frozen days (approved or submitted on the site) are never written and
 * never refuse the week: they are listed in `skipped`, with a word when the site holds other hours.
 * Days off in the plan (`plan.off`) book nothing; hours the site holds there are left as they are.
 */
export function diff<T extends object>(plan: Plan<T>, snapshot: Snapshot<T>, inScope: (date: string) => boolean = () => true): Diff<T> {
  if (snapshot.week !== plan.week) return { kind: 'conflict', reasons: [`read the week of ${snapshot.week}, planned ${plan.week}`] };
  const describe = (c: Cell<T>) => `${c.date} ${describeTarget(plan.system, c.target)}`;
  const frozen = snapshot.frozen ?? {};
  const off = new Set(plan.off ?? []);

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

  // Frozen days in scope: compared per day, only to tell the user; never written.
  const skipped: string[] = [];
  const dayTotal = (cells: Cell<T>[], date: string) => cells.filter((c) => c.date === date).reduce((s, c) => s + cents(c.hours), 0);
  for (const date of Object.keys(frozen).sort()) {
    if (!inScope(date) || date < plan.week || date > addDays(plan.week, 6)) continue;
    const want = plan.cells.filter((c) => c.date === date);
    const there = snapshot.cells.filter((c) => c.date === date);
    const same = want.length === there.length && want.every((c) => site.get(cellKey(c)) === cents(c.hours));
    if (!want.length && !there.length) continue;
    skipped.push(same ? `${date}: ${frozen[date]} in ${SITE[plan.system]}; already as planned` : `${date}: ${frozen[date]} in ${SITE[plan.system]} with ${fmt(dayTotal(there, date))} h (the timesheet books ${fmt(dayTotal(want, date))} h); left as it is`);
  }

  const active = (date: string) => inScope(date) && !frozen[date];
  const held = new Map<string, string[]>();
  const hold = (date: string, reason: string) => held.set(date, [...(held.get(date) ?? []), reason]);
  const candidates: Cell<T>[] = [];
  let unchanged = 0;
  for (const c of plan.cells) {
    if (!active(c.date)) continue;
    const there = site.get(cellKey(c)) ?? 0;
    const want = cents(c.hours);
    if (there === want) unchanged++;
    else if (there === 0) candidates.push(c);
    else hold(c.date, `${describe(c)}: ${fmt(there)} h already entered, plan says ${fmt(want)} h`);
  }
  const offHours = new Map<string, number>();
  for (const c of [...snapshot.cells].sort(byCell)) {
    if (!active(c.date) || planned.has(cellKey(c)) || cents(c.hours) === 0) continue;
    if (off.has(c.date)) offHours.set(c.date, (offHours.get(c.date) ?? 0) + cents(c.hours));
    else hold(c.date, `${describe(c)}: ${fmt(cents(c.hours))} h entered that the timesheet does not book`);
  }
  for (const [date, h] of [...offHours].sort()) skipped.push(`${date}: day off; ${fmt(h)} h in ${SITE[plan.system]} left as it is`);

  const write = candidates.filter((c) => !held.has(c.date));
  if (held.size && !write.length) return { kind: 'conflict', reasons: [...held.values()].flat(), held: Object.fromEntries(held) };
  const extra = held.size ? { held: Object.fromEntries(held) } : {};
  return write.length ? { kind: 'write', cells: write, unchanged, skipped, ...extra } : { kind: 'noop', skipped, ...extra };
}

/** Identifies exactly what the user reviewed: any change to the plan or the site invalidates a confirmation. */
export function fingerprint<T extends object>(plan: Plan<T>, snapshot: Snapshot<T>): string {
  const cells = (list: Cell<T>[]) => list.map((c) => [cellKey(c), cents(c.hours)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const data = { system: plan.system, week: plan.week, plan: cells(plan.cells), site: [snapshot.week, cells(snapshot.cells), Object.entries(snapshot.frozen ?? {}).sort()], ...(plan.off?.length ? { off: [...plan.off].sort() } : {}) };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}
