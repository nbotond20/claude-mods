import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './config.ts';

/**
 * Secret storage for the Google OAuth client and tokens, and GitHub tokens.
 *
 * Backends, in order of preference:
 * - macOS Keychain via `security` (values are sent over stdin, never argv, so they
 *   do not show up in the process list),
 * - Linux Secret Service via `secret-tool` (value on stdin),
 * - a 0600 JSON file in ~/.timesheet as the last resort.
 *
 * TIMESHEET_SECRETS=file forces the file backend (used by tests).
 */

const SERVICE = 'timesheet';
const FILE = join(HOME, 'secrets.json');

export type SecretKey = 'google-client' | 'google-token' | 'github-tokens';

type Backend = 'keychain' | 'secret-service' | 'file';

function has(cmd: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
}

let cached: Backend | null = null;

export function secretBackend(): Backend {
  if (cached) return cached;
  if (process.env.TIMESHEET_SECRETS === 'file') cached = 'file';
  else if (process.platform === 'darwin' && has('security')) cached = 'keychain';
  else if (process.platform === 'linux' && has('secret-tool')) cached = 'secret-service';
  else cached = 'file';
  return cached;
}

function readFile(): Record<string, string> {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
}

function writeFile(data: Record<string, string>) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

// `security -i` reads commands from stdin; base64 keeps quoting trivial and the value off argv.
function keychain(command: string): { status: number | null; stdout: string } {
  const r = spawnSync('security', ['-i'], { input: command + '\n', encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

export function getSecret(key: SecretKey): string | null {
  switch (secretBackend()) {
    case 'keychain': {
      const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', key, '-w'], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      const raw = r.stdout.trim();
      return raw.startsWith('b64:') ? Buffer.from(raw.slice(4), 'base64').toString('utf8') : raw;
    }
    case 'secret-service': {
      const r = spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', key], { encoding: 'utf8' });
      return r.status === 0 && r.stdout ? r.stdout : null;
    }
    case 'file':
      return readFile()[key] ?? null;
  }
}

export function setSecret(key: SecretKey, value: string): void {
  switch (secretBackend()) {
    case 'keychain': {
      const encoded = 'b64:' + Buffer.from(value, 'utf8').toString('base64');
      const r = keychain(`add-generic-password -U -s ${SERVICE} -a ${key} -l "timesheet ${key}" -w ${encoded}`);
      if (r.status !== 0) throw new Error(`Could not write ${key} to the macOS Keychain`);
      return;
    }
    case 'secret-service': {
      const r = spawnSync('secret-tool', ['store', `--label=timesheet ${key}`, 'service', SERVICE, 'account', key], { input: value });
      if (r.status !== 0) throw new Error(`Could not write ${key} to the Secret Service`);
      return;
    }
    case 'file':
      writeFile({ ...readFile(), [key]: value });
  }
}

export function deleteSecret(key: SecretKey): void {
  switch (secretBackend()) {
    case 'keychain':
      spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', key], { stdio: 'ignore' });
      return;
    case 'secret-service':
      spawnSync('secret-tool', ['clear', 'service', SERVICE, 'account', key], { stdio: 'ignore' });
      return;
    case 'file': {
      const data = readFile();
      delete data[key];
      writeFile(data);
    }
  }
}

export function describeBackend(): string {
  return { keychain: 'macOS Keychain', 'secret-service': 'Secret Service (libsecret)', file: `${FILE} (mode 600)` }[secretBackend()];
}
