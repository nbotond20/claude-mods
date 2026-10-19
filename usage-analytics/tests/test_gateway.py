"""Gateway spend: one key's billed spend is counted once, under the profile that uses it, and compared with
the list price of every profile on that key.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import importlib.machinery
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
sys.path.insert(0, BIN)
import dashboard_api  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('claude_usage', os.path.join(BIN, 'claude-usage'))
_spec = importlib.util.spec_from_loader('claude_usage', _loader)
cu = importlib.util.module_from_spec(_spec)
_loader.exec_module(cu)


def day_of(spend, model='claude-opus-5-5'):
    return {'spend': spend, 'models': {model: {'spend': spend, 'requests': 1}}}


class Gateway(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dir, 'gateway'))
        self._data, cu.DATA = cu.DATA, self.dir
        self.con = sqlite3.connect(':memory:')
        self.con.executescript(cu.DDL)
        today = dashboard_api.datetime.now().strftime('%Y-%m-%d')
        self.day = today
        self.con.executemany("INSERT INTO requests (msg_id, profile, day, ts, cost_usd) VALUES (?,?,?,?,?)",
                             [('m1', 'work', today, today + 'T10:00:00Z', 4.0), ('m2', 'work', today, today + 'T11:00:00Z', 4.0),
                              ('m3', 'plain', today, today + 'T12:00:00Z', 2.0)])

    def tearDown(self):
        cu.DATA = self._data

    def write(self, name, body):
        with open(os.path.join(self.dir, 'gateway', name), 'w') as f:
            json.dump(body, f)

    def ingest(self):
        ing = cu.Ingest.__new__(cu.Ingest)
        ing.con, ing.args = self.con, type('A', (), {'quiet': True, 'verbose': False})()
        ing.gateway()
        return self.con.execute('SELECT profile, SUM(spend_usd) FROM gateway_spend GROUP BY profile').fetchall()

    def test_older_per_profile_copies_of_one_key_count_once(self):
        self.write('plain.json', {'profile': 'plain', 'host': 'gw', 'syncedAt': '2026-10-17T00:00:00Z', 'days': {self.day: day_of(12)}})
        self.write('work.json', {'profile': 'work', 'host': 'gw', 'syncedAt': '2026-10-16T00:00:00Z', 'days': {self.day: day_of(9)}})
        # the newer copy wins, filed under the profile with the most requests
        self.assertEqual(self.ingest(), [('work', 12.0)])

    def test_a_key_file_replaces_the_older_copies_and_compares_with_all_its_profiles(self):
        self.write('work.json', {'profile': 'work', 'host': 'gw', 'syncedAt': '2026-10-16T00:00:00Z', 'days': {self.day: day_of(9)}})
        self.write('key-1.json', {'key': '1', 'profiles': ['plain', 'work'], 'host': 'gw', 'syncedAt': '2026-10-19T00:00:00Z',
                                  'checkedAt': '2026-10-19T01:00:00Z', 'error': 'HTTP 502', 'days': {self.day: day_of(15)}})
        self.assertEqual(self.ingest(), [('work', 15.0)])
        r = dashboard_api.query(self.con, 'gateway_kpis', {'days': ['7'], 'profile': ['work']})
        k = dict(zip(r['cols'], r['rows'][0]))
        self.assertEqual((k['billed'], k['list'], k['synced_at'], k['error'], k['last_day']), (15.0, 10.0, '2026-10-19T00:00:00Z', 'HTTP 502', self.day))

    def test_two_keys_on_one_profile_add_up(self):
        self.write('key-1.json', {'key': '1', 'profiles': ['work'], 'host': 'gw', 'days': {self.day: day_of(3)}})
        self.write('key-2.json', {'key': '2', 'profiles': ['work'], 'host': 'gw2', 'days': {self.day: day_of(4)}})
        self.assertEqual(self.ingest(), [('work', 7.0)])


if __name__ == '__main__':
    unittest.main()
