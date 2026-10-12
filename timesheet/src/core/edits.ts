import type { Config } from './config.ts';
import { categoriesFor } from './config.ts';
import type { Store } from './store.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a hand edit of `date` is refused, or null when it may go ahead. */
function dayProblem(store: Store, date: string): string | null {
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00`))) return `"${date}" is not a date (YYYY-MM-DD)`;
  if (store.isLocked(date)) return `${date} is locked (submitted or locked by hand); unlock it first: timesheet unlock ${date}`;
  return null;
}

/**
 * Checks an hour override: a known category valid on that date, a configured project, and hours that
 * are a non-negative multiple of the rounding step (null clears the override).
 */
export function hoursEditProblem(config: Config, store: Store, date: string, project: string, category: string, hours: number | null): string | null {
  const day = dayProblem(store, date);
  if (day) return day;
  if (!config.projects.includes(project)) return `unknown project "${project}" (configured: ${config.projects.join(', ')})`;
  if (hours !== null && !categoriesFor(config, date).some((c) => c.name === category)) return `unknown category "${category}" on ${date}`;
  if (hours === null) return null;
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return `hours must be a number from 0 to 24, not ${hours}`;
  const steps = hours / config.rounding;
  if (Math.abs(steps - Math.round(steps)) > 1e-6) return `hours must be a multiple of the rounding step (${config.rounding}h): ${hours} is not`;
  return null;
}

/** Checks a block recategorization: the block exists on the stored day and the category is known. */
export function blockEditProblem(config: Config, store: Store, date: string, blockId: number, category: string | null): string | null {
  const day = dayProblem(store, date);
  if (day) return day;
  if (!Number.isInteger(blockId)) return `block id must be a whole number, not ${blockId}`;
  const stored = store.getDay(date);
  if (!stored) return `${date} is not computed yet`;
  if (!stored.blocks.some((b) => b.id === blockId)) return `${date} has no block ${blockId} (blocks: ${stored.blocks.map((b) => b.id).join(', ') || 'none'})`;
  if (category !== null && !categoriesFor(config, date).some((c) => c.name === category)) return `unknown category "${category}" on ${date}`;
  return null;
}

export interface RecomputeImpact {
  /** Days before `from` re-stamped with the new settings, so they keep their hours */
  kept: number;
  /** Cached days that recompute when next shown */
  recompute: number;
  /** Locked days, kept whatever changed */
  locked: number;
}

/**
 * After a settings change from `oldKey` to `newKey`: with `from`, cached days before it that were
 * computed with the old settings are re-stamped so they are not recomputed. Counts what happens to the rest.
 */
export function applySettingsChange(store: Store, oldKey: string, newKey: string, from?: string): RecomputeImpact {
  const impact: RecomputeImpact = { kept: 0, recompute: 0, locked: 0 };
  if (oldKey === newKey) return impact;
  for (const d of store.cachedDates()) {
    const day = store.getDay(d);
    if (!day) continue;
    if (store.isLocked(d)) impact.locked++;
    else if (from && d < from && day.computeKey === oldKey) {
      store.saveDay({ ...day, computeKey: newKey });
      impact.kept++;
    } else if (day.computeKey !== newKey) impact.recompute++;
  }
  return impact;
}
