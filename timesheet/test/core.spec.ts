import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { at, testConfig } from './helpers.ts';
import { Scope, globToRegex } from '../src/core/scope.ts';
import { buildEntries, distribute } from '../src/core/hours.ts';
import { buildBlocks, subtract } from '../src/core/timeline.ts';
import type { WorkEvent } from '../src/core/timeline.ts';
import { defaultCategory, parseResponse, sanitize } from '../src/core/classify.ts';
import { parseSession, promptText } from '../src/core/collectors/claude.ts';
import { spansFromPoints } from '../src/core/collectors/spans.ts';
import { toRawEvent } from '../src/core/collectors/gcal.ts';
import { formatDaily, formatGrid, formatLines, num } from '../src/core/format.ts';
import { addDays, monthRange, weekStart } from '../src/core/dates.ts';
import { categoriesFor, targetFor } from '../src/core/config.ts';
import type { Block, DayReport } from '../src/core/types.ts';

const D = '2026-09-15';
const H = 3_600_000;

describe('dates', () => {
  it('finds Monday and month bounds', () => {
    assert.equal(weekStart('2026-09-30'), '2026-09-28');
    assert.equal(weekStart('2026-10-04'), '2026-09-28');
    assert.deepEqual(monthRange('2026-02'), ['2026-02-01', '2026-02-28']);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
});

describe('scope', () => {
  it('matches globs recursively including the directory itself', () => {
    const re = globToRegex('/a/b/**');
    assert.ok(re.test('/a/b'));
    assert.ok(re.test('/a/b/c/d'));
    assert.ok(!re.test('/a/bc'));
    assert.ok(globToRegex('/a/*/x').test('/a/foo/x'));
    assert.ok(!globToRegex('/a/*/x').test('/a/foo/bar/x'));
  });

  it('most specific rule wins and unknown paths stay unknown', () => {
    const scope = new Scope(
      testConfig({
        scope: { work: [{ path: '/work/**', project: 'A' }, { path: '/home/side/client/**', project: 'B' }], personal: ['/home/**', '/work/private/**'] },
      }),
    );
    assert.deepEqual(scope.resolve('/work/repo/src'), { kind: 'work', project: 'A' });
    assert.deepEqual(scope.resolve('/home/side/client'), { kind: 'work', project: 'B' });
    assert.deepEqual(scope.resolve('/work/private/x'), { kind: 'personal' });
    assert.deepEqual(scope.resolve('/home/x'), { kind: 'personal' });
    assert.deepEqual(scope.resolve('/elsewhere'), { kind: 'unknown' });
    assert.deepEqual(scope.resolve('/private/tmp/scratch'), { kind: 'personal', system: true });
  });
});

describe('hours', () => {
  it('distributes with largest remainder to an exact total', () => {
    const parts = distribute([5, 2, 1], 8, 0.25);
    assert.equal(parts.reduce((a, b) => a + b, 0), 8);
    assert.deepEqual(parts, [5, 2, 1]);
    const odd = distribute([1, 1, 1], 8, 0.25);
    assert.equal(odd.reduce((a, b) => a + b, 0), 8);
    assert.ok(odd.every((x) => (x / 0.25) % 1 === 0));
  });

  it('keeps zero-activity days at zero', () => {
    assert.deepEqual(distribute([0, 0], 8, 0.25), [0, 0]);
    assert.deepEqual(buildEntries([], [], 8, 0.25), []);
  });

  const block = (start: string, end: string, category: string, project = 'Default'): Block => ({
    id: 1, start: at(D, start), end: at(D, end), kind: 'work', project, sources: ['claude'], branches: [], paths: [], texts: [], hint: category,
    allocations: [{ category, fraction: 1 }],
  });

  it('normalizes to target, or rounds real hours with a null target', () => {
    const blocks = [block('09:00', '12:00', 'Development'), block('13:00', '14:00', 'Testing')];
    const cats = [{ name: 'Development', subtask: '', description: '', capex: true }, { name: 'Testing', subtask: '', description: '', capex: true }];
    const norm = buildEntries(blocks, cats, 8, 0.25);
    assert.deepEqual(norm.map((e) => [e.category, e.hours]), [['Development', 6], ['Testing', 2]]);
    const real = buildEntries(blocks, cats, null, 0.25);
    assert.deepEqual(real.map((e) => e.hours), [3, 1]);
  });

  it('applies overrides without rebalancing', () => {
    const e = buildEntries([block('09:00', '17:00', 'Development')], [], 8, 0.25, [
      { project: 'Default', category: 'Development', hours: 6 },
      { project: 'Default', category: 'Training', hours: 2 },
    ]);
    assert.deepEqual(e.map((x) => [x.category, x.hours, x.overridden]), [['Development', 6, true], ['Training', 2, true]]);
  });
});

describe('rounding', () => {
  it('never rounds booked hours down', () => {
    assert.deepEqual(distribute([6.1], 6.1, 0.25), [6.25]);
    assert.deepEqual(distribute([7, 0.05], 8, 0.25), [7.75, 0.25]);
    const e = buildEntries([{ id: 1, start: 0, end: 6.1 * 3_600_000, kind: 'work', project: 'P', sources: ['git'], branches: [], paths: [], texts: [], hint: 'Development', allocations: [{ category: 'Development', fraction: 1 }] }], [], null, 0.25);
    assert.equal(e[0].hours, 6.25);
    assert.equal(num(6.181, testConfig()), '6.19');
  });
});

describe('timeline', () => {
  const cfg = testConfig();
  const [start, end] = [at(D, '00:00'), at(addDays(D, 1), '00:00')];
  const ev = (s: string, e: string, extra: Partial<WorkEvent> = {}): WorkEvent => ({
    source: 'claude', start: at(D, s), end: at(D, e), path: '/work/r', texts: ['x'], project: 'Default', ...extra,
  });

  it('merges activity with gaps up to gapMinutes and splits on longer gaps', () => {
    const blocks = buildBlocks([ev('09:00', '09:40'), ev('10:05', '11:00'), ev('12:00', '12:30')], cfg, start, end);
    assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[at(D, '09:00'), at(D, '11:00')], [at(D, '12:00'), at(D, '12:30')]]);
  });

  it('keeps the sessions and commits behind a merged block', () => {
    const session = { id: 's1', source: 'claude' as const, path: '/work/r' };
    const [b] = buildBlocks([ev('09:00', '09:40', { session }), ev('09:50', '10:00', { source: 'git', commit: 'abc123', texts: ['fix: y'] }), ev('10:05', '10:30', { session })], cfg, start, end);
    assert.deepEqual(b.sessions, [session]);
    assert.deepEqual(b.commits, [{ hash: 'abc123', repo: '/work/r', subject: 'fix: y' }]);
  });

  it('keeps parallel work in different repos as separate items', () => {
    const [b] = buildBlocks([ev('09:00', '10:00', { path: '/work/a' }), ev('09:15', '09:45', { path: '/work/b' }), ev('09:30', '09:50', { path: '/work/a' })], cfg, start, end);
    assert.deepEqual(b.items?.map((i) => [i.path, i.start, i.end]), [['/work/a', at(D, '09:00'), at(D, '10:00')], ['/work/b', at(D, '09:15'), at(D, '09:45')]]);
  });

  it('pads short blocks to minBlockMinutes', () => {
    const [b] = buildBlocks([ev('09:00', '09:02', { source: 'git' })], cfg, start, end);
    assert.equal(b.end - b.start, 15 * 60_000);
  });

  it('records session time without the prompt lead-in or an assumed history tail', () => {
    const cfg = testConfig({ idleMinutes: 60 });
    const [s] = spansFromPoints([{ t: at(D, '09:10'), cwd: '/work/a', prompt: 'go' }, { t: at(D, '09:40'), cwd: '/work/a' }], 'claude', at(D, '00:00'), at(D, '23:59'), cfg);
    assert.deepEqual([s.start, s.end, s.measured], [at(D, '09:05'), at(D, '09:40'), [[at(D, '09:10'), at(D, '09:40')]]]);
    const [h] = spansFromPoints([{ t: at(D, '11:00'), end: at(D, '11:10'), endAssumed: true, cwd: '/work/a', prompt: 'x' }], 'claude', at(D, '00:00'), at(D, '23:59'), cfg);
    assert.equal(h.end, at(D, '11:10'));
    assert.deepEqual(h.measured, [], 'a single history prompt has no recorded duration');
  });

  it('drops assistant work left running unattended and stops recording at quiet gaps', () => {
    const cfg = testConfig({ idleMinutes: 10 });
    const [s] = spansFromPoints(
      [
        { t: at(D, '23:00'), cwd: '/work/a', prompt: 'release it' },
        { t: at(D, '23:05'), end: at(D, '23:30'), cwd: '/work/a' },
        { t: at(D, '23:40'), cwd: '/work/a' },
      ],
      'claude', at(D, '00:00'), at(D, '23:59'), cfg,
    );
    assert.deepEqual([s.end, s.measured], [at(D, '23:10'), [[at(D, '23:00'), at(D, '23:10')]]], 'nothing after ten minutes past the prompt');
    const [g] = spansFromPoints(
      [
        { t: at(D, '09:00'), cwd: '/work/a', prompt: 'a' },
        { t: at(D, '09:05'), cwd: '/work/a' },
        { t: at(D, '09:25'), cwd: '/work/a', prompt: 'b' },
        { t: at(D, '09:28'), cwd: '/work/a' },
      ],
      'claude', at(D, '00:00'), at(D, '23:59'), cfg,
    );
    assert.deepEqual(g.measured, [[at(D, '09:00'), at(D, '09:05')], [at(D, '09:25'), at(D, '09:28')]], 'a 20-minute quiet gap is not recorded');
  });

  it('gives meetings precedence over overlapping work', () => {
    const blocks = buildBlocks(
      [ev('09:00', '12:00'), { source: 'calendar', start: at(D, '10:00'), end: at(D, '11:00'), texts: ['Standup'], project: 'Default' }],
      cfg, start, end,
    );
    assert.deepEqual(blocks.map((b) => [b.kind, (b.end - b.start) / H]), [['work', 1], ['meeting', 1], ['work', 1]]);
  });

  it('counts overlapping projects once', () => {
    const blocks = buildBlocks([ev('09:00', '11:00'), ev('10:00', '12:00', { project: 'Other' })], cfg, start, end);
    assert.equal(blocks.reduce((s, b) => s + (b.end - b.start), 0), 3 * H);
  });

  it('subtract handles containment and edges', () => {
    assert.deepEqual(subtract(0, 10, [[2, 4], [6, 20]]), [[0, 2], [4, 6]]);
  });
});

