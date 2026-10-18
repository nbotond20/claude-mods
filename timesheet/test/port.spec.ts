import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_VERSION, compareVersions, decide, portTakenMessage, probe, probeHttp } from '../src/web/port.ts';

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port };
}

const send = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('serve port claim', () => {
  it('compares versions numerically', () => {
    assert.equal(compareVersions('0.3.10', '0.3.9'), 1);
    assert.equal(compareVersions('0.3.2', '0.3.2'), 0);
    assert.equal(compareVersions('0.2.0', '0.3.2'), -1);
    assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it('tells a free port, a current server, an older server and a foreign one apart', async () => {
    const { server: s0, port: free } = await listen(() => {});
    await new Promise((r) => s0.close(r));
    assert.deepEqual(await probe(free), { kind: 'free' });

    const current = await listen((req, res) => (req.url === '/api/version' ? send(res, 200, { app: 'timesheet', version: '9.9.9', pid: 42 }) : send(res, 404, {})));
    assert.deepEqual(await probeHttp(current.port), { kind: 'timesheet', version: '9.9.9', pid: 42, root: null });

    const legacy = await listen((req, res) => (req.url === '/api/meta' ? send(res, 200, { target: 8, categories: [] }) : send(res, 404, { error: 'not found' })));
    assert.deepEqual(await probeHttp(legacy.port), { kind: 'timesheet', version: null, pid: null });

    const foreign = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    const held = await probe(foreign.port);
    assert.equal(held.kind, 'foreign');
    // the OS names the holder (this test process), so the error can say what to stop
    if (process.platform !== 'win32' && held.kind === 'foreign') {
      assert.equal(held.pid, process.pid);
      assert.match(portTakenMessage(foreign.port, held), new RegExp(`port ${foreign.port} is in use by another program \\(pid ${process.pid}: .*node.*--port <n>`));
    }

    // A process that only claims to be timesheet (and names some other pid) is foreign: the OS says who listens.
    assert.deepEqual(process.platform === 'win32' ? await probe(current.port) : (await probe(current.port)).kind, process.platform === 'win32' ? { kind: 'timesheet', version: '9.9.9', pid: null, root: null } : 'foreign');

    for (const s of [current, legacy, foreign]) s.server.close();
  });

  it('reuses a newer or same-version server and replaces an older, unknown or deleted one: never a downgrade', () => {
    const at = (version: string | null, root: string | null = '/plugins/timesheet/x') => ({ kind: 'timesheet' as const, version, pid: 1, root });
    const exists = (p: string) => p !== '/gone';
    assert.equal(decide(at('0.4.0'), '0.3.8', false, exists), 'reuse');
    assert.equal(decide(at('0.4.0'), '0.3.8', true, exists), 'reuse');
    assert.equal(decide(at('0.3.8'), '0.3.8', false, exists), 'reuse');
    assert.equal(decide(at('0.3.8'), '0.3.8', true, exists), 'replace');
    assert.equal(decide(at('0.3.8', '/gone'), '0.3.8', false, exists), 'replace');
    assert.equal(decide(at('0.3.8', null), '0.3.8', false, exists), 'reuse');
    assert.equal(decide(at('0.3.7'), '0.3.8', false, exists), 'replace');
    assert.equal(decide(at('0.3.10'), '0.3.9', false, exists), 'reuse');
    assert.equal(decide(at(null), '0.3.8', false, exists), 'replace');
  });
});
