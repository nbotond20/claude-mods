import type { Config } from './config.ts';
import { addDays, fmtTime, parseDate, weekStart } from './dates.ts';
import type { DayReport, Entry } from './types.ts';
import { roundUp } from './hours.ts';

export type Format = 'grid' | 'lines' | 'daily' | 'internal';
export const FORMATS: Format[] = ['grid', 'lines', 'daily', 'internal'];

export interface FormatOptions {
  header?: boolean;
  /** Book real (rounded) hours instead of normalized ones */
  real?: boolean;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function num(x: number, config: Config): string {
  // Two decimals, rounded up like everything else that is booked or shown.
  const s = String(Math.ceil(x * 100 - 1e-6) / 100);
  return config.decimalSeparator === ',' ? s.replace('.', ',') : s;
}

/** Recorded minutes to the hundredth, never rounded up; "?" for days computed before they were recorded. */
export function mins(m: number | undefined, config: Config): string {
  if (m === undefined) return '?';
  const s = String(Math.floor(m * 100 + 1e-6) / 100);
  return config.decimalSeparator === ',' ? s.replace('.', ',') : s;
}

export function fmtDateAs(date: string, pattern: string): string {
  const [y, m, d] = date.split('-');
  return pattern.replace('YYYY', y).replace('MM', m).replace('DD', d);
}

function bookable(r: DayReport, real: boolean, step: number): Entry[] {
  return r.entries
    .map((e) => (real && !e.overridden ? { ...e, hours: roundUp(e.real, step) } : e))
    .filter((e) => e.hours > 0);
}

/** One line per (date, project, category): paste into NetSuite time entries / CSV import. */
export function formatLines(reports: DayReport[], config: Config, opts: FormatOptions = {}): string {
  const rows = opts.header === false ? [] : ['Date\tProject\tTask Category\tHours'];
  for (const r of reports) {
    for (const e of bookable(r, !!opts.real, config.rounding)) {
      rows.push([fmtDateAs(r.date, config.dateFormat), e.project, e.category, num(e.hours, config)].join('\t'));
    }
  }
  return rows.join('\n');
}

/** NetSuite weekly timesheet grid: rows = project + category, columns = Mon..Sun. One table per week. */
export function formatGrid(reports: DayReport[], config: Config, opts: FormatOptions = {}): string {
  const weeks = new Map<string, DayReport[]>();
  for (const r of reports) {
    const w = weekStart(r.date);
    weeks.set(w, [...(weeks.get(w) ?? []), r]);
  }
  const tables: string[] = [];
  for (const [monday, days] of weeks) {
    const dates = WEEKDAYS.map((_, i) => addDays(monday, i));
    const cells = new Map<string, Map<string, number>>();
    for (const r of days) {
      for (const e of bookable(r, !!opts.real, config.rounding)) {
        const key = `${e.project}\t${e.category}`;
        const row = cells.get(key) ?? new Map<string, number>();
        row.set(r.date, (row.get(r.date) ?? 0) + e.hours);
        cells.set(key, row);
      }
    }
    const lines: string[] = [];
    if (opts.header !== false) {
      lines.push(['Project', 'Task Category', ...dates.map((d, i) => `${WEEKDAYS[i]} ${fmtDateAs(d, config.dateFormat)}`), 'Total'].join('\t'));
    }
    for (const [key, row] of [...cells].sort(([a], [b]) => a.localeCompare(b))) {
      const total = [...row.values()].reduce((a, b) => a + b, 0);
      lines.push([key, ...dates.map((d) => (row.get(d) ? num(row.get(d)!, config) : '')), ...(opts.header !== false ? [num(total, config)] : [])].join('\t'));
    }
    if (lines.length > (opts.header !== false ? 1 : 0)) tables.push(lines.join('\n'));
  }
  return tables.join('\n\n');
}

/** Per-day block: category and hours only. */
export function formatDaily(reports: DayReport[], config: Config, opts: FormatOptions = {}): string {
  const multiProject = new Set(reports.flatMap((r) => r.entries.map((e) => e.project))).size > 1;
  return reports
    .map((r) => {
      const entries = bookable(r, !!opts.real, config.rounding);
      if (!entries.length) return null;
      const rows = entries.map((e) => [...(multiProject ? [e.project] : []), e.category, num(e.hours, config)].join('\t'));
      return (opts.header === false ? [] : [fmtDateAs(r.date, config.dateFormat)]).concat(rows).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

function statusLabel(r: DayReport): string {
  return r.status === 'final' ? '' : r.status === 'today' ? ' (today, still open)' : ' (partial, will be recomputed)';
}

/** Human-readable internal view: time blocks, real vs booked hours, CAPEX/OPEX, summary, warnings. */
export function formatInternal(reports: DayReport[], config: Config): string {
  const out: string[] = [];
  let capex = 0;
  let opex = 0;
  let real = 0;
  let recorded: number | undefined = 0;
  for (const r of reports) {
    const dow = WEEKDAYS[(parseDate(r.date).getDay() + 6) % 7];
    if (!r.blocks.length && !r.warnings.length && !r.entries.length) {
      out.push(`${dow} ${r.date}  no activity${statusLabel(r)}`);
      continue;
    }
    out.push(`${dow} ${r.date}  recorded ${mins(r.measuredTotal, config)} min · real ${num(r.realTotal, config)}h → booked ${num(r.total, config)}h${r.target === null ? ' (not normalized)' : ` (target ${num(r.target, config)})`}${statusLabel(r)}`);
    for (const b of r.blocks) {
      const cats = b.allocations.map((a) => (a.fraction < 1 ? `${a.category} ${Math.round(a.fraction * 100)}%` : a.category)).join(', ');
      const what = b.texts.slice(0, 2).map((t) => t.slice(0, 70)).join(' | ');
      out.push(`  ${fmtTime(b.start)}–${fmtTime(b.end)}  ${mins(b.measured, config).padStart(7)} min  ${b.kind === 'meeting' ? 'meeting' : b.sources.join('+')}  ${b.project} · ${cats}${what ? `  — ${what}` : ''}`);
    }
    for (const e of r.entries) {
      out.push(`    ${e.category.padEnd(24)} ${e.capex ? 'CAPEX' : 'OPEX '}  recorded ${mins(e.measured, config).padStart(7)} min  real ${num(e.real, config).padStart(5)}  book ${num(e.hours, config).padStart(5)}${e.overridden ? ' (edited)' : ''}${r.entries.some((x) => x.project !== e.project) ? `  [${e.project}]` : ''}`);
      if (e.capex) capex += e.hours;
      else opex += e.hours;
    }
    real += r.realTotal;
    if (r.blocks.length) recorded = recorded === undefined || r.measuredTotal === undefined ? undefined : recorded + r.measuredTotal;
    if (r.summary) out.push(...r.summary.split('\n').map((l) => `  ${l}`));
    for (const w of r.warnings) out.push(`  ⚠ ${w}`);
    out.push('');
  }
  out.push(`Total booked ${num(capex + opex, config)}h (real ${num(real, config)}h, recorded ${mins(recorded, config)} min) · CAPEX ${num(capex, config)}h · OPEX ${num(opex, config)}h`);
  return out.join('\n');
}

export function render(format: Format, reports: DayReport[], config: Config, opts: FormatOptions = {}): string {
  switch (format) {
    case 'grid':
      return formatGrid(reports, config, opts);
    case 'lines':
      return formatLines(reports, config, opts);
    case 'daily':
      return formatDaily(reports, config, opts);
    case 'internal':
      return formatInternal(reports, config);
  }
}
