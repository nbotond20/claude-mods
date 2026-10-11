"""The advisor's statistics on synthetic sessions with a known truth: does it find a real effect, stay quiet
about none, ignore a change in the mix of work, give the same numbers twice, and need about as many sessions
as power() says? Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import advisor  # noqa: E402

KEY = 'cost_per_prompt'
PROJECTS = {'~/app': 3.0, '~/lib': 0.6, '~/ops': 1.2}  # dollars per prompt: projects differ a lot


def sessions(rng, n, effect=0.0, mix=None):
    """Sessions with heavy-tailed cost (lognormal, like real usage), `effect` the true relative change."""
    names = list(PROJECTS)
    weights = mix or [1] * len(names)
    out = []
    for _ in range(n):
        p = rng.choices(names, weights)[0]
        prompts = rng.randint(1, 12)
        cost = sum(PROJECTS[p] * rng.lognormvariate(-0.5, 1.0) for _ in range(prompts)) * (1 + effect)
        out.append({'project': p, 'cost': cost, 'prompts': prompts})
    return out


def rel(after, before, seed=1, n=200):
    proj = lambda r: r['project']
    return advisor.estimate(advisor._rel, [advisor._groups(after, KEY, proj), advisor._groups(before, KEY, proj)], seed, n)


class AdvisorStats(unittest.TestCase):
    def test_finds_a_real_effect_and_covers_it(self):
        rng, covered, found = random.Random(1), 0, 0
        for i in range(30):
            d, lo, hi = rel(sessions(rng, 300, -0.3), sessions(rng, 300), seed=i)
            covered += lo <= -0.3 <= hi
            found += hi < 0
        self.assertGreaterEqual(covered, 25, 'the 95% interval should hold the true -30% in ~95% of runs')
        self.assertGreaterEqual(found, 28, 'a -30% change on 300 sessions a side should be found')

    def test_no_effect_is_rarely_called_an_effect(self):
        rng, false = random.Random(2), 0
        for i in range(60):
            d, lo, hi = rel(sessions(rng, 150), sessions(rng, 150), seed=i)
            false += hi < 0 or lo > 0
        self.assertLessEqual(false, 8, f'{false}/60 false positives at a 5% level')

    def test_a_change_in_the_mix_of_work_is_not_an_effect(self):
        rng = random.Random(3)
        before, after = sessions(rng, 600, mix=[1, 3, 1]), sessions(rng, 600, mix=[3, 1, 1])  # more of the costly project
        naive = advisor.value(after, KEY) / advisor.value(before, KEY) - 1
        d, lo, hi = rel(after, before)
        self.assertGreater(naive, 0.3, 'the unstandardized ratio is fooled by the mix')
        self.assertTrue(lo <= 0 <= hi, f'standardized: {d:+.2f} ({lo:+.2f} … {hi:+.2f}) should hold 0')

    def test_same_data_same_numbers(self):
        rng = random.Random(4)
        a, b = sessions(rng, 200, -0.2), sessions(rng, 200)
        self.assertEqual(rel(a, b, seed=advisor._seed('x', KEY)), rel(a, b, seed=advisor._seed('x', KEY)))
        self.assertEqual(advisor._seed('x', KEY), advisor._seed('x', KEY))

    def test_power_matches_simulation(self):
        rng = random.Random(5)
        pw = advisor.power(sessions(rng, 2000), KEY, -0.3)
        n = pw['trial'] // 2
        hits = sum(rel(sessions(rng, n, -0.3), sessions(rng, n), seed=i)[2] < 0 for i in range(40))
        self.assertTrue(24 <= hits <= 40, f'power() promises ~80% at {n} sessions a side; simulation found {hits}/40')

    def test_trend(self):
        up = [100 * 1.1 ** i for i in range(8)]
        sl, p = advisor.slope(up)
        self.assertGreater(sl, 0.05)
        self.assertLess(p, 0.01)
        rng = random.Random(6)
        flat = [100 + rng.gauss(0, 5) for _ in range(8)]
        _, p = advisor.slope(flat)
        self.assertGreater(p, 0.05)

    def test_arms_are_balanced(self):
        # The mod's arm draw, mirrored here: FNV-1a of "advisor:<rec>:<session>" against the share.
        def bucket(s):
            h = 0x811c9dc5
            for ch in s:
                h = ((h ^ ord(ch)) * 0x01000193) & 0xffffffff
            return h / 2 ** 32
        on = sum(bucket(f'advisor:abc123:{i:08x}-sess') < 0.5 for i in range(4000))
        self.assertTrue(1880 <= on <= 2120, f'{on}/4000 in the trial arm')


if __name__ == '__main__':
    unittest.main()
