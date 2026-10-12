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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/** Structural problems with a system's mapping rules (config or plan input), empty when usable. */
export function ruleProblems(system: SystemId, rules: unknown): string[] {
  if (!Array.isArray(rules)) return [`submit.${system}.rules must be a list`];
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((r: unknown, i) => {
    if (!isObject(r) || typeof r.project !== 'string' || typeof r.category !== 'string') {
      problems.push(`submit.${system} rule ${i + 1} needs a project and a category`);
      return;
    }
    const key = `${r.project}\u0000${r.category}`;
    if (seen.has(key)) problems.push(`submit.${system} has two rules for ${r.project} / ${r.category}`);
    seen.add(key);
    const t = isObject(r.target) ? r.target : {};
    if (system === 'redmine' && !(Number.isInteger(t.issueId) && (t.issueId as number) > 0 && filled(t.activity)))
      problems.push(`submit.redmine rule ${r.project} / ${r.category} needs a positive issueId and an activity`);
    if (system === 'netsuite' && !(filled(t.project) && filled(t.task))) problems.push(`submit.netsuite rule ${r.project} / ${r.category} needs a project and a task`);
  });
  return problems;
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
 * The cells to enter for a week, from the booked hours. Any doubt (invalid rules or hours, a day
 * not computed or partial, an entry without a mapping, a mapping to something the site no longer
 * offers) blocks the whole week for this system instead of entering part of it.
 */
export function buildPlan<T extends object>(input: PlanInput<T>): PlanResult<T> {
  if (weekStart(input.week) !== input.week) throw new Error(`${input.week} is not a Monday`);
  const invalid = ruleProblems(input.system, input.rules);
  if (invalid.length) return { ok: false, reasons: invalid };
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
    let total = 0;
    for (const e of report.entries) {
      if (typeof e.hours !== 'number' || !Number.isFinite(e.hours) || e.hours < 0) {
        reasons.push(`${date}: ${e.project} / ${e.category} has invalid hours (${e.hours})`);
        continue;
      }
      if (cents(e.hours) <= 0) continue;
      total += cents(e.hours);
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
    if (total > 2400) reasons.push(`${date}: ${total / 100} h booked, more than a day`);
  }

  if (input.system === 'redmine') {
    // Worktime has one row per issue with one activity select, so an issue cannot take two activities a day.
    const activities = new Map<string, Set<string>>();
    for (const c of cells.values()) {
      const t = c.target as unknown as RedmineTarget;
      const key = `${c.date} ${t.issueId}`;
      activities.set(key, (activities.get(key) ?? new Set()).add(t.activity));
    }
    for (const [key, set] of activities) {
      if (set.size < 2) continue;
      const [date, issueId] = key.split(' ');
      reasons.push(`${date}: #${issueId} would get two activities (${[...set].sort().join(', ')}); Worktime has one row per issue`);
    }
  }

  if (reasons.length) return { ok: false, reasons };
  return { ok: true, plan: { system: input.system, week: input.week, cells: [...cells.values()].sort(byCell), notes } };
}
