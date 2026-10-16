"""Keep-alive in the impact ledger: a stretch of pings pays off only when the next request reads a warm cache.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import impact


class Pr:
    def read(self, model, speed=None):
        return 0.5 / 1e6

    def write(self, model, speed=None):
        return 6.25 / 1e6


def ping(sid, ts, tokens=100_000):
    return {'sid': sid, 'ts': ts, 'tokens': tokens}


class KeepAliveTest(unittest.TestCase):
    def test_only_a_warm_return_pays(self):
        m = 60_000
        pings = [ping('a', 0), ping('b', 0)] + [ping('c', i * 270_000) for i in range(6)] + [ping('d', 0)]
        reqs = {
            'a': [(2 * m, 'opus', None, 100_000)],          # back in 2 min, read the cache: paid
            'b': [(20 * m, 'opus', None, 0)],               # back after the cache expired
            'c': [(40 * m, 'opus', None, 0)],               # six pings, then back too late
            'd': [(1 * m, 'opus', None, 0)],                # back in time but missed the cache
        }
        ka = impact._keepalive(Pr(), reqs, pings)
        self.assertEqual((ka['stretches'], ka['paid'], ka['fullRuns']), (4, 1, 1))
        self.assertAlmostEqual(ka['saved'], 100_000 * 5.75 / 1e6)


if __name__ == '__main__':
    unittest.main()
