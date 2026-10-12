import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandName, commitType, describeChanges, fileArea, mergeWork, sessionWork, toolUse } from '../src/core/changes.ts';
import { parseStat } from '../src/core/collectors/git.ts';
import { categoriesFor } from '../src/core/config.ts';
import { enforce, inheritEmpty } from '../src/core/guards.ts';
import type { Block, BlockItem } from '../src/core/types.ts';
import { testConfig } from './helpers.ts';

describe('changes', () => {
  it('parses numstat with renames, binaries and created files', () => {
    const c = parseStat(['', '10\t2\tsrc/a.ts', '-\t-\tlogo.png', '3\t0\tsrc/{old => new}/b.ts', ' create mode 100644 src/a.ts']);
    assert.equal(c.added, 13);
    assert.equal(c.removed, 2);
    assert.deepEqual(c.files?.[0], { path: 'src/a.ts', added: 10, removed: 2, isNew: true });
    assert.equal(c.files?.[1].path, 'src/new/b.ts');
  });

  it('tags files by area', () => {
    assert.equal(fileArea('pnpm-lock.yaml'), 'deps');
    assert.equal(fileArea('.github/workflows/ci.yml'), 'ci');
    assert.equal(fileArea('helm/values.yaml'), 'infra');
    assert.equal(fileArea('src/auth/session.test.ts'), 'test');
    assert.equal(fileArea('README.md'), 'docs');
    assert.equal(fileArea('src/model/schema.generated.ts'), 'generated');
    assert.equal(fileArea('src/server.ts'), 'code');
  });

  it('reads commit types', () => {
    assert.equal(commitType('feat(api): add x'), 'feat');
    assert.equal(commitType('Pin dependencies'), 'deps');
    assert.equal(commitType('Revert "feat: x"'), 'revert');
    assert.equal(commitType('Describe recentModuleId by class'), 'other');
    const d = describeChanges([{ hash: 'a', repo: '/r', subject: 'fix: y', added: 5, removed: 1, files: [{ path: 'package.json', added: 1, removed: 1 }, { path: 'src/x.ts', added: 4, removed: 0, isNew: true }] }]);
    assert.deepEqual(d?.types, { fix: 1 });
    assert.equal(d?.lines, '+5/-1');
    assert.deepEqual(d?.fileAreas, { config: 1, code: 1 });
    assert.equal(d?.newFiles, 1);
  });

  it('keeps only program and subcommand of shell commands', () => {
    assert.equal(commandName('TOKEN=abc pnpm test --run'), 'pnpm test');
    assert.equal(commandName('kubectl logs pod-1 | tail'), 'kubectl logs');
    assert.equal(commandName('cd /x && git status'), 'git status');
    assert.equal(commandName('/usr/bin/curl -H "Authorization: x" https://a'), 'curl');
  });

  it('sums up assistant tool calls', () => {
    const w = sessionWork(
      [
        toolUse('Edit', { file_path: '/w/app/src/a.ts', old_string: 'a', new_string: 'a\nb\nc' }),
        toolUse('Write', { file_path: '/w/app/src/b.ts', content: '1\n2' }),
        toolUse('Edit', { file_path: '/w/app/src/a.ts', old_string: 'x\ny', new_string: 'z' }),
        toolUse('Read', { file_path: '/w/app/src/c.ts' }),
        toolUse('Bash', { command: 'pnpm test' }),
        toolUse('WebFetch', { url: 'x' }),
      ],
      '/w/app',
    );
    assert.deepEqual(w?.edits, [{ path: 'src/a.ts', added: 4, removed: 3 }, { path: 'src/b.ts', added: 2, removed: 0 }]);
    assert.deepEqual([w?.reads, w?.shell, w?.web, w?.commands], [1, 1, 1, ['pnpm test']]);
    assert.equal(sessionWork([]), undefined);
    const m = mergeWork(w, { edits: [{ path: 'src/a.ts', added: 1, removed: 0 }], reads: 2, shell: 0, web: 0, commands: ['git diff'] });
    assert.deepEqual(m?.edits[0], { path: 'src/a.ts', added: 5, removed: 3 });
    assert.deepEqual(m?.commands, ['pnpm test', 'git diff']);
  });
});

describe('guards', () => {
  const cats = categoriesFor(testConfig(), '2026-09-01');
  const M = 60_000;
  const item = (id: string, minutes: number, lines: number, extra: Partial<BlockItem> = {}): BlockItem => ({
    id, start: 0, end: minutes * M, sources: ['claude'], path: '/w/app', sessions: [], commits: [], texts: [],
    ...(lines ? { work: { edits: [{ path: 'src/a.ts', added: lines, removed: 0 }], reads: 0, shell: 0, web: 0, commands: [] } } : {}),
    ...extra,
  });
  const block = (items: BlockItem[], extra: Partial<Block> = {}): Block => ({
    id: 1, start: 0, end: Math.max(...items.map((i) => i.end)), kind: 'work', project: 'P', sources: ['claude'], branches: [], paths: ['/w/app'], texts: ['build it'], hint: 'Development', allocations: [], items, ...extra,
  });
  const approval = { kind: 'approval' as const, repo: 'o/r', title: 'Approved deployment to production', url: 'u' };

  it('limits Deployment to the time its events take', () => {
    const b = block([item('1.1', 200, 500)], { actions: [approval] });
    assert.deepEqual(enforce([{ category: 'Deployment', fraction: 0.7 }, { category: 'Development', fraction: 0.3 }], b, cats), [{ category: 'Development', fraction: 1 }]);
    const deployOnly = block([item('1.1', 20, 0)], { actions: [approval] });
    assert.deepEqual(enforce([{ category: 'Deployment', fraction: 1 }], deployOnly, cats), [{ category: 'Deployment', fraction: 1 }]);
  });

  it('keeps analysis categories out of time spent writing code', () => {
    const b = block([item('1.1', 60, 400), item('1.2', 60, 0)]);
    assert.deepEqual(enforce([{ category: 'Admin/Analysis', fraction: 1 }], b, cats), [{ category: 'Admin/Analysis', fraction: 0.5 }, { category: 'Development', fraction: 0.5 }]);
  });

  it('needs production evidence for Incident Management', () => {
    const b = block([item('1.1', 60, 50)], { texts: ['fix the sorting of the table'] });
    assert.deepEqual(enforce([{ category: 'Incident Management', fraction: 1 }], b, cats), [{ category: 'Small Enhancements', fraction: 1 }]);
    const approved = block([item('1.1', 60, 50)], { texts: ['fix the table', approval.title], actions: [approval] });
    assert.deepEqual(enforce([{ category: 'Incident Management', fraction: 1 }], approved, cats), [{ category: 'Small Enhancements', fraction: 1 }]);
    const prod = block([item('1.1', 60, 50)], { texts: ['pods restarting in production, fix it'] });
    assert.deepEqual(enforce([{ category: 'Incident Management', fraction: 1 }], prod, cats), [{ category: 'Incident Management', fraction: 1 }]);
  });

  it('gives empty blocks the category of their nearest neighbour', () => {
    const empty = block([item('1.1', 15, 0)], { id: 1, texts: ['/clear'] });
    const work = { ...block([item('2.1', 60, 300)]), id: 2, start: 20 * M, end: 80 * M };
    const allocations = { 1: [{ category: 'General', fraction: 1 }], 2: [{ category: 'Small Enhancements', fraction: 1 }] };
    inheritEmpty([empty, work], allocations);
    assert.deepEqual(allocations[1], [{ category: 'Small Enhancements', fraction: 1 }]);
  });
});
