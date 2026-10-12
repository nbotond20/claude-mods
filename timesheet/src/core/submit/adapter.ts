import type { Page } from 'playwright-core';
import type { Cell, Snapshot, SystemId } from './types.ts';

/**
 * The page is not in the state the adapter expects, so nothing was saved: unexpected URL, user,
 * date, a target missing or found twice, a dialog, a value that changed since the review. The
 * message is shown to the user as is.
 */
export class Abort extends Error {
  name = 'Abort';
}

/**
 * Something went wrong after the adapter pressed (or the user pressed) Update/Save: the site may
 * have changed, so it must be checked by hand. Never retried automatically.
 */
export class Failed extends Error {
  name = 'Failed';
}

export interface ApplyOptions {
  /** true: press Update/Save; false: fill in and wait for the user to press it */
  save: boolean;
  /** Cancelling never clicks anything: it aborts at the next check */
  signal: AbortSignal;
  /** Progress text for the UI/CLI */
  onState(msg: string): void;
  /** How long fill-only waits for the user to save (default 15 min) */
  userTimeoutMs?: number;
}

/** One unit of work (Redmine: a day; NetSuite: the week). */
export interface UnitWork<T> {
  /** Cells to enter into empty targets */
  write: Cell<T>[];
  /** What the reviewed snapshot holds in this unit: must still be there, unchanged, before writing */
  before: Cell<T>[];
}

export type LoginState = { ok: true; user: string } | { ok: false; reason: string };

/** Requests blocked in the browser while a step runs (e.g. Redmine GETs that change data). */
export interface Protection {
  /** Why a request was blocked (the step must stop), or null */
  problem(): string | null;
  dispose(): Promise<void>;
}

export interface Adapter<T, C> {
  system: SystemId;
  /**
   * Blocks requests that would change the site as a side effect (also the user's own clicks) for
   * as long as a preparation or run uses the browser. A blocked request stops the step.
   */
  protect?(page: Page, url: string): Promise<Protection>;
  /** Navigates to the start page and tells whether the session is logged in, and as whom. */
  checkLogin(page: Page, url: string): Promise<LoginState>;
  /** Reads what the site offers (rows, options) and who the user is. */
  discover(page: Page, url: string): Promise<C>;
  /** The configured address still points at the site the catalog was read from. */
  sameSite(catalog: C, url: string): boolean;
  /** The user the catalog was discovered for (compared with the logged-in one). */
  catalogUser(catalog: C): string;
  /** Whether a mapping target is still offered by the site. */
  exists(catalog: C, target: T): boolean;
  /** Human label of a target, e.g. "#9888 Secondary Learning Platform Development · Fejlesztés". */
  label(catalog: C | null, target: T): string;
  /** All non-zero values in the week (any row); throws Abort on anything unexpected. */
  read(page: Page, catalog: C, week: string, signal?: AbortSignal): Promise<Snapshot<T>>;
  /**
   * Writes the cells of one unit, verifies the inputs, and either saves (save=true) or waits for
   * the user to save; then verifies the site holds exactly before + write. Returns when saved.
   * Throws Abort before anything was submitted, Failed after.
   */
  apply(page: Page, catalog: C, unit: string, work: UnitWork<T>, opts: ApplyOptions): Promise<Cell<T>[]>;
  /** Units the cells fall into, in order (Redmine: dates; NetSuite: [week]). */
  units(week: string, cells: Cell<T>[]): string[];
  /** Which unit a cell belongs to. */
  unitOf(week: string, cell: Cell<T>): string;
}

/** Waits ms, or rejects with Abort when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Abort('cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Abort('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
