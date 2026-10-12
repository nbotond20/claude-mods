import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { HOME } from '../config.ts';
import { sanitizeDocument } from './sanitize.ts';
import type { SystemId } from './types.ts';

export const INSPECT_DIR = join(HOME, 'inspect');

/** Same pattern as SECRET in sanitize.ts (which cannot import it). */
const SECRET_PARAM = /token|csrf|nonce|secret|passw|session|auth|key|sig|ticket|jwt|otp|saml|code/i;

/** The page URL without its fragment or credentials, and with secret-looking query values replaced. */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) if (SECRET_PARAM.test(key)) url.searchParams.set(key, '…');
    return url.toString();
  } catch {
    return '';
  }
}

/** Saves a sanitized DOM copy and a full-page screenshot of the page; both stay local until the user shares them. */
export async function capture(page: Page, system: SystemId, label: string, dir = INSPECT_DIR): Promise<{ html: string; png: string }> {
  const out = join(dir, system);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page';
  const base = join(out, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}`);
  const html = await page.evaluate(sanitizeDocument);
  writeFileSync(`${base}.html`, `<!-- ${safeUrl(page.url()).replace(/--/g, '- -')} -->\n${html}`, { mode: 0o600 });
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  return { html: `${base}.html`, png: `${base}.png` };
}
