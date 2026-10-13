"""Recurring asks: normalization, clustering, the thresholds, stable ids and the stored labels and statuses.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import recurring  # noqa: E402

KW = dict(since='2026-09-01', today='2026-10-14')


def db(prompts):
    """prompts: (day, text[, session]) rows; each gets a request worth $0.10 after it."""
    con = sqlite3.connect(':memory:')
    con.executescript('''CREATE TABLE prompts (uuid TEXT, profile TEXT, session_id TEXT, agent_id TEXT, ts TEXT, day TEXT, project TEXT,
                         kind TEXT, chars INT, text TEXT);
                         CREATE TABLE requests (msg_id TEXT, session_id TEXT, ts TEXT, cost_usd REAL);
                         CREATE TABLE sessions (session_id TEXT PRIMARY KEY, entrypoint TEXT);''')
    for i, p in enumerate(prompts):
        day, text = p[0], p[1]
        sid = p[2] if len(p) > 2 else f's{i}'
        ts = f'{day}T10:{i % 60:02d}:00'
        con.execute('INSERT INTO prompts VALUES (?,?,?,?,?,?,?,?,?,?)', (f'u{i}', 'claude-work', sid, None, ts, day, '~/app', 'prompt', len(text), text))
        con.execute('INSERT INTO requests VALUES (?,?,?,?)', (f'm{i}', sid, ts[:-2] + '30', 0.10))
    return con


def run(prompts, **kw):
    return recurring.detect(db(prompts), **{**KW, **kw})


RELEASE = ['bump the version to 1.2.3, update the changelog and tag the release',
           'cut a release 1.2.4: version bump, changelog entry, tag it',
           'please bump version to 2.0.0, add a changelog entry and tag the release']


class Normalize(unittest.TestCase):
    def test_details_that_change_are_dropped(self):
        a = recurring.normalize('check why CI failed on feat/cart-v2 and fix it')
        b = recurring.normalize('check why CI failed on fix/push-tokens and fix it')
        self.assertEqual(a, b)
        self.assertEqual(recurring.normalize('open src/app/Foo.tsx line 42 "some quoted text" at https://x.dev/a?b=1'), 'open line')

    def test_code_and_pasted_logs_are_not_the_ask(self):
        t = 'fix this\n```\nTraceback (most recent call last):\n  File "a.py", line 3\n```\n  at foo (bar.js:1:2)\nthanks'
        self.assertEqual(recurring.normalize(t), 'fix')

    def test_one_word_replies_are_trivial(self):
        self.assertTrue(recurring.is_trivial(recurring.tokens('ok, continue')))
        self.assertFalse(recurring.is_trivial(recurring.tokens('update the changelog')))

    def test_stemming_joins_word_forms(self):
        self.assertEqual(recurring.normalize('tags tagging tagged'), recurring.normalize('tag tag tag'))


class Cluster(unittest.TestCase):
    def test_paraphrases_are_one_ask(self):
        r = run([('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)])
        self.assertEqual(r['clusterCount'], 1)
        self.assertEqual(r['clusters'][0]['count'], 3)

    def test_different_asks_stay_apart(self):
        rows = [('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)]
        rows += [('2026-09-1%d' % i, t) for i, t in enumerate(['run the tests and fix what fails', 'run the test suite and fix whatever fails', 'run all tests, then fix the failures'])]
        r = run(rows)
        self.assertEqual(r['clusterCount'], 2)
        self.assertEqual(sorted(c['count'] for c in r['clusters']), [3, 3])

    def test_needs_the_minimum_prompts(self):
        self.assertEqual(run([('2026-09-01', RELEASE[0]), ('2026-09-02', RELEASE[1])])['clusterCount'], 0)
        self.assertEqual(run([('2026-09-01', RELEASE[0]), ('2026-09-02', RELEASE[1])], min_count=2)['clusterCount'], 1)

    def test_needs_two_different_days(self):
        same_day = [('2026-09-01', t) for t in RELEASE]
        self.assertEqual(run(same_day)['clusterCount'], 0)
        self.assertEqual(run(same_day, min_days=1)['clusterCount'], 1)

    def test_one_off_prompts_never_cluster(self):
        words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'.split()
        rows = [(f'2026-09-{i % 20 + 1:02d}', f'{words[i % 12]} {words[(i * 5 + 3) % 12]} something unique {words[(i * 7 + 1) % 12]}z') for i in range(8)]
        r = run(rows)
        self.assertLess(r['recurringShare'], 0.6)

    def test_only_main_loop_prompts_count(self):
        con = db([('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)])
        con.execute("UPDATE prompts SET agent_id = 'sub' WHERE uuid = 'u0'")
        con.execute("UPDATE prompts SET kind = 'command' WHERE uuid = 'u1'")
        self.assertEqual(recurring.detect(con, **KW)['prompts'], 1)

    def test_headless_runs_are_left_out(self):
        con = db([(f'2026-10-0{d}', RELEASE[d % 3], f'h{d}') for d in range(1, 5)])
        con.executemany('INSERT INTO sessions VALUES (?, ?)', [(f'h{d}', 'sdk-cli') for d in range(1, 5)])
        self.assertEqual(recurring.detect(con, **KW)['clusters'], [])
        self.assertEqual(len(recurring.detect(con, headless=True, **KW)['clusters']), 1)

    def test_share_and_cost(self):
        rows = [('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)] + [('2026-09-20', 'zulu yankee xray whiskey victor uniform')]
        r = run(rows)
        self.assertEqual(r['prompts'], 4)
        self.assertEqual(r['recurring'], 3)
        self.assertAlmostEqual(r['recurringShare'], 0.75)
        self.assertAlmostEqual(r['clusters'][0]['costTotal'], 0.3, places=2)
        self.assertTrue(0 < r['clusters'][0]['score'] <= 100)
        self.assertTrue(r['clusters'][0]['reason'])

    def test_ids_are_stable(self):
        rows = [('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)]
        self.assertEqual(run(rows)['clusters'][0]['id'], run(list(reversed(rows)))['clusters'][0]['id'])


class Stored(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.a = recurring.adb(self.tmp.name)
        self.con = db([('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)])

    def tearDown(self):
        self.a.close()
        self.tmp.cleanup()

    def report(self):
        return recurring.report(self.con, self.a, **KW)

    def test_record_set_round_trip(self):
        cid = self.report()['clusters'][0]['id']
        rid, done, warn = recurring.record(self.con, self.a, {'summary': 's', 'clusters': [{
            'id': cid, 'title': 'Cut a release', 'category': 'release/versioning', 'est_prompts_month': 99999,
            'automation': {'kind': 'skill', 'draft': 'Bump the version and tag. key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'}, 'rationale': 'fixed steps'},
            {'id': 'nope0000', 'title': 'x', 'category': 'other', 'automation': {'kind': 'none'}}]},
            redact=lambda t: t.replace('sk-ant-api03-abcdefghijklmnopqrstuvwxyz', '[redacted]'), **KW)
        self.assertEqual(done, [cid])
        self.assertTrue(any('nope0000' in w for w in warn))
        self.assertTrue(any('capped' in w for w in warn))
        c = self.report()['clusters'][0]
        self.assertEqual(c['label']['title'], 'Cut a release')
        self.assertEqual(c['label']['automation']['kind'], 'skill')
        self.assertNotIn('sk-ant', c['label']['automation']['draft'])
        self.assertLessEqual(c['label']['estPromptsMonth'], c['perMonth'])
        self.assertEqual(c['status'], 'new')
        recurring.set_status(self.con, self.a, cid, 'automated', at='2026-09-20T00:00:00', **KW)
        c = self.report()['clusters'][0]
        self.assertEqual((c['status'], c['statusAt'][:10]), ('automated', '2026-09-20'))
        self.assertEqual(c['label']['title'], 'Cut a release')
        self.assertIsNotNone(c['effect'])
        recurring.set_status(self.con, self.a, cid, 'new', **KW)
        self.assertEqual(self.report()['clusters'][0]['status'], 'new')

    def test_bad_input_is_refused_or_corrected(self):
        with self.assertRaises(ValueError):
            recurring.set_status(self.con, self.a, 'missing1', 'automated', **KW)
        cid = self.report()['clusters'][0]['id']
        with self.assertRaises(ValueError):
            recurring.set_status(self.con, self.a, cid, 'bogus', **KW)
        _, done, warn = recurring.record(self.con, self.a, {'clusters': [{'id': cid, 'title': 't', 'category': 'weird', 'automation': {'kind': 'magic'}}]}, **KW)
        self.assertEqual(done, [cid])
        self.assertEqual(len(warn), 2)

    def test_label_survives_the_wording_drifting(self):
        cid = self.report()['clusters'][0]['id']
        recurring.record(self.con, self.a, {'clusters': [{'id': cid, 'title': 'Cut a release', 'category': 'other', 'automation': {'kind': 'none'}}]}, **KW)
        more = [('2026-09-1%d' % i, 'bump version number again, add changelog entry and tag the release') for i in range(4)]
        con = db([('2026-09-0%d' % (i + 1), t) for i, t in enumerate(RELEASE)] + more)
        c = recurring.report(con, self.a, **KW)['clusters'][0]
        self.assertEqual(c['id'], cid)
        self.assertEqual(c['label']['title'], 'Cut a release')

    def test_a_retired_ask_is_listed(self):
        cid = self.report()['clusters'][0]['id']
        recurring.set_status(self.con, self.a, cid, 'automated', at='2026-09-02T00:00:00', **KW)
        r = recurring.report(db([('2026-09-01', 'zulu yankee xray whiskey victor uniform')]), self.a, **KW)
        self.assertEqual([x['id'] for x in r['retired']], [cid])

    def test_brief_is_redacted_and_limited(self):
        b = recurring.brief(self.con, self.a, limit=5, redact=lambda t: t, **KW)
        self.assertEqual(len(b['clusters']), 1)
        self.assertIn('recordFormat', b)
        self.assertLessEqual(len(b['clusters'][0]['samples']), 5)


class Effect(unittest.TestCase):
    def test_before_and_after_the_marked_date(self):
        days = ['2026-09-%02d' % d for d in range(1, 15)] + ['2026-09-30']
        e = recurring.effect(days, '2026-09-15', '2026-10-14', '2026-09-01')
        self.assertEqual(e['verdict'], 'stopped' if e['afterPerWeek'] <= 0.2 * e['beforePerWeek'] else e['verdict'])
        self.assertGreater(e['beforePerWeek'], e['afterPerWeek'])

    def test_too_early(self):
        self.assertEqual(recurring.effect(['2026-09-01'], '2026-10-12', '2026-10-14', '2026-09-01')['verdict'], 'too early')


if __name__ == '__main__':
    unittest.main()
