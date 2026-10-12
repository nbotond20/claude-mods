import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import type { BrowserSession, OpenOptions } from './browser.ts';
import { redmineBase } from './redmine.ts';
import { SYSTEMS, type SystemId } from './types.ts';

/**
 * Where the browser is opened for a system. Redmine: always the bare Worktime page of the configured
 * Redmine (no query: Worktime acts on GET parameters); NetSuite: the configured address as is.
 */
export function startUrl(system: SystemId, url: string): string {
  return system === 'redmine' ? `${redmineBase(url)}/work_time/index` : url;
}

export const isSystem = (v: unknown): v is SystemId => typeof v === 'string' && (SYSTEMS as string[]).includes(v);

export interface CaptureFile {
  /** File name of the sanitized DOM copy */
  file: string;
  /** File name of the screenshot, when it was written */
  png: string | null;
  /** ISO time the capture was written */
  at: string;
}

/** Captures saved for a system, newest first. */
export function listCaptures(dir: string, max = 20): CaptureFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const pngs = new Set(names.filter((n) => n.endsWith('.png')));
  return names
    .filter((n) => n.endsWith('.html'))
    .map((file) => {
      const png = file.replace(/\.html$/, '.png');
      let at = 0;
      try {
        at = statSync(join(dir, file)).mtimeMs;
      } catch {
        /* removed meanwhile */
      }
      return { file, png: pngs.has(png) ? png : null, at };
    })
    .sort((a, b) => b.at - a.at || b.file.localeCompare(a.file))
    .slice(0, max)
    .map((c) => ({ ...c, at: new Date(c.at).toISOString() }));
}

type Opener = (opts?: OpenOptions) => Promise<BrowserSession>;

/**
 * The web server's one submission browser: opened on first use, dropped when the user closes
 * the window (or Chrome exits), closed with the server.
 */
export class SubmitSession {
  private session: BrowserSession | null = null;
  private opening: Promise<BrowserSession> | null = null;

  private readonly opener: Opener;

  constructor(opener: Opener = async (opts) => (await import('./browser.ts')).openBrowser(opts)) {
    this.opener = opener;
  }

  get open(): boolean {
    return this.session !== null;
  }

  /** The open browser, launching it if needed (concurrent callers share one launch). */
  async ensure(): Promise<BrowserSession> {
    if (this.session) return this.session;
    if (!this.opening) {
      this.opening = this.opener()
        .then((s) => {
          this.session = s;
          s.context.on('close', () => {
            if (this.session === s) this.session = null;
          });
          return s;
        })
        .finally(() => {
          this.opening = null;
        });
    }
    return this.opening;
  }

  /** The tab the user is looking at, or null when no browser is open. */
  current(): Page | null {
    return this.session?.current() ?? null;
  }

  async close(): Promise<void> {
    const s = this.session ?? (this.opening ? await this.opening.catch(() => null) : null);
    this.session = null;
    await s?.close();
  }
}
