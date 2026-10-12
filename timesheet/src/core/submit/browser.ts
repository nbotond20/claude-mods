import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** Creates the lock with our pid in one step (a hard link), so a reader never sees it empty; false if it exists. */
function createLock(path: string): boolean {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, String(process.pid));
  try {
    linkSync(temp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** One submission browser at a time: returns a release function, throws if a live process holds the lock. */
export function acquireLock(path = LOCK_PATH): () => void {
  if (!createLock(path)) {
    let text: string | undefined;
    try {
      text = readFileSync(path, 'utf8').trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // released meanwhile: the create below decides
    }
    if (text !== undefined) {
      const pid = /^\d+$/.test(text) ? Number(text) : NaN;
      // Unreadable content may be a lock still being written: held, unless it has been like that for a while.
      if (Number.isNaN(pid) && Date.now() - statSync(path).mtimeMs < 60_000) throw new Error('the submission browser is already in use (unreadable lock file)');
      if (alive(pid)) throw new Error(`the submission browser is already in use by process ${pid}`);
      rmSync(path, { force: true });
    }
    if (!createLock(path)) throw new Error('the submission browser is already in use by another process');
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
  /** The most recently opened tab (the user may open new ones) */
  current(): Page;
  close(): Promise<void>;
}

export interface OpenOptions {
  headless?: boolean;
  profileDir?: string;
  lockPath?: string;
}

/** A launch failure in words the user can act on. */
export function launchError(e: Error): Error {
  if (/is not found|executable doesn't exist/i.test(e.message)) return new Error('Google Chrome is required for submission; install it from google.com/chrome');
  if (/ProcessSingleton|profile appears to be in use|SingletonLock/i.test(e.message)) return new Error('the submission browser profile is open in another Chrome window; close it and retry');
  return e;
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
      // Without --enable-automation, Google sign-in (SSO) does not refuse the browser as automated.
      .launchPersistentContext(dir, { channel: 'chrome', headless: opts.headless ?? false, viewport: null, ignoreDefaultArgs: ['--enable-automation'] })
      .catch((e: Error) => {
        throw launchError(e);
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
