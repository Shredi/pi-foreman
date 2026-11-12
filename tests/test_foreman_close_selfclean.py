"""scripts/foreman_close.py selfclean: a child whose PR was merged removes its own worktree and branch (temp repos only)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_close as fcl  # noqa: E402
import safe_ops  # noqa: E402


def g(cwd, *args):
    r = subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


class SelfClean(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="selfclean_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.state = self.tmp / "agent" / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q", "-b", "main")
        (self.repo / "README").write_text("x\n")
        (self.repo / ".gitignore").write_text(".workflow/\n")
        g(self.repo, "add", ".")
        g(self.repo, "commit", "-q", "-m", "init")
        self.wt = self.tmp / "wt"
        g(self.repo, "worktree", "add", "-q", "-b", "feat", str(self.wt))
        (self.wt / "f.txt").write_text("feature\n")
        g(self.wt, "add", "f.txt")
        g(self.wt, "commit", "-q", "-m", "feature")
        self.tip = g(self.wt, "rev-parse", "HEAD")
        g(self.repo, "merge", "--squash", "feat")  # squash: the tip is not an ancestor of main
        g(self.repo, "commit", "-q", "-m", "feature (squash)")
        (self.wt / ".workflow").mkdir()
        (self.wt / ".workflow" / "LEDGER.md").write_text("# l\n")
        self.handoff = self.tmp / "handoff"
        self.handoff.mkdir()

    def selfclean(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fcl.main(["selfclean", "--ws", str(self.wt), "--branch", "feat", "--state", str(self.state),
                             "--session", "child-1", *extra])
        return code, out.getvalue()

    def test_squash_merge_needs_the_fact(self):
        code, out = self.selfclean("--archive", str(self.handoff / "workflow"))
        self.assertEqual((code, json.loads(out)["reason"]), (3, "not_merged"))
        code, out = self.selfclean("--verified-merged", "0" * 40, "--archive", str(self.handoff / "workflow"))
        self.assertEqual(json.loads(out)["reason"], "verified_merged_stale")
        code, out = self.selfclean("--verified-merged", self.tip, "--archive", str(self.handoff / "workflow"))
        self.assertEqual((code, json.loads(out)["ok"]), (0, True))
        self.assertTrue((self.handoff / "workflow" / "LEDGER.md").is_file())

    def test_workflow_counts_until_archived(self):
        code, out = self.selfclean("--verified-merged", self.tip)
        self.assertEqual(json.loads(out)["reason"], "ignored_files")

    def test_run_removes_worktree_and_forces_the_branch_only_with_the_fact(self):
        result = self.tmp / "cleanup.json"
        code, _ = self.selfclean("--verified-merged", self.tip, "--exempt-workflow", "--wait-pid", "99999999",
                                 "--out", str(result))
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["status"], "removed")
        self.assertFalse(self.wt.exists())
        self.assertEqual(g(self.repo, "branch", "--list", "feat"), "")

    def test_run_without_the_fact_refuses_and_writes_the_reason(self):
        result = self.tmp / "cleanup.json"
        code, _ = self.selfclean("--exempt-workflow", "--wait-pid", "99999999", "--out", str(result))
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["reason"], "not_merged")
        self.assertTrue(self.wt.exists())

    def test_branch_delete_flag_is_per_call(self):
        calls = []
        with mock.patch.object(safe_ops, "git", side_effect=lambda a, c, check=False: (calls.append(a), (0, "", ""))[1]), \
                mock.patch.dict(sys.modules, {"foreman_trust": mock.Mock()}):
            safe_ops.remove_worktree({"target": "/t", "main_dir": "/m", "branch": "b"})
            safe_ops.remove_worktree({"target": "/t", "main_dir": "/m", "branch": "b"}, force_branch=True)
        self.assertEqual([c for c in calls if c[0] == "branch"], [["branch", "-d", "b"], ["branch", "-D", "b"]])

    def test_only_the_top_level_workflow_is_exempt(self):
        (self.wt / "sub").mkdir()
        (self.wt / "sub" / "keep.txt").write_text("k\n")
        g(self.wt, "add", "sub/keep.txt")
        g(self.wt, "commit", "-q", "-m", "sub")
        tip = g(self.wt, "rev-parse", "HEAD")
        (self.wt / "sub" / ".workflow").mkdir()
        (self.wt / "sub" / ".workflow" / "x").write_text("x\n")
        code, out = self.selfclean("--verified-merged", tip, "--exempt-workflow")
        self.assertEqual(code, 3)
        self.assertEqual(json.loads(out)["reason"], "ignored_files")

    def test_verified_branch_delete_is_atomic_against_the_sha(self):
        chk = {"target": str(self.wt), "main_dir": str(self.repo), "branch": "feat"}
        with mock.patch.dict(sys.modules, {"foreman_trust": mock.Mock()}):
            res = safe_ops.remove_worktree(chk, force_branch=True, verified_sha=g(self.repo, "rev-parse", "main~1"))
        self.assertFalse(res["branchDeleted"])
        self.assertEqual(g(self.repo, "rev-parse", "refs/heads/feat"), self.tip)


if __name__ == "__main__":
    unittest.main()
