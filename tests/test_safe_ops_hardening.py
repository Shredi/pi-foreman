"""scripts/safe_ops.py runs no program a child planted in the shared repo (security review T1).

The planted programs only append a line to a marker file inside the temp dir this test
created (tempfile.mkdtemp, removed with shutil.rmtree on that exact path, see SafeOpsCase).
"""
import os
import stat
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_safe_ops import SafeOpsCase, safe_ops  # noqa: E402


class HardeningArgsTest(SafeOpsCase):
    def test_every_git_call_carries_the_overrides(self):
        calls = []
        real = subprocess.run

        def spy(argv, **kw):
            calls.append((argv, kw.get("env") or {}))
            return real(argv, **kw)

        with mock.patch.object(safe_ops.subprocess, "run", side_effect=spy):
            self.write("a.txt", "x\n")
            self.assertTrue(self.op("move", src="a.txt", dst="b.txt")["ok"])
        self.assertTrue(calls)
        for argv, env in calls:
            joined = " ".join(argv[1:7])
            self.assertIn("-c core.fsmonitor=false", joined)
            self.assertIn("-c protocol.ext.allow=never", joined)
            hooks = argv[6].split("=", 1)[1]
            self.assertTrue(argv[6].startswith("core.hooksPath="), argv)
            self.assertEqual(os.listdir(hooks), [])
            self.assertEqual(env.get("GIT_CONFIG_NOSYSTEM"), "1")


@unittest.skipIf(os.name == "nt", "the planted programs are POSIX shell scripts")
class PlantedProgramTest(SafeOpsCase):
    def plant(self):
        self.marker = os.path.join(self.tmp, "ran.txt")
        script = self.write("planted.sh", "#!/bin/sh\necho ran >> '%s'\n" % self.marker, base=self.tmp)
        os.chmod(script, stat.S_IRWXU)
        self.git("config", "core.fsmonitor", script)
        hook = os.path.join(self.repo, ".git", "hooks", "reference-transaction")
        Path(hook).write_text(Path(script).read_text("utf-8"), "utf-8")
        os.chmod(hook, stat.S_IRWXU)

    def test_worktree_remove_runs_no_planted_fsmonitor_or_hook(self):
        wt = os.path.join(self.tmp, "wt")
        self.git("worktree", "add", "-q", "-b", "feat", wt)
        self.plant()
        # Control: plain git in the worktree does run the planted fsmonitor.
        self.git("status", "--porcelain", cwd=wt)
        self.assertTrue(os.path.exists(self.marker), "control: the planted fsmonitor did not run")
        os.remove(self.marker)
        # Control: a plain ref update runs the planted reference-transaction hook.
        self.git("-c", "core.fsmonitor=false", "branch", "control")
        self.assertTrue(os.path.exists(self.marker), "control: the planted hook did not run")
        os.remove(self.marker)
        res = self.op("worktree_remove", path=wt)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["branchDeleted"], res)
        self.assertFalse(os.path.exists(self.marker), "safe_ops ran a planted program")


if __name__ == "__main__":
    unittest.main()
