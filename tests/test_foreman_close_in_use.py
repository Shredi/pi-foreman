"""scripts/foreman_close.py in_use_by: sessions on another machine and non-absolute working directories hold nothing."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_close as fcl  # noqa: E402

# a path that is absolute on another platform but not on this one
FOREIGN = ["/home/u/repo", "/home/u/repo/sub"] if os.name == "nt" else ["C:\\repo", "C:/repo"]


class InUseByForeignTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="close_use_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.state = self.tmp / "state"
        (self.state / "live").mkdir(parents=True)
        self.wt = self.tmp / "repo.worktrees" / "demo"
        (self.wt / "sub").mkdir(parents=True)
        (self.tmp / "repo.worktrees" / "demo2").mkdir()
        old = os.getcwd()
        self.addCleanup(os.chdir, old)
        os.chdir(str(self.wt))

    def registry(self, cwd="__missing__", status="open", machine=None):
        entry = {"label": "demo", "child": "child-1", "status": status}
        if cwd != "__missing__":
            entry["cwd"] = cwd
        if machine:
            entry["machine"] = machine
        (self.state / "sessions.json").write_text(json.dumps({"sessions": [entry]}), "utf-8")

    def live(self, cwd="__missing__", sid="other", state="working"):
        d = {"sessionId": sid, "state": state}
        if cwd != "__missing__":
            d["cwd"] = cwd
        (self.state / "live" / (sid + ".json")).write_text(json.dumps(d), "utf-8")

    def use(self):
        return fcl.in_use_by(str(self.state), "caller", str(self.wt))

    # remote entries
    def test_remote_entry_with_foreign_cwd_does_not_hold(self):
        for status in ("open", "pending", "closing"):
            for cwd in FOREIGN:
                with self.subTest(status=status, cwd=cwd):
                    self.registry(cwd, status, "alpha")
                    self.assertIsNone(self.use())

    def test_remote_entry_with_the_worktree_path_does_not_hold(self):
        for status in ("open", "pending", "closing"):
            with self.subTest(status=status):
                self.registry(str(self.wt), status, "alpha")
                self.assertIsNone(self.use())
                self.registry(str(self.wt / "sub"), status, "alpha")
                self.assertIsNone(self.use())

    # other repositories
    def test_sibling_directories_do_not_hold(self):
        sibling = self.tmp / "repo.worktrees" / "demo2"
        for cwd in (str(sibling), str(self.tmp)):
            with self.subTest(cwd=cwd):
                self.registry(cwd)
                self.assertIsNone(self.use())
                self.live(cwd)
                self.assertIsNone(self.use())

    # values that are not an absolute path here
    def test_unusable_cwd_does_not_hold(self):
        for cwd in ("", "__missing__", None, 7, ".", "sub", "~", *FOREIGN):
            with self.subTest(cwd=cwd):
                self.registry(cwd)
                self.assertIsNone(self.use())
                self.live(cwd)
                self.assertIsNone(self.use())

    # positives
    def test_local_registry_entry_holds(self):
        for status in ("open", "pending", "closing"):
            for cwd in (self.wt, self.wt / "sub"):
                with self.subTest(status=status, cwd=str(cwd)):
                    self.registry(str(cwd), status)
                    self.assertEqual(self.use(), "child-1")

    def test_live_file_holds_unless_done_or_own(self):
        self.live(str(self.wt / "sub"))
        self.assertEqual(self.use(), "other")
        self.live(str(self.wt / "sub"), state="done")
        self.assertIsNone(self.use())
        (self.state / "live" / "other.json").unlink()
        self.live(str(self.wt / "sub"), sid="caller")
        self.assertIsNone(self.use())


if __name__ == "__main__":
    unittest.main()
