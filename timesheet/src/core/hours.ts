import type { Category } from './config.ts';
import type { Block, Entry } from './types.ts';

const H = 3_600_000;

export interface Override {
  project: string;
  category: string;
  hours: number;
}

/** Whole steps needed to cover `hours`: always rounds up (float noise aside). */
const stepsUp = (hours: number, step: number) => Math.ceil(hours / step - 1e-9);

/** `hours` rounded up to the next multiple of `step`. Booked time is never rounded down. */
export function roundUp(hours: number, step: number): number {
  return Number((stepsUp(hours, step) * step).toFixed(4));
}

/**
 * Splits `total` (rounded up to `step`) across items proportionally to `weights`, using the
 * largest-remainder method so the parts sum exactly to the total. Every item with activity
 * gets at least one step, so no category is rounded away.
 */
export function distribute(weights: number[], total: number, step: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const active = weights.filter((w) => w > 0).length;
  const units = Math.max(stepsUp(total, step), active);
  const quotas = weights.map((w) => (w / sum) * units);
  const floors = quotas.map((q, i) => (weights[i] > 0 ? Math.max(1, Math.floor(q)) : 0));
  let left = units - floors.reduce((a, b) => a + b, 0);
  // Minimums can overshoot: take the excess back from the items furthest above their quota.
  while (left < 0) {
    const i = floors.reduce((best, f, j) => (f > 1 && (best < 0 || f - quotas[j] > floors[best] - quotas[best]) ? j : best), -1);
    if (i < 0) break;
    floors[i]--;
    left++;
  }
  const order = quotas.map((q, i) => ({ i, r: q - Math.floor(q) })).sort((a, b) => b.r - a.r || weights[b.i] - weights[a.i]);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]++;
    left--;
  }
  return floors.map((u) => Number((u * step).toFixed(4)));
}

/**
 * Real hours (and recorded minutes, when every block has them) per (project, category) from block allocations.
 * Real hours are the recorded minutes when known: block padding, lead-ins and bridged gaps are never counted as real.
 */
export function realByCategory(blocks: Block[]): Map<string, { project: string; category: string; real: number; measured?: number }> {
  const out = new Map<string, { project: string; category: string; real: number; measured?: number }>();
  const measured = blocks.every((b) => b.measured !== undefined);
  for (const b of blocks) {
    for (const a of b.allocations) {
      const key = `${b.project}\t${a.category}`;
      const cur = out.get(key) ?? { project: b.project, category: a.category, real: 0, ...(measured ? { measured: 0 } : {}) };
      cur.real += (measured ? (b.measured! * 60_000) / H : (b.end - b.start) / H) * a.fraction;
      if (measured) cur.measured! += b.measured! * a.fraction;
      out.set(key, cur);
    }
  }
  return out;
}

/**
 * Entries to book. With a target the day is scaled to exactly `target` hours; with a null
 * target real hours are only rounded. Days without activity stay at 0. Overrides replace the
 * computed hours of their entry (or add one) without rebalancing the rest.
 */
export function buildEntries(
  blocks: Block[],
  categories: Category[],
  target: number | null,
  step: number,
  overrides: Override[] = [],
): Entry[] {
  const capex = new Map(categories.map((c) => [c.name, c.capex]));
  const rows = [...realByCategory(blocks).values()].sort((a, b) => b.real - a.real);
  // Without a target each entry is its real time rounded up; with one, the day adds up to it.
  const hours = target === null ? rows.map((r) => roundUp(r.real, step)) : distribute(rows.map((r) => r.real), target, step);
  const entries: Entry[] = rows.map((r, i) => ({ ...r, capex: capex.get(r.category) ?? false, hours: hours[i] }));

  for (const o of overrides) {
    const e = entries.find((x) => x.project === o.project && x.category === o.category);
    if (e) Object.assign(e, { hours: o.hours, overridden: true });
    else entries.push({ project: o.project, category: o.category, capex: capex.get(o.category) ?? false, real: 0, hours: o.hours, overridden: true });
  }
  return entries;
}
