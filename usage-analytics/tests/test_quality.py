"""Output-quality signals: the classifiers, the per-session numerators and git survival on a throwaway repo.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import importlib.machinery
import importlib.util
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
sys.path.insert(0, BIN)
import quality  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('claude_usage', os.path.join(BIN, 'claude-usage'))
_spec = importlib.util.spec_from_loader('claude_usage', _loader)
cu = importlib.util.module_from_spec(_spec)
_loader.exec_module(cu)


def db():
    con = sqlite3.connect(':memory:')
    con.executescript(cu.DDL)
    return con


def tool(con, id, sid, ts, name, file=None, verify=None, err=0, flag=None, inp=None):
    lines, wrote = quality.written(name, inp or {})
    con.execute('''INSERT INTO tool_uses (id, session_id, ts, tool, file, verify, is_error, flag, lines_out, wrote, replaced)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (id, sid, ts, name, file, verify, err, flag, lines, wrote, quality.replaced(name, inp or {})))


def prompt(con, id, sid, ts, text, kind='prompt'):
    con.execute("INSERT INTO prompts (uuid, session_id, ts, kind, text, chars) VALUES (?,?,?,?,?,?)", (id, sid, ts, kind, text, len(text)))


class Classifiers(unittest.TestCase):
    def test_checks_are_found_behind_runners_and_pipes(self):
        cases = {'npx vitest run 2>&1 | tail -20': 'test', 'cd app && pnpm --filter api test': 'test', 'uv run pytest -q': 'test',
                 'python3 -m pytest': 'test', 'CI=1 bun test': 'test', 'npx tsc --noEmit': 'typecheck', 'npx biome check .': 'lint',
                 'npm run build': 'build', 'grep -n make Makefile': None, 'npm run dev': None, 'git status': None}
        for cmd, want in cases.items():
            self.assertEqual(quality.verify_kind(cmd), want, cmd)

    def test_result_flags(self):
        self.assertEqual(quality.result_flag('      Tests  1 failed (1)'), 'fail')
        self.assertEqual(quality.result_flag('src/a.ts(3,4): error TS2322: nope'), 'fail')
        self.assertEqual(quality.result_flag(' 8 pass\n 1 fail'), 'fail')
        self.assertIsNone(quality.result_flag('Tests  12 passed (12)\n0 failed'))
        self.assertEqual(quality.result_flag("The user doesn't want to proceed with this tool use."), 'rejected')
        self.assertEqual(quality.result_flag('Permission to use Bash has been denied.'), 'denied')

    def test_corrections(self):
        for t in ('no, that is wrong', 'it still fails', '[Image #2] I still see it', 'revert that', 'Fix', 'are you sure?'):
            self.assertTrue(quality.is_correction(t), t)
        for t in ('commit and push', 'No need to test it', 'Add a thank you page', 'Still need docs?', 'make sure it still works'):
            self.assertFalse(quality.is_correction(t), t)

    def test_written_keeps_hashes_of_meaningful_lines_only(self):
        n, hs = quality.written('Edit', {'new_string': 'a\n  return total\n}\n'})
        self.assertEqual(n, 3)
        self.assertEqual(hs.split(), [quality.line_hash('return total')])
        self.assertEqual(quality.written('Read', {'file_path': '/x'}), (None, None))

    def test_interrupts_are_their_own_kind(self):
        self.assertEqual(cu.prompt_kind('[Request interrupted by user]', False, False), 'interrupt')
        self.assertEqual(cu.prompt_kind('fix it', False, False), 'prompt')


class Sessions(unittest.TestCase):
    def test_numerators(self):
        con = db()
        prompt(con, 'p1', 's', '2026-10-01T10:00:00Z', 'add a total')
        prompt(con, 'i1', 's', '2026-10-01T10:01:00Z', '[Request interrupted by user]', 'interrupt')
        prompt(con, 'p2', 's', '2026-10-01T10:02:00Z', 'no, it still fails')
        # turn 1: write, then rewrite its own line (churn), a failing test, then a passing one
        tool(con, 'e1', 's', '2026-10-01T10:00:10Z', 'Write', '/r/a.py', inp={'content': 'def total(xs):\n    return sum(xs)\n'})
        tool(con, 'e2', 's', '2026-10-01T10:00:20Z', 'Edit', '/r/a.py', inp={'old_string': '    return sum(xs)', 'new_string': '    return sum(xs or [])'})
        tool(con, 'e3', 's', '2026-10-01T10:00:25Z', 'Edit', '/r/b.py', inp={'old_string': 'old line here', 'new_string': 'new line here'})
        tool(con, 'b1', 's', '2026-10-01T10:00:30Z', 'Bash', verify='test', flag='fail')
        tool(con, 'b2', 's', '2026-10-01T10:00:40Z', 'Bash', verify='test')
        # turn 2: a rejected call and a failing check last
        tool(con, 'b3', 's', '2026-10-01T10:02:10Z', 'Bash', flag='rejected')
        tool(con, 'b4', 's', '2026-10-01T10:02:20Z', 'Bash', verify='typecheck', err=1)
        con.executemany('INSERT INTO requests (msg_id, session_id, ts, model, effort, cache_read, cache_write) VALUES (?,?,?,?,?,?,?)', [
            ('m1', 's', '2026-10-01T10:00:05Z', 'opus', 'high', 0, 5000),
            ('m2', 's', '2026-10-01T10:00:15Z', 'opus', 'high', 5000, 100),
            ('m3', 's', '2026-10-01T10:20:00Z', 'opus', 'high', 0, 6000)])   # 20 minutes idle: the cache expired
        q = quality.session_quality(con, ['s'])['s']
        self.assertEqual((q['followups'], q['corrections'], q['interrupts'], q['rejections']), (1, 1, 1, 1))
        self.assertEqual((q['edits'], q['churn_edits']), (3, 1))
        self.assertEqual((q['verify_turns'], q['verify_pass'], q['edit_turns'], q['verify_turns_edit']), (2, 1, 1, 1))
        self.assertEqual((q['idle_rewrite'], q['cw_main'], q['model'], q['effort']), (6000, 11100, 'opus', 'high'))


@unittest.skipUnless(shutil.which('git'), 'git not installed')
class Survival(unittest.TestCase):
    def setUp(self):
        self.dir = os.path.realpath(tempfile.mkdtemp())
        self.git('init', '-q')
        self.git('config', 'user.email', 't@t')
        self.git('config', 'user.name', 't')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *a):
        subprocess.run(['git', '-C', self.dir, *a], check=True, capture_output=True)

    def test_lines_kept_at_the_next_commit(self):
        con = db()
        path = os.path.join(self.dir, 'a.py')
        edit_ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 60))
        tool(con, 'w', 's', edit_ts, 'Write', path, inp={'content': 'def one():\n    return 1\ndef two():\n    return 2\n'})
        with open(path, 'w') as f:
            f.write('def one():\n    return 1\n')   # the person dropped two() before committing
        self.git('add', '.')
        self.git('commit', '-qm', 'x')
        state, r = quality.outcome(con, 's', quality.Repos())
        self.assertEqual(state, 'done')
        self.assertEqual((r['files_edited'], r['files_committed'], r['lines_written'], r['lines_kept']), (1, 1, 4, 2))

    def test_uncommitted_waits_then_counts_as_not_shipped(self):
        con = db()
        path = os.path.join(self.dir, 'b.py')
        open(path, 'w').close()
        edit_ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 60))
        tool(con, 'w', 's', edit_ts, 'Write', path, inp={'content': 'value = compute()\n'})
        self.assertEqual(quality.outcome(con, 's', quality.Repos())[0], 'pending')
        state, r = quality.outcome(con, 's', quality.Repos(), now=time.time() + (quality.SETTLE_DAYS + 1) * 86400)
        self.assertEqual((state, r['files_edited'], r['files_committed'], r['lines_kept']), ('done', 1, 0, 0))


if __name__ == '__main__':
    unittest.main()
