import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { at, testConfig } from './helpers.ts';
import { collectOpenCode, payloadText } from '../src/core/collectors/opencode.ts';

const D = '2026-09-15';
const range: [number, number] = [at(D, '00:00'), at('2026-09-16', '00:00')];

describe('opencode collector', () => {
  it('extracts text from every payload shape', () => {
    assert.equal(payloadText({ text: 'a' }), 'a');
    assert.equal(payloadText({ content: [{ type: 'text', text: 'b' }, { type: 'tool', name: 'x' }] }), 'b');
    assert.equal(payloadText({ parts: [{ type: 'text', text: 'c' }, { type: 'text', text: 'hidden', synthetic: true }] }), 'c');
    assert.equal(payloadText({ content: 'd' }), 'd');
  });

  it('reads the 2.x session_v2 / session_message database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc2-'));
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)').run('s1', 'p', '/work/api', at(D, '09:00'), at(D, '10:30'));
    const msg = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    msg.run('m1', 's1', 'user', 1, at(D, '09:00'), at(D, '09:00'), JSON.stringify({ content: [{ type: 'text', text: 'add rate limiting' }] }));
    msg.run('m2', 's1', 'assistant', 2, at(D, '09:01'), at(D, '09:40'), JSON.stringify({ content: [] }));
    msg.run('m3', 's1', 'user', 3, at(D, '14:00'), at(D, '14:00'), JSON.stringify({ text: 'write tests' }));
    msg.run('m4', 's1', 'assistant', 4, at(D, '14:01'), at(D, '14:20'), '{}');
    db.close();
    const events = await collectOpenCode(testConfig({ opencodeDirs: [dir], idleMinutes: 60 }), ...range);
    assert.equal(events.length, 2);
    assert.deepEqual([events[0].source, events[0].path, events[0].start, events[0].end], ['opencode', '/work/api', at(D, '08:55'), at(D, '09:40')]);
    assert.deepEqual(events[0].texts, ['add rate limiting']);
    assert.deepEqual(events[1].texts, ['write tests']);
  });

  it('reads the 1.x session / message / part database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc1-'));
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('s1', 'p', '/work/web', 't', at(D, '11:00'), at(D, '12:00'));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 's1', at(D, '11:00'), JSON.stringify({ role: 'user', time: { created: at(D, '11:00') } }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 's1', at(D, '11:01'), JSON.stringify({ role: 'assistant', time: { created: at(D, '11:01'), completed: at(D, '11:50') }, path: { cwd: '/work/web' } }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p1', 'm1', 's1', JSON.stringify({ type: 'text', text: 'fix login redirect' }));
    db.close();
    const [ev] = await collectOpenCode(testConfig({ opencodeDirs: [dir], idleMinutes: 60 }), ...range);
    assert.deepEqual([ev.start, ev.end, ev.texts], [at(D, '10:55'), at(D, '11:50'), ['fix login redirect']]);
  });

  it('reads the legacy JSON storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocj-'));
    const w = (p: string, v: unknown) => {
      mkdirSync(join(dir, 'storage', p, '..'), { recursive: true });
      writeFileSync(join(dir, 'storage', p), JSON.stringify(v));
    };
    w('session/proj/ses_1.json', { id: 'ses_1', directory: '/work/cli', time: { created: at(D, '15:00') } });
    w('message/ses_1/msg_1.json', { id: 'msg_1', role: 'user', time: { created: at(D, '15:00') } });
    w('message/ses_1/msg_2.json', { id: 'msg_2', role: 'assistant', time: { created: at(D, '15:01'), completed: at(D, '15:30') } });
    w('part/msg_1/prt_1.json', { type: 'text', text: 'refactor config loader' });
    const [ev] = await collectOpenCode(testConfig({ opencodeDirs: [dir], idleMinutes: 60 }), ...range);
    assert.deepEqual([ev.path, ev.end, ev.texts], ['/work/cli', at(D, '15:30'), ['refactor config loader']]);
  });

  it('ignores missing directories', async () => {
    assert.deepEqual(await collectOpenCode(testConfig({ opencodeDirs: ['/nope'] }), ...range), []);
  });
});