describe('classify', () => {
  const cfg = testConfig();
  const cats = categoriesFor(cfg, D);
  const base = { id: 1, start: 0, end: H, project: 'Default', sources: ['git' as const], paths: [], hint: '', allocations: [] };

  it('defaults meetings to Team Meeting and other work to Development', () => {
    assert.equal(defaultCategory('meeting', cats), 'Team Meeting');
    assert.equal(defaultCategory('work', cats), 'Development');
    assert.equal(defaultCategory('work', cats.filter((c) => c.name !== 'Development')), 'General');
  });

  it('parses fenced JSON and sanitizes unknown categories and slivers', () => {
    const out = parseResponse('```json\n{"blocks":[{"id":1,"allocations":[{"category":"Development","fraction":0.9},{"category":"Testing","fraction":0.1}]},{"id":2,"allocations":[{"category":"Nope","fraction":1}]}],"summary":"- did things"}\n```');
    const blocks = [{ ...base, id: 1, kind: 'work' as const, branches: [], texts: [], hint: 'Development' }, { ...base, id: 2, kind: 'meeting' as const, branches: [], texts: [], hint: 'Team Meeting' }];
    const s = sanitize(out, blocks, cats);
    assert.deepEqual(s.allocations[1], [{ category: 'Development', fraction: 1 }]);
    assert.deepEqual(s.allocations[2], [{ category: 'Team Meeting', fraction: 1 }]);
    assert.equal(s.summary, '- did things');
  });

  it('keeps block and item summaries and never falls back to a prompt', () => {
    const out = parseResponse('{"blocks":[{"id":1,"summary":"Fixed login race","allocations":[{"category":"Development","fraction":1}],"items":[{"id":"1.1","summary":"Reproduced the race"}]}],"summary":"- x"}');
    const item = { id: '1.1', start: 0, end: H, sources: ['claude' as const], path: '/work/app', sessions: [], commits: [], texts: ['secret prompt'] };
    const blocks = [
      { ...base, id: 1, kind: 'work' as const, branches: [], texts: ['a'], hint: 'Development', items: [item] },
      { ...base, id: 2, kind: 'work' as const, branches: [], paths: ['/work/app'], texts: ['add retries please'], hint: 'Development', items: [{ ...item, id: '2.1' }] },
    ];
    const s = sanitize(out, blocks, cats);
    assert.equal(s.blockSummaries?.[1], 'Fixed login race');
    assert.equal(s.itemSummaries?.['1.1'], 'Reproduced the race');
    assert.equal(s.blockSummaries?.[2], 'Work in app');
    assert.equal(s.itemSummaries?.['2.1'], 'Work in app');
  });

  it('hides legacy categories after their end date', () => {
    assert.ok(categoriesFor(cfg, '2026-12-31').some((c) => c.name === 'Maintenance'));
    assert.ok(!categoriesFor(cfg, '2027-01-01').some((c) => c.name === 'Maintenance'));
  });

  it('uses weekday targets', () => {
    assert.equal(targetFor(cfg, '2026-09-15'), 8);
    assert.equal(targetFor(cfg, '2026-09-19'), null);
    assert.equal(targetFor(cfg, '2026-09-15', 6), 6);
  });
});

