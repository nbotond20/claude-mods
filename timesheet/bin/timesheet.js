#!/usr/bin/env -S node --experimental-sqlite --no-warnings
// From a checkout, run the TypeScript sources directly (Node strips types).
// From an installed package (under node_modules, where Node will not strip types),
// run the bundled build.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = new URL('../src/cli.ts', import.meta.url);
const installed = fileURLToPath(import.meta.url).includes('/node_modules/');
await import(!installed && existsSync(fileURLToPath(src)) ? src.href : new URL('../dist/timesheet.mjs', import.meta.url).href);
