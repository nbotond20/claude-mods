import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate every test run from the real ~/.timesheet before config.ts is imported.
process.env.TIMESHEET_HOME = mkdtempSync(join(tmpdir(), 'timesheet-test-'));

const { defaultConfig } = await import('../src/core/config.ts');
const { CATEGORIES } = await import('./example-categories.ts');
export { CATEGORIES };
type Config = import('../src/core/config.ts').Config;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...defaultConfig(),
    categories: CATEGORIES,
    claudeDirs: [],
    opencodeDirs: [],
    // Span expectations are written against a 5-minute prompt lead-in.
    promptLeadMinutes: 5,
    // Fixture days are sparse; the low-activity check has its own tests.
    lowActivityRatio: 0,
    scope: { work: [{ path: '/work/**', project: 'Default' }], personal: ['/home/**'] },
    ...overrides,
  };
}

/** Local-time epoch ms for a date and HH:MM. */
export function at(date: string, hhmm: string): number {
  return new Date(`${date}T${hhmm}:00`).getTime();
}
