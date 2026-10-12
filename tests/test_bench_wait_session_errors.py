import argparse
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bench"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import wait_session as ws  # noqa: E402

ERROR_JSON = b'{"ok": false, "error": "unknown role x"}'


def foreman_row(**kw):
    roles = {"foreman": {"model": "p/foreman"}}
    return dict({"id": "r", "agent": "foreman", "provider": "p", "roles": roles}, **kw)


def done(rc, stdout=b"", stderr=b""):
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout=stdout, stderr=stderr)


class BuildWorldErrorTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.args = argparse.Namespace(work=self._tmp.name, cwd=self._tmp.name)

    def test_generate_subagents_failure_carries_rc_and_stdout(self):
        with mock.patch.object(ws, "subprocess") as sp:
            sp.run.return_value = done(2, stdout=ERROR_JSON, stderr=b"")
            with self.assertRaises(RuntimeError) as cm:
                ws.build_world(self.args, foreman_row())
        msg = str(cm.exception)
        self.assertIn("rc=2", msg)
        self.assertIn(ERROR_JSON.decode("utf-8"), msg)

    def test_permissions_gen_failure_carries_rc_and_stdout(self):
        gen_ok = done(0, stdout=b'{"subagents": {}}')
        pg_fail = done(2, stdout=ERROR_JSON, stderr=b"")
        with mock.patch.object(ws, "subprocess") as sp:
            sp.run.side_effect = [gen_ok, pg_fail]
            with self.assertRaises(RuntimeError) as cm:
                ws.build_world(self.args, foreman_row(_permission_system=True))
        msg = str(cm.exception)
        self.assertTrue(msg.startswith("permissions_gen failed (rc=2)"), msg)
        self.assertIn("rc=2", msg)
        self.assertIn(ERROR_JSON.decode("utf-8"), msg)


if __name__ == "__main__":
    unittest.main()
