import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_VERSION, compareVersions, probe, probeHttp } from '../src/web/port.ts';

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
    assert.deepEqual(await probeHttp(current.port), { kind: 'timesheet', version: '9.9.9', pid: 42 });

    const legacy = await listen((req, res) => (req.url === '/api/meta' ? send(res, 200, { target: 8, categories: [] }) : send(res, 404, { error: 'not found' })));
    assert.deepEqual(await probeHttp(legacy.port), { kind: 'timesheet', version: null, pid: null });

    const foreign = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    });
    assert.deepEqual(await probe(foreign.port), { kind: 'foreign' });

    // A process that only claims to be timesheet (and names some other pid) is foreign: the OS says who listens.
    assert.deepEqual(await probe(current.port), process.platform === 'win32' ? { kind: 'timesheet', version: '9.9.9', pid: null } : { kind: 'foreign' });

    for (const s of [current, legacy, foreign]) s.server.close();
  });
});
