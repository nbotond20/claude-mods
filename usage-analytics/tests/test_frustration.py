"""Frustration meter: the per-prompt signals, the score and the mood table built from a session.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import importlib.machinery
import importlib.util
import json
import os
import sqlite3
import sys
import unittest

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
sys.path.insert(0, BIN)
import frustration  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('claude_usage', os.path.join(BIN, 'claude-usage'))
_spec = importlib.util.spec_from_loader('claude_usage', _loader)
cu = importlib.util.module_from_spec(_spec)
_loader.exec_module(cu)


def db():
    con = sqlite3.connect(':memory:')
    con.executescript(cu.DDL)
    con.executescript(frustration.DDL)
    return con


def prompt(con, id, sid, ts, text, kind='prompt'):
    con.execute('INSERT INTO prompts (uuid, session_id, ts, day, kind, text, chars) VALUES (?,?,?,?,?,?,?)',
                (id, sid, ts, ts[:10], kind, text, len(text)))


class Signals(unittest.TestCase):
    def test_text_signals(self):
        cases = {
            'Are you fucking dumb???? I meant this': {'swearing', 'insult', 'punctuation'},
            'WHY IS THIS STILL BROKEN': {'shouting', 'correction'},
            'how many times do I have to say it': {'repeating_self'},
            'forget it, I will do it myself': {'giving_up'},
            'why did you delete the config?': {'blame'},
            'nooooo': {'elongation'},
            'no': {'correction', 'terse'},
        }
        for text, want in cases.items():
            self.assertTrue(want <= set(frustration.text_signals(text)), (text, frustration.text_signals(text)))

    def test_calm_prompts_score_zero(self):
        for t in ('Add a thank you page', 'Run the tests every time you change the API', 'Use the JSON API and the SQL CLI',
                  'Can you rename the README section?', 'No need to test it', 'garbage collection is slow here'):
            self.assertEqual(frustration.text_signals(t), [], t)

    def test_code_and_pastes_are_not_shouting(self):
        sql = 'Why is this slow?\nSELECT id FROM users WHERE NOT EXISTS (SELECT 1 FROM orders)\nCREATE INDEX ON users (id);'
        self.assertNotIn('shouting', frustration.text_signals(sql))
        self.assertNotIn('shouting', frustration.text_signals('look ```SELECT * FROM TABLE WHERE A AND B``` please'))
        self.assertNotIn('swearing', frustration.text_signals('<pasted_content>shit happens in logs</pasted_content> what is this'))

    def test_score_and_levels(self):
        self.assertEqual(frustration.score([]), 0)
        self.assertEqual(frustration.score(['swearing', 'insult', 'giving_up', 'shouting']), 100)
        self.assertEqual([frustration.level(s) for s in (0, 5, 25, 50, 75, 100)], ['calm', 'mild', 'annoyed', 'frustrated', 'rage', 'rage'])


class Session(unittest.TestCase):
    def test_context_signals_and_model_of_the_turn_before(self):
        con = db()
        con.executemany('INSERT INTO requests (msg_id, session_id, ts, model, effort) VALUES (?,?,?,?,?)', [
            ('r1', 's', '2026-10-01T10:00:05Z', 'claude-sonnet-5-5', 'high'),
            ('r2', 's', '2026-10-01T10:01:05Z', 'claude-opus-5-5', 'max')])
        prompt(con, 'p1', 's', '2026-10-01T10:00:00Z', 'Add a login page with email and password fields')
        prompt(con, 'i1', 's', '2026-10-01T10:00:30Z', '[Request interrupted by user]', 'interrupt')
        prompt(con, 'p2', 's', '2026-10-01T10:01:00Z', 'Add a login page with email and password fields please')
        con.execute("INSERT INTO tool_uses (id, session_id, ts, tool, flag) VALUES ('t1', 's', '2026-10-01T10:01:10Z', 'Bash', 'rejected')")
        prompt(con, 'p3', 's', '2026-10-01T10:02:00Z', 'ok, use the shared button instead')
        self.assertEqual(frustration.refresh(con), 1)
        rows = {r[0]: r[1:] for r in con.execute('SELECT uuid, score, signals, model, effort FROM mood')}
        self.assertEqual(set(rows), {'p1', 'p2', 'p3'})
        self.assertEqual(rows['p1'][0], 0)
        self.assertEqual(rows['p1'][2], 'claude-sonnet-5-5')  # the first prompt: the model that answered it
        self.assertEqual(set(json.loads(rows['p2'][1])), {'after_interrupt', 'repeated_ask'})
        self.assertEqual(rows['p2'][2:], ('claude-sonnet-5-5', 'high'))
        self.assertEqual(json.loads(rows['p3'][1]), ['rejected_calls'])
        self.assertEqual(rows['p3'][2], 'claude-opus-5-5')

    def test_refresh_rescores_only_touched_sessions_until_rules_change(self):
        con = db()
        prompt(con, 'a', 's1', '2026-10-01T10:00:00Z', 'wtf')
        prompt(con, 'b', 's2', '2026-10-01T10:00:00Z', 'hello')
        frustration.refresh(con)
        con.execute("UPDATE mood SET score = 99 WHERE uuid = 'b'")
        frustration.refresh(con, ['s1'])
        self.assertEqual(con.execute("SELECT score FROM mood WHERE uuid = 'b'").fetchone()[0], 99)
        con.execute("UPDATE meta SET v = 'old' WHERE k = 'mood_version'")
        frustration.refresh(con, ['s1'])
        self.assertEqual(con.execute("SELECT score FROM mood WHERE uuid = 'b'").fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