describe('claude collector', () => {
  it('extracts human prompts and skips tool results and system noise', () => {
    assert.equal(promptText({ type: 'user', message: { content: 'fix the bug' } }), 'fix the bug');
    assert.equal(promptText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
    assert.equal(promptText({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
    assert.equal(promptText({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }), '/clear');
  });

  it('builds spans including time waiting on Claude, split on long gaps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-claude-'));
    const lines = [
      { type: 'user', timestamp: new Date(at(D, '09:00')).toISOString(), cwd: '/work/r', gitBranch: 'feat/a', message: { content: 'add login' } },
      { type: 'assistant', timestamp: new Date(at(D, '09:20')).toISOString(), cwd: '/work/r/src', message: { content: [] } },
      { type: 'user', timestamp: new Date(at(D, '09:21')).toISOString(), cwd: '/work/r', message: { content: [{ type: 'tool_result' }] } },
      { type: 'assistant', timestamp: new Date(at(D, '09:45')).toISOString(), cwd: '/work/r', message: { content: [] } },
      { type: 'user', timestamp: new Date(at(D, '14:00')).toISOString(), cwd: '/work/r', message: { content: 'add tests' } },
      { type: 'assistant', timestamp: new Date(at(D, '14:10')).toISOString(), cwd: '/work/r', message: { content: [] } },
    ];
    const file = join(dir, 's.jsonl');
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
    const events = await parseSession(file, at(D, '00:00'), at(addDays(D, 1), '00:00'), testConfig({ idleMinutes: 60 }));
    assert.equal(events.length, 2);
    assert.deepEqual([events[0].start, events[0].end], [at(D, '08:55'), at(D, '09:45')]);
    assert.deepEqual(events[0].texts, ['add login']);
    assert.equal(events[0].branch, 'feat/a');
    assert.deepEqual(events[1].texts, ['add tests']);
  });
});

describe('calendar mapping', () => {
  const cfg = testConfig();
  const timed = { start: { dateTime: `${D}T10:00:00Z` }, end: { dateTime: `${D}T11:00:00Z` }, summary: 'Sync' };
  const me = { self: true, responseStatus: 'accepted' };
  const other = { email: 'x@y' };

  it('keeps accepted meetings with attendees and drops declined, all-day and solo events', () => {
    assert.ok(toRawEvent({ ...timed, attendees: [me, other] }, cfg));
    assert.equal(toRawEvent({ ...timed, attendees: [{ ...me, responseStatus: 'declined' }, other] }, cfg), null);
    assert.equal(toRawEvent({ ...timed }, cfg), null);
    assert.equal(toRawEvent({ start: { date: D }, end: { date: addDays(D, 1) }, summary: 'Holiday' }, cfg), null);
    assert.equal(toRawEvent({ start: { date: D }, end: { date: addDays(D, 1) }, eventType: 'outOfOffice' }, cfg)?.outOfOffice, true);
  });

  it('counts tentative, unanswered and declined meetings by setting', () => {
    const reply = (responseStatus: string) => ({ ...timed, attendees: [{ ...me, responseStatus }, other] });
    assert.ok(toRawEvent(reply('needsAction'), cfg));
    assert.ok(toRawEvent(reply('tentative'), cfg));
    assert.equal(toRawEvent(reply('needsAction'), { ...cfg, calendar: { ...cfg.calendar, includeUnanswered: false } }), null);
    assert.equal(toRawEvent(reply('tentative'), { ...cfg, calendar: { ...cfg.calendar, includeTentative: false } }), null);
    assert.ok(toRawEvent(reply('declined'), { ...cfg, calendar: { ...cfg.calendar, includeDeclined: true } }));
  });

  it('ignores meetings longer than maxMeetingHours', () => {
    const long = { ...timed, end: { dateTime: `${D}T14:30:00Z` }, attendees: [me, other] };
    assert.equal(toRawEvent(long, cfg), null);
    assert.ok(toRawEvent({ ...long, end: { dateTime: `${D}T14:00:00Z` } }, cfg));
    assert.ok(toRawEvent(long, { ...cfg, calendar: { ...cfg.calendar, maxMeetingHours: 0 } }));
  });
});

describe('format', () => {
  const cfg = testConfig();
  const day = (date: string, entries: [string, number][]): DayReport => ({
    date, status: 'final', computedAt: '', blocks: [], summary: '', warnings: [], paths: {}, outOfOffice: false, target: 8,
    entries: entries.map(([category, hours]) => ({ project: 'Default', category, capex: true, real: hours, hours })),
    realTotal: 0, total: 0,
  });
  const reports = [day('2026-09-14', [['Development', 6], ['Team Meeting', 2]]), day('2026-09-15', [['Development', 7.5], ['Testing', 0.5]])];

  it('renders bare numbers with the configured separator', () => {
    assert.equal(num(7.5, cfg), '7.5');
    assert.equal(num(8, cfg), '8');
    assert.equal(num(0.25, { ...cfg, decimalSeparator: ',' }), '0,25');
  });

  it('renders the weekly grid with Mon–Sun columns', () => {
    const lines = formatGrid(reports, cfg).split('\n');
    assert.match(lines[0], /^Project\tTask Category\tMon 2026-09-14\tTue 2026-09-15\t.*Sun 2026-09-20\tTotal$/);
    assert.equal(lines[1], 'Default\tDevelopment\t6\t7.5\t\t\t\t\t\t13.5');
    assert.equal(formatGrid(reports, cfg, { header: false }).split('\n')[0], 'Default\tDevelopment\t6\t7.5\t\t\t\t\t');
  });

  it('renders per-entry lines and the daily view', () => {
    assert.equal(formatLines(reports, cfg).split('\n')[1], '2026-09-14\tDefault\tDevelopment\t6');
    assert.equal(formatLines(reports, { ...cfg, dateFormat: 'DD/MM/YYYY' }, { header: false }).split('\n')[0], '14/09/2026\tDefault\tDevelopment\t6');
    assert.equal(formatDaily([reports[0]], cfg), '2026-09-14\nDevelopment\t6\nTeam Meeting\t2');
  });
});

describe('claude profiles and history', async () => {
  const { expandDirs, computeKey } = await import('../src/core/config.ts');
  const { collectClaude } = await import('../src/core/collectors/claude.ts');

  it('expands ~/.claude*-style globs to every existing profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'ts-home-'));
    for (const p of ['.claude/projects', '.claude-db/projects', '.claude-infi/projects', '.claude-shared']) mkdirSync(join(home, p), { recursive: true });
    assert.deepEqual(expandDirs([`${home}/.claude*/projects`]).map((d) => d.slice(home.length)), ['/.claude-db/projects', '/.claude-infi/projects', '/.claude/projects']);
    assert.deepEqual(expandDirs([`${home}/missing`]), []);
  });

  it('reads history.jsonl only for sessions without a transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ts-prof-'));
    mkdirSync(join(root, 'projects', '-work-r'), { recursive: true });
    const line = (o: object) => JSON.stringify(o);
    // Session "kept" still has its transcript; "gone" only survives in history.
    writeFileSync(join(root, 'projects', '-work-r', 'kept.jsonl'), [
      line({ type: 'user', timestamp: new Date(at(D, '09:00')).toISOString(), cwd: '/work/r', message: { content: 'from transcript' } }),
      line({ type: 'assistant', timestamp: new Date(at(D, '09:30')).toISOString(), cwd: '/work/r', message: { content: [] } }),
    ].join('\n'));
    writeFileSync(join(root, 'history.jsonl'), [
      line({ display: 'from transcript', timestamp: at(D, '09:00'), project: '/work/r', sessionId: 'kept' }),
      line({ display: 'old prompt one', timestamp: at(D, '14:00'), project: '/work/r', sessionId: 'gone' }),
      line({ display: 'old prompt two', timestamp: at(D, '14:20'), project: '/work/r', sessionId: 'gone' }),
    ].join('\n'));
    const cfg = testConfig({ claudeDirs: [join(root, 'projects')] });
    const events = (await collectClaude(cfg, at(D, '00:00'), at(addDays(D, 1), '00:00'))).sort((a, b) => a.start - b.start);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0].texts, ['from transcript']);
    assert.deepEqual([events[1].start, events[1].end, events[1].texts], [at(D, '13:55'), at(D, '14:30'), ['old prompt one', 'old prompt two']]);
    const off = await collectClaude({ ...cfg, claudeHistory: false }, at(D, '00:00'), at(addDays(D, 1), '00:00'));
    assert.equal(off.length, 1);
  });

  it('changes the compute key when sources change, not when output options change', () => {
    const base = testConfig();
    assert.equal(computeKey(base), computeKey({ ...base, target: 6, decimalSeparator: ',' }));
    assert.notEqual(computeKey(base), computeKey({ ...base, claudeHistory: false }));
    assert.notEqual(computeKey(base), computeKey({ ...base, authorEmails: ['x@y'] }));
  });
});

describe('prompt cleaning', () => {
  it('drops harness-injected blocks and non-prompts', async () => {
    const { cleanPrompt } = await import('../src/core/collectors/spans.ts');
    assert.equal(
      cleanPrompt('fix the build <task-notification> <task-id>x</task-id> <summary>done</summary> </task-notification> and push'),
      'fix the build and push',
    );
    assert.equal(cleanPrompt('<system-reminder>ctx</system-reminder>'), null);
    assert.equal(cleanPrompt('This session is being continued from a previous conversation. Summary: …'), null);
  });
});
