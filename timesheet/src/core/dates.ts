// All dates are local-time calendar days in YYYY-MM-DD form.

export function parseDate(date: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid date "${date}", expected YYYY-MM-DD`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today(): string {
  return fmtDate(new Date());
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

/** [start, end) epoch ms of a local calendar day (DST-safe). */
export function dayBounds(date: string): [number, number] {
  return [parseDate(date).getTime(), parseDate(addDays(date, 1)).getTime()];
}

export function weekday(date: string): number {
  return parseDate(date).getDay();
}

/** Monday of the week containing date. */
export function weekStart(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

export function monthRange(ym: string): [string, string] {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) throw new Error(`Invalid month "${ym}", expected YYYY-MM`);
  const first = `${ym}-01`;
  const last = fmtDate(new Date(Number(m[1]), Number(m[2]), 0));
  return [first, last];
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Accepts today, yesterday, YYYY-MM-DD, or a signed day offset like -3. */
export function resolveDate(input: string | undefined): string {
  if (!input || input === 'today') return today();
  if (input === 'yesterday') return addDays(today(), -1);
  if (/^[+-]\d+$/.test(input)) return addDays(today(), Number(input));
  parseDate(input);
  return input;
}

/** Accepts a date inside the week, "this", "last", or a signed week offset. Returns Monday. */
export function resolveWeek(input: string | undefined): string {
  if (!input || input === 'this') return weekStart(today());
  if (input === 'last') return addDays(weekStart(today()), -7);
  if (/^[+-]\d+$/.test(input)) return addDays(weekStart(today()), 7 * Number(input));
  return weekStart(resolveDate(input));
}

/** Accepts YYYY-MM, "this", "last". */
export function resolveMonth(input: string | undefined): string {
  const t = parseDate(today());
  if (!input || input === 'this') return today().slice(0, 7);
  if (input === 'last') return fmtDate(new Date(t.getFullYear(), t.getMonth() - 1, 1)).slice(0, 7);
  monthRange(input);
  return input;
}
