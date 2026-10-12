import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root (the directory holding package.json), whether running from src/ or the bundled dist/. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('timesheet: package root not found');
    dir = up;
  }
  return dir;
}
