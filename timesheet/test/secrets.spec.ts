import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
process.env.TIMESHEET_SECRETS = 'file';
await import('./helpers.ts');
const { deleteSecret, getSecret, setSecret, secretBackend } = await import('../src/core/secrets.ts');
const { parseClientJson } = await import('../src/core/collectors/gcal.ts');
const { HOME } = await import('../src/core/config.ts');

describe('secrets', () => {
  it('round-trips through a 0600 file when no keychain is used', () => {
    assert.equal(secretBackend(), 'file');
    setSecret('google-token', '{"a":1}');
    assert.equal(getSecret('google-token'), '{"a":1}');
    assert.equal(statSync(join(HOME, 'secrets.json')).mode & 0o777, 0o600);
    deleteSecret('google-token');
    assert.equal(getSecret('google-token'), null);
  });

  it('accepts the downloaded Google client JSON and rejects anything else', () => {
    const c = parseClientJson(JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } }));
    assert.deepEqual(c, { client_id: 'x.apps.googleusercontent.com', client_secret: 's' });
    assert.throws(() => parseClientJson('{"client_id":"nope","client_secret":"s"}'));
  });
});
