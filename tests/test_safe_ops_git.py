"""scripts/safe_ops.py git read ops (status, log, diff_stat, branch_state): docs/tools.md.

Repositories live in temp dirs this test creates and removes on that exact path.
"""
import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops as base  # noqa: E402
from test_safe_ops import safe_ops  # noqa: E402


class GitReadTest(base.SafeOpsCase):
    def branch(self):
        return self.git("symbolic-ref", "--short", "HEAD").strip()

    def commit(self, name="f.txt", text="x\n", msg="c"):
        self.write(name, text)
        self.git("add", name)
        self.git("commit", "-q", "-m", msg)

    def test_status_counts_and_branch_fields(self):
        self.write("tracked.txt", "two\n")
        self.write("staged.txt", "s\n")
        self.git("add", "staged.txt")
        self.write("new.txt", "n\n")
        res = self.op("status")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["counts"], {"staged": 1, "unstaged": 1, "untracked": 1, "conflicted": 0})
        self.assertEqual((res["branch"], res["upstream"], res["ahead"]), (self.branch(), None, None))
        self.assertEqual(len(res["head"]), 40)
        self.assertEqual({f["path"]: f["xy"] for f in res["files"]},
                         {"tracked.txt": ".M", "staged.txt": "A.", "new.txt": "??"})

    def test_status_cap_at_200_entries(self):
        for i in range(250):
            self.write("f%03d.txt" % i, "")
        res = self.op("status")
        self.assertEqual((len(res["files"]), res["truncated"], res["total"]), (200, True, 250))
        self.assertEqual(res["counts"]["untracked"], 250)

    def test_byte_cap_from_long_subjects(self):
        for i in range(40):
            self.git("commit", "-q", "--allow-empty", "-m", ("%02d " % i) + "s" * 900)
        res = self.op("log", n=40)
        self.assertTrue(res["truncated"] and res["total"] == 40, res["total"])
        self.assertLessEqual(len(json.dumps(res)), safe_ops.MAX_BYTES)

    def test_log_default_20_and_n_bounds(self):
        for i in range(25):
            self.git("commit", "-q", "--allow-empty", "-m", "c%d" % i)
        res = self.op("log")
        self.assertEqual((len(res["commits"]), res["commits"][0]["subject"]), (20, "c24"))
        for n in (0, 201):
            self.failed(self.op("log", n=n), "bad_request")

    def test_log_option_like_rev_refused_without_side_effect(self):
        self.failed(self.op("log", rev="--output=x"), "bad_request")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "x")))

    def test_diff_stat_ranges(self):
        self.commit("f.txt", "a\nb\n")
        res = self.op("diff_stat", range="HEAD~1..HEAD")
        self.assertEqual(res["files"], [{"path": "f.txt", "added": 2, "deleted": 0, "binary": False}])
        self.assertEqual(res["totals"], {"files": 1, "added": 2, "deleted": 0})
        self.failed(self.op("diff_stat", range="HEAD..-x"), "bad_request")
        self.failed(self.op("diff_stat", range="HEAD:f.txt"), "bad_request")
        self.failed(self.op("diff_stat", range="0123456789abcdef0123456789abcdef01234567"), "unknown_revision")

    def test_path_outside_and_inside_git(self):
        self.failed(self.op("log", path="../x"), "outside_workspace")
        self.failed(self.op("diff_stat", path=".git/config"), "inside_git_dir")

    def test_branch_state_ahead_behind_and_merged(self):
        main = self.branch()
        bare = os.path.join(self.tmp, "remote.git")
        self.git("init", "-q", "--bare", bare, cwd=self.tmp)
        self.git("remote", "add", "origin", bare.replace(os.sep, "/"))
        self.git("push", "-q", "-u", "origin", main)
        self.commit("f.txt", "x\n", "ahead")
        cfg = {"baseBranch": main}
        res = self.op("branch_state", config=cfg)
        self.assertEqual((res["upstream"], res["ahead"], res["behind"]), ("origin/" + main, 1, 0))
        self.assertEqual((res["base"], res["mergedIntoBase"], res["baseAhead"]), (main, True, 0))
        self.git("checkout", "-q", "-b", "side")
        self.commit("g.txt", "y\n", "side")
        res = self.op("branch_state", config=cfg)
        self.assertEqual((res["branch"], res["mergedIntoBase"], res["baseAhead"]), ("side", False, 1))
        self.failed(self.op("branch_state", branch="nope"), "unknown_branch")

    @unittest.skipIf(sys.platform == "win32", "POSIX shell scripts")
    def test_planted_diff_external_and_fsmonitor_not_run(self):
        mark = os.path.join(self.tmp, "ran")
        script = os.path.join(self.tmp, "plant.sh")
        Path(script).write_text("#!/bin/sh\ntouch '%s'\n" % mark, "utf-8")
        os.chmod(script, 0o755)
        self.git("config", "diff.external", script)
        self.git("config", "core.fsmonitor", script)
        self.write("tracked.txt", "changed\n")
        self.assertTrue(self.op("diff_stat")["ok"])
        self.assertTrue(self.op("status")["ok"])
        self.assertFalse(os.path.exists(mark))


if __name__ == "__main__":
    unittest.main()
