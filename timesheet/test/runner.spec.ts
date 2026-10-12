import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseEnvelope, resolveInvocation } from '../src/core/claude-runner.ts';

describe('claude runner', () => {
  it('finds the result envelope after shell noise', () => {
    const out = 'Using Node v24.20.0\n{"type":"result","is_error":false,"result":"{\\"ok\\":true}"}\n';
    assert.deepEqual(parseEnvelope(out), { result: '{"ok":true}', isError: false });
    assert.throws(() => parseEnvelope('zsh: command not found: nope\n'), /no result/);
  });

  it('runs binaries directly and shell functions through the login shell', () => {
    assert.equal(resolveInvocation('node', ['-v']).viaShell, false);
    const fn = resolveInvocation('claude-some-profile', ['-p', '--model', 'haiku']);
    assert.equal(fn.viaShell, true);
    assert.deepEqual(fn.args.slice(0, 3), ['-ic', 'claude-some-profile "$@"', 'timesheet-classifier']);
    assert.deepEqual(fn.args.slice(3), ['-p', '--model', 'haiku'], 'arguments are forwarded, never interpolated');
    assert.equal(resolveInvocation('claude --foo', []).viaShell, true);
  });
});
