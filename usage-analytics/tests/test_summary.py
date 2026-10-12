"""The weekly digest and the shareable summary on a small in-memory requests table.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import os
import sqlite3
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import summary  # noqa: E402

TODAY = date(2026, 10, 14)  # a Wednesday: last week is Mon 5 – Sun 11 October


def db(rows):
    con = sqlite3.connect(':memory:')
    con.execute('''CREATE TABLE requests (day TEXT, session_id TEXT, cost_usd REAL, model TEXT, project TEXT,
                   agent_id TEXT, input INT, cache_read INT, cache_write INT)''')
    con.executemany('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?)', rows)
    return con


def req(day, sid, cost, model='claude-opus-5-5', project='/Users/me/work/app', agent=None):
    return (day, sid, cost, model, project, agent, 10, 80, 10)


class Digest(unittest.TestCase):
    def test_last_week_against_the_week_before(self):
        con = db([req('2026-10-06', 'a', 30), req('2026-10-07', 'b', 10, project='/x/lib'), req('2026-10-12', 'c', 99),
                  req('2026-09-29', 'd', 20), req('2026-10-04', 'e', 999)])
        d = summary.digest(con, TODAY)
        self.assertEqual((d['from'], d['to'], d['week']), ('2026-10-05', '2026-10-11', '2026-W41'))
        self.assertEqual((d['cost'], d['sessions'], d['activeDays']), (40, 2, 2))
        self.assertEqual(d['prev']['cost'], 1019)
        self.assertAlmostEqual(d['change'], 40 / 1019 - 1, places=3)
        self.assertEqual(d['topProject'], ['app', 30])
        self.assertEqual(d['cacheHit'], 0.8)
        line = summary.fmt_digest_line(d)
        self.assertTrue(line.startswith('Last week: $40.00 over 2 sessions (-96% vs the week before)'), line)
        self.assertIn('most on app ($30.00)', line)

    def test_new_recommendations_count_only_from_this_week(self):
        con = db([req('2026-10-06', 'a', 1)])
        d = summary.digest(con, TODAY, new_recs=[{'id': 'r1', 'created': '2026-10-08T10:00'}, {'id': 'r0', 'created': '2026-09-01'}])
        self.assertEqual([r['id'] for r in d['newRecs']], ['r1'])

    def test_an_empty_week(self):
        d = summary.digest(db([]), TODAY)
        self.assertEqual((d['cost'], d['change'], d['topProject']), (0, None, None))
        summary.fmt_digest_line(d)
        summary.fmt_digest(d)


class Summary(unittest.TestCase):
    ROWS = [req('2026-10-13', 'a', 5), req('2026-10-14', 'b', 3, model='claude-sonnet-5-5', project='/w/secret-client'),
            req('2026-10-14', 'b', 2, agent='ag1'), req('2026-08-01', 'z', 500)]

    def test_totals_models_projects(self):
        s = summary.summary(db(self.ROWS), days=7, today=TODAY)
        self.assertEqual((s['from'], s['to'], s['cost'], s['sessions']), ('2026-10-08', '2026-10-14', 10, 2))
        self.assertEqual(s['models'][0][0], 'claude-opus-5-5')
        self.assertEqual([p[0] for p in s['projects']], ['app', 'secret-client'])
        self.assertEqual(s['subagentShare'], 0.2)
        self.assertEqual(s['perActiveDay'], 5)

    def test_projects_can_be_left_out_and_paths_never_appear(self):
        s = summary.summary(db(self.ROWS), days=7, today=TODAY, projects=False)
        self.assertEqual(s['projects'], [])
        for text in (summary.to_md(s), summary.to_html(s)):
            self.assertNotIn('secret-client', text)
            self.assertNotIn('/w/', text)
        full = summary.summary(db(self.ROWS), days=7, today=TODAY)
        self.assertNotIn('/Users/me', summary.to_md(full) + summary.to_html(full))

    def test_html_is_standalone_and_escaped(self):
        s = summary.summary(db([req('2026-10-14', 'a', 1, project='/p/<script>x')]), days=1, today=TODAY)
        h = summary.to_html(s)
        self.assertTrue(h.startswith('<!doctype html>'))
        self.assertNotIn('<script>', h)
        self.assertNotIn('src="http', h)
        self.assertIn('prefers-color-scheme:dark', h)

    def test_mod_verdicts_and_negative_money(self):
        imp = {'mods': [{'mod': 'lean-tools', 'verdict': ['save', 'saves ~4%'], 'net': -0.03}]}
        s = summary.summary(db(self.ROWS), days=7, today=TODAY, impact=imp)
        self.assertEqual(s['mods'], [{'mod': 'lean-tools', 'verdict': 'saves ~4%', 'net': -0.03}])
        self.assertIn('-$0.03', summary.to_md(s))


if __name__ == '__main__':
    unittest.main()
