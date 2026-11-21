"""D118 in the bench: the worktree root is writable inside the cell, and scripted builder launches stay in the task repo."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bench"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import wait_session as ws  # noqa: E402

ROW = {"id": "r", "agent": "foreman", "provider": "p", "roles": {"foreman": {"model": "p/foreman"}}}


class TestBenchSessionFolder(unittest.TestCase):
    def test_worktree_root_is_under_the_cell_work_dir(self):
        self.assertEqual(ws.foreman_config(ROW, "/tmp/cell")["close"], {"worktreeDir": "/tmp/cell/worktrees/<repo>"})
        self.assertNotIn("close", ws.foreman_config(ROW))

    def test_a_preset_user_config_wins(self):
        row = dict(ROW, user_config={"close": {"worktreeDir": "/srv/w/<repo>"}})
        self.assertEqual(ws.foreman_config(row, "/tmp/cell")["close"]["worktreeDir"], "/srv/w/<repo>")

    def test_fake_builder_launches_run_in_the_task_repo(self):
        args = mock.Mock(work=tempfile.gettempdir(), fake_script="/x/fake.json", cwd="/app")
        self.assertEqual(ws.pi_env(args, Path("/agent"), None)["FOREMAN_FAKE_CWD"], "/app")
        args.fake_script = None
        self.assertNotIn("FOREMAN_FAKE_CWD", ws.pi_env(args, Path("/agent"), None))


if __name__ == "__main__":
    unittest.main()
