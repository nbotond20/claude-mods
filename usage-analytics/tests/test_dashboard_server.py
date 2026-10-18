"""The dashboard server's lifecycle: when a running one is reused or replaced, and the login item kept on the newest CLI.
Run: python3 -m unittest discover -s usage-analytics/tests -p 'test_*.py'"""
import argparse
import importlib.machinery
import importlib.util
import json
import os
import socket
import sys
import tempfile
import unittest
from unittest import mock

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
sys.path.insert(0, BIN)
import dashboard_api  # noqa: E402

_loader = importlib.machinery.SourceFileLoader('claude_usage', os.path.join(BIN, 'claude-usage'))
_spec = importlib.util.spec_from_loader('claude_usage', _loader)
cu = importlib.util.module_from_spec(_spec)
_loader.exec_module(cu)


class Decide(unittest.TestCase):
    def test_start_reuse_replace(self):
        d = dashboard_api.decide
        self.assertEqual(d(None, '0.14.1'), 'start')
        self.assertEqual(d({'version': '0.14.1'}, '0.14.1'), 'reuse')
        self.assertEqual(d({'version': '0.14.1'}, '0.14.1', restart=True), 'replace')
        self.assertEqual(d({'version': '0.13.9'}, '0.14.1'), 'replace')
        self.assertEqual(d({'version': '0.9.0'}, '0.10.0'), 'replace')  # numeric, not string, order

    def test_never_downgrades(self):
        d = dashboard_api.decide
        self.assertEqual(d({'version': '0.15.0'}, '0.14.1'), 'reuse')
        self.assertEqual(d({'version': '0.15.0'}, '0.14.1', restart=True), 'reuse')

    def test_broken_server_is_replaced_whatever_its_version(self):
        self.assertEqual(dashboard_api.decide({'version': '9.0.0'}, '0.14.1', html_exists=False), 'replace')

    def test_port_free(self):
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            s.listen()
            port = s.getsockname()[1]
            self.assertFalse(dashboard_api.port_free(port))
        self.assertTrue(dashboard_api.port_free(port))


def plugin(root, version):
    """A fake installed copy of the mod: <root>/bin/claude-usage and its plugin.json."""
    os.makedirs(os.path.join(root, 'bin'))
    os.makedirs(os.path.join(root, '.claude-plugin'))
    open(os.path.join(root, 'bin', 'claude-usage'), 'w').close()
    with open(os.path.join(root, '.claude-plugin', 'plugin.json'), 'w') as f:
        json.dump({'version': version}, f)
    return os.path.join(root, 'bin', 'claude-usage')


class Stop(unittest.TestCase):
    """stop() never signals a process just because whatever answers on the port names its pid."""

    def run_stop(self, cmd, pid=4242):
        with mock.patch.object(dashboard_api, 'listeners', return_value={}), \
             mock.patch.object(dashboard_api, 'ping', return_value={'app': 'claude-usage', 'pid': pid}), \
             mock.patch.object(dashboard_api, 'command_of', return_value=cmd), \
             mock.patch.object(dashboard_api, '_kill', return_value=True) as kill:
            return dashboard_api.stop(8787), kill

    def test_foreign_pid_from_ping_is_not_killed(self):
        ok, kill = self.run_stop('/usr/sbin/sshd -D')
        self.assertFalse(ok)
        kill.assert_not_called()

    def test_own_pid_from_ping_is_killed(self):
        ok, kill = self.run_stop('python3 /x/bin/claude-usage serve --daemon')
        self.assertTrue(ok)
        kill.assert_called_once_with([4242], 8787)

    def test_bogus_pids_are_ignored(self):
        for pid in (1, 0, -1, '4242', None):
            ok, kill = self.run_stop('python3 /x/bin/claude-usage serve', pid=pid)
            self.assertFalse(ok)
            kill.assert_not_called()


class LoginItem(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.tmp.name
        self.me = plugin(os.path.join(t, 'cur'), '0.14.1')
        patches = [mock.patch.object(cu, 'DATA', os.path.join(t, 'data')), mock.patch.object(cu, 'HOME', os.path.join(t, 'home')),
                   mock.patch.object(cu, '__file__', self.me)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        os.makedirs(cu.DATA)

    def tearDown(self):
        self.tmp.cleanup()

    def cli_path(self):
        return open(os.path.join(cu.DATA, 'cli-path')).read()

    def test_claims_cli_path_but_never_for_an_older_copy(self):
        self.assertEqual(cu._claim_cli_path(), os.path.realpath(self.me))
        self.assertEqual(self.cli_path(), os.path.realpath(self.me))
        newer = plugin(os.path.join(self.tmp.name, 'newer'), '0.15.0')
        with open(os.path.join(cu.DATA, 'cli-path'), 'w') as f:
            f.write(newer)
        cu._claim_cli_path()
        self.assertEqual(self.cli_path(), newer)
        older = plugin(os.path.join(self.tmp.name, 'older'), '0.13.0')
        with open(os.path.join(cu.DATA, 'cli-path'), 'w') as f:
            f.write(older)
        cu._claim_cli_path()
        self.assertEqual(self.cli_path(), os.path.realpath(self.me))

    def test_a_deleted_copy_is_replaced(self):
        with open(os.path.join(cu.DATA, 'cli-path'), 'w') as f:
            f.write(os.path.join(self.tmp.name, 'gone', 'bin', 'claude-usage'))
        cu._claim_cli_path()
        self.assertEqual(self.cli_path(), os.path.realpath(self.me))

    def test_sync_leaves_autostart_off_and_rewrites_a_stale_unit(self):
        sync = argparse.Namespace(state='sync')
        with mock.patch('subprocess.run', return_value=mock.Mock(returncode=0, stdout='', stderr='')) as run:
            self.assertEqual(cu.cmd_autostart(sync), 0)
            self.assertFalse(os.path.exists(cu._unit_paths()))
            run.assert_not_called()
            os.makedirs(os.path.dirname(cu._unit_paths()))
            with open(cu._unit_paths(), 'w') as f:
                f.write('an older unit')
            self.assertEqual(cu.cmd_autostart(sync), 0)
            self.assertEqual(open(cu._unit_paths()).read(), cu._unit_text(cu._shim()))
            self.assertTrue(run.called)
            run.reset_mock()
            self.assertEqual(cu.cmd_autostart(sync), 0)  # already current: nothing reloaded
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
