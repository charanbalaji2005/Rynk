import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rynk import DaemonState, Rynk, RynkClient, RynkError
from rynk import launcher


class ClientTests(unittest.TestCase):
    def test_reads_daemon_state_from_rynk_home(self):
        with tempfile.TemporaryDirectory() as d:
            Path(d, "daemon.json").write_text(json.dumps({"pid": 1, "host": "127.0.0.1", "port": 9876, "token": "t", "version": "0.2.0", "proxyPort": 7777}))
            with mock.patch.dict(os.environ, {"RYNK_HOME": d}):
                state = DaemonState.load()
            self.assertEqual(state.port, 9876)

    def test_refuses_non_loopback_hosts(self):
        with self.assertRaises(RynkError):
            RynkClient(DaemonState(pid=1, host="10.0.0.5", port=9876, token="t", version="x", proxy_port=7777))

    def test_unreachable_daemon_is_a_friendly_error(self):
        client = RynkClient(DaemonState(pid=1, host="127.0.0.1", port=1, token="t", version="x", proxy_port=7777), timeout=1)
        with self.assertRaises(RynkError) as ctx:
            client.request("GET", "/api/health")
        self.assertEqual(ctx.exception.code, "DAEMON_UNREACHABLE")

    def test_connect_without_daemon_or_autostart_explains(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"RYNK_HOME": d}):
            with self.assertRaises(RynkError):
                Rynk.connect(start_daemon=False)


class LauncherTests(unittest.TestCase):
    def test_override_wins(self):
        with mock.patch.dict(os.environ, {"RYNK_NODE_CLI": "node /x/bin.js"}):
            self.assertEqual(launcher.node_cli(), ["node", "/x/bin.js"])

    def test_guard_prevents_launching_itself(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d, "rynk")
            fake.write_text("#!/usr/bin/env python3\nfrom rynk.cli import main\n")
            fake.chmod(0o755)
            with mock.patch.dict(os.environ, {"PATH": d, launcher.GUARD: ""}), mock.patch("shutil.which", return_value="/usr/bin/npx"):
                self.assertEqual(launcher.node_cli(), ["/usr/bin/npx", "--yes", "rynk"])

    def test_missing_node_is_explained(self):
        with mock.patch.dict(os.environ, {"PATH": "", "RYNK_NODE_CLI": ""}), mock.patch("shutil.which", return_value=None):
            with self.assertRaises(RynkError) as ctx:
                launcher.node_cli()
            self.assertIn("Node.js", ctx.exception.message)


if __name__ == "__main__":
    unittest.main()
