"""Driver: a rig's teardown SIGTERMs the pi-intercom broker its session left in the agent dir.

The broker is a plain Python child that writes its pid to <agent>/intercom/broker.pid, as the real one does.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import stop_intercom_broker  # noqa: E402

SLEEPS = "import time; time.sleep(120)"


class TestStopIntercomBroker(unittest.TestCase):
    def setUp(self):
        self.agent = Path(tempfile.mkdtemp(prefix="pf-replay-brokertest-"))
        self.addCleanup(self._cleanup)
        self.child = subprocess.Popen([sys.executable, "-c", SLEEPS])
        self.addCleanup(self._kill_child)

    def _cleanup(self):
        for _ in range(5):
            try:
                shutil.rmtree(str(self.agent))
                return
            except OSError:
                time.sleep(0.5)

    def _kill_child(self):
        if self.child.poll() is None:
            self.child.kill()
        self.child.wait()

    def test_sigterms_the_pid_in_the_agent_dirs_broker_pid_file(self):
        intercom = self.agent / "intercom"
        intercom.mkdir()
        (intercom / "broker.pid").write_text(str(self.child.pid), "utf-8")
        stop_intercom_broker(self.agent)
        self.assertIsNotNone(self.child.wait(timeout=20))
        self.assertNotEqual(self.child.returncode, 0)

    def test_no_broker_pid_file_is_a_no_op(self):
        stop_intercom_broker(self.agent)
        self.assertIsNone(self.child.poll())

    def test_a_stale_pid_file_for_a_gone_process_is_ignored(self):
        gone = subprocess.Popen([sys.executable, "-c", ""])
        gone.wait()
        intercom = self.agent / "intercom"
        intercom.mkdir()
        (intercom / "broker.pid").write_text(str(gone.pid), "utf-8")
        stop_intercom_broker(self.agent)  # must not raise
        self.assertIsNone(self.child.poll())


if __name__ == "__main__":
    unittest.main()
