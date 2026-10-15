"""Mod spend: which model calls v_background counts and who it charges them to.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import importlib.machinery
import importlib.util
import os
import sqlite3
import sys
import unittest

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
sys.path.insert(0, BIN)
import dashboard_api  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('claude_usage', os.path.join(BIN, 'claude-usage'))
_spec = importlib.util.spec_from_loader('claude_usage', _loader)
cu = importlib.util.module_from_spec(_spec)
_loader.exec_module(cu)


class Background(unittest.TestCase):
    def test_callers(self):
        con = sqlite3.connect(':memory:')
        con.executescript(cu.DDL)
        day = dashboard_api.datetime.now().strftime('%Y-%m-%d')
        rows = [  # msg_id, session, agent, cwd, project, entrypoint, model, context, cost
            ('m1', 's1', None, '/Users/x/.timesheet/classifier', '~/.timesheet/classifier', 'sdk-cli', 'claude-sonnet-5-5', 30000, 0.11),
            ('m2', 's2', None, '/Users/x/code/beacon', '~/code/beacon', 'sdk-py', 'claude-opus-5-5', 60000, 0.5),
            ('m3', 's2', None, '/Users/x/code/beacon', '~/code/beacon', 'sdk-py', 'claude-opus-5-5', 70000, 0.6),
            ('m4', 's3', 'a1', '/Users/x/code/web', '~/code/web', 'cli', 'claude-sonnet-5-5', 20000, 0.05),
            ('m5', 's3', 'a2', '/Users/x/code/web', '~/code/web', 'cli', 'claude-haiku-5-5', 9000, 0.01),
            ('m6', 's3', None, '/Users/x/code/web', '~/code/web', 'cli', 'claude-opus-5-5', 50000, 1.0),
        ]
        con.executemany('''INSERT INTO requests (msg_id, session_id, agent_id, cwd, project, entrypoint, model, input, cache_read, cache_write, cost_usd, day, ts, profile)
            VALUES (?,?,?,?,?,?,?,0,0,?,?,?,?,'p')''', [r + (day, day + 'T10:00:00Z') for r in rows])
        con.executemany('INSERT INTO agents (agent_id, session_id, agent_type) VALUES (?,?,?)',
                        [('a1', 's3', 'usage-analytics:advisor'), ('a2', 's3', 'Explore')])
        con.execute('INSERT INTO sessions (session_id, project) VALUES (?, ?)', ('s3', '~/code/web'))
        ms = int(dashboard_api.datetime.now().timestamp() * 1000)
        con.executemany("INSERT INTO events (src, line, ts, day, ev, sid, profile, data) VALUES ('f', ?, ?, ?, ?, 's3', 'p', ?)", [
            (1, ms, day, 'mod', '{"mod": "budget-guard", "kind": "classify", "purpose": "route", "model": "claude-haiku-5-5", "inputChars": 3760}'),
            (2, ms, day, 'mod', '{"mod": "budget-guard", "kind": "keepalive", "model": "claude-opus-5-5", "tokens": 100000, "output": 4, "costUsd": 0.02}'),
            (3, ms, day, 'mod', '{"mod": "budget-guard", "kind": "route", "tier": "quick"}')])
        got = {r[0]: r[1:] for r in con.execute('SELECT caller, kind, COUNT(DISTINCT run_id), ROUND(SUM(cost_usd), 6), MAX(project) FROM v_background GROUP BY 1, 2')}
        # your own turns, your own SDK scripts and a user-run Explore agent are not mod spend
        self.assertEqual(got, {'timesheet: classifier': ('claude -p', 1, 0.11, '~/.timesheet/classifier'),
                               'usage-analytics:advisor': ('agent', 1, 0.05, '~/code/web'),
                               'budget-guard: Haiku classifier (route)': ('in-session call', 1, 0.000102, '~/code/web'),  # 1000 tokens in at $0.10/M, 5 out at $0.50/M
                               'budget-guard: keep-alive pings': ('in-session call', 1, 0.02, '~/code/web')})
        callers = dashboard_api.query(con, 'bg_callers', {'days': ['30']})
        hint = {r[0]: r[-1] for r in callers['rows']}
        self.assertIn('lean', hint['timesheet: classifier'])
        self.assertEqual(hint['budget-guard: keep-alive pings'], '')
        k = dict(zip(*(lambda r: (r['cols'], r['rows'][0]))(dashboard_api.query(con, 'bg_kpis', {'days': ['30']}))))
        self.assertEqual((k['cost'], k['runs'], k['run_cost'], k['call_cost'], k['share_pct']), (0.18, 4, 0.16, 0.0201, 7.93))  # 0.18 of 2.27

    def test_views_are_remade_when_the_schema_changes(self):
        con = sqlite3.connect(':memory:')
        con.executescript(cu.DDL)
        con.execute('DROP VIEW v_background')
        con.execute("CREATE VIEW v_background AS SELECT 'old' caller")
        con.execute("INSERT INTO meta VALUES ('schema_version', '2')")
        cu.drop_old_views(con)
        con.executescript(cu.DDL)
        self.assertIn('kind', [r[1] for r in con.execute('PRAGMA table_info(v_background)')])

if __name__ == '__main__':
    unittest.main()
