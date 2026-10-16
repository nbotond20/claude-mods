"""The dashboard closes itself once no page is open and nothing was asked of it for a while.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import os, sys, threading, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'bin'))
import dashboard_api  # noqa: E402


class Srv:
    def __init__(self):
        self.down = threading.Event()

    def shutdown(self):
        self.down.set()


class IdleClose(unittest.TestCase):
    def test_open_page_keeps_it_up_and_idle_closes_it(self):
        a, srv = dashboard_api.Activity(), Srv()
        a.touch(1)  # a page holds the live stream
        t = threading.Thread(target=dashboard_api.close_when_idle, args=(srv, a, 0.001, 0.02), daemon=True)
        t.start()
        self.assertFalse(srv.down.wait(0.2))
        a.touch(-1)  # the tab closed
        self.assertTrue(srv.down.wait(1))

    def test_a_request_resets_the_clock(self):
        a = dashboard_api.Activity()
        a.last -= 120
        self.assertGreaterEqual(a.idle_s(), 120)
        a.touch()
        self.assertLess(a.idle_s(), 1)


if __name__ == '__main__':
    unittest.main()
