"""`foreman session open --worktree [--base REF]` (scripts/foreman_session.py): the round worktree is created
from a temporary bare origin and a clone; `npm ci` goes through a patched runner, never the real npm; nothing
reaches the network."""
from __future__ import annotations

import contextlib
import io
import json
import ntpath
import os
import posixpath
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
import foreman_session as fsn  # noqa: E402

GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}


def git(cwd, *args):
    env = dict(os.environ, **GIT_ENV)
    return subprocess.run(["git", "-C", str(cwd)] + list(args), check=True, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE).stdout.decode().strip()


class WorktreeOpenTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_wt_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.origin = self.tmp / "origin.git"
        self.work = self.tmp / "work"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(self.tmp, "clone", "-q", str(self.origin), str(self.work))
        (self.work / "README.md").write_text("hi\n", "utf-8")
        git(self.work, "add", ".")
        git(self.work, "commit", "-q", "-m", "init")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        git(self.work, "remote", "set-head", "origin", "main")
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n", "utf-8")
        self.env = {"PI_CODING_AGENT_DIR": str(self.agent), "HERDR_PANE_ID": "", "HC_TERMINAL_ID": "", "PI_INTERCOM_STABLE_ID": "",
                    "PI_INTERCOM_SESSION_ID": "", "PI_FOREMAN_HANDOFF_DIR": "", **GIT_ENV}
        self.target = self.tmp / "work.worktrees" / "demo"

    def run_main(self, *extra, label="demo", cwd=None):
        argv = ("open", label, str(self.brief), "--cwd", str(cwd or self.work), "--parent-id", "parent-1") + extra
        out, err = io.StringIO(), io.StringIO()
        drop = [k for k, v in self.env.items() if v == ""]
        with mock.patch.dict(os.environ, self.env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            for k in drop:
                os.environ.pop(k, None)
            code = fsn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def registry(self):
        return json.loads((self.agent / "pi-foreman" / "state" / "sessions.json").read_text("utf-8"))["sessions"]

    def test_success_without_a_lockfile_installs_nothing(self):
        with mock.patch.object(fsn, "run_npm_ci") as npm:
            code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 0, err)
        npm.assert_not_called()
        self.assertTrue((self.target / "README.md").is_file())
        self.assertEqual(git(self.target, "rev-parse", "--abbrev-ref", "HEAD"), "round/demo")
        self.assertEqual(git(self.target, "rev-parse", "HEAD"), git(self.work, "rev-parse", "origin/main"))
        line = [l for l in out.splitlines() if l.startswith(fsn.WORKTREE_MARK)][0]
        info = json.loads(line[len(fsn.WORKTREE_MARK):])
        self.assertEqual(info, {"path": str(self.target), "branch": "round/demo", "base": "origin/main", "install": "none"})
        self.assertEqual(self.registry()[0]["cwd"], str(self.target))

    def test_lockfile_runs_npm_ci_through_the_runner(self):
        (self.work / "package-lock.json").write_text("{}\n", "utf-8")
        git(self.work, "add", ".")
        git(self.work, "commit", "-q", "-m", "lock")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        with mock.patch.object(fsn, "run_npm_ci", return_value=0) as npm:
            code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 0, err)
        npm.assert_called_once_with(str(self.target))
        self.assertIn('"install": "npm ci"', out)

    def test_failed_install_keeps_the_worktree_and_still_opens(self):
        (self.work / "npm-shrinkwrap.json").write_text("{}\n", "utf-8")
        git(self.work, "add", ".")
        git(self.work, "commit", "-q", "-m", "lock")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        with mock.patch.object(fsn, "run_npm_ci", return_value=7):
            code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 0, err)
        self.assertTrue(self.target.is_dir())
        self.assertIn('"install": "failed:7"', out)
        self.assertIn("failed:7", err)
        self.assertEqual(len(self.registry()), 1)

    def test_base_ref_is_used(self):
        git(self.work, "tag", "v1")
        (self.work / "more.txt").write_text("x\n", "utf-8")
        git(self.work, "add", ".")
        git(self.work, "commit", "-q", "-m", "more")
        git(self.work, "push", "-q", "origin", "HEAD:main")
        code, out, err = self.run_main("--worktree", "--base", "v1")
        self.assertEqual(code, 0, err)
        self.assertFalse((self.target / "more.txt").exists())

    def test_linked_worktree_as_cwd_still_uses_the_main_checkout(self):
        other = self.tmp / "other"
        git(self.work, "worktree", "add", "-q", str(other), "-b", "side")
        code, out, err = self.run_main("--worktree", cwd=other)
        self.assertEqual(code, 0, err)
        self.assertTrue(self.target.is_dir())

    def test_refuses_an_existing_path(self):
        self.target.mkdir(parents=True)
        code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 1)
        self.assertIn("path exists", err)
        self.assertEqual(git(self.work, "branch", "--list", "round/demo"), "")

    def test_refuses_an_existing_branch(self):
        git(self.work, "branch", "round/demo")
        code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 1)
        self.assertIn("branch exists", err)
        self.assertFalse(self.target.exists())

    def test_refuses_without_origin(self):
        git(self.work, "remote", "remove", "origin")
        code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 1)
        self.assertIn("origin", err)
        self.assertFalse(self.target.exists())

    def test_refuses_a_bad_base(self):
        for base in ("nope", "--detach"):
            code, out, err = self.run_main("--worktree", "--base=" + base)
            self.assertEqual(code, 1, base)
            self.assertIn("--base", err)
        self.assertFalse(self.target.exists())

    def test_refuses_outside_a_checkout_machine_and_base_alone(self):
        outside = self.tmp / "plain"
        outside.mkdir()
        self.assertIn("git checkout", self.run_main("--worktree", cwd=outside)[2])
        self.assertIn("--machine", self.run_main("--worktree", "--machine", "alpha")[2])
        self.assertIn("--base needs --worktree", self.run_main("--base", "main")[2])

    def test_dry_run_creates_nothing(self):
        before = git(self.work, "branch", "--list")
        code, out, err = self.run_main("--worktree", "--dry-run")
        self.assertEqual(code, 0, err)
        self.assertIn(str(self.target), out)
        self.assertIn("round/demo", out)
        self.assertFalse(self.target.exists())
        self.assertEqual(git(self.work, "branch", "--list"), before)
        self.assertFalse((self.agent / "pi-foreman" / "state" / "sessions.json").exists())

    def test_branch_prefix_from_config(self):
        with mock.patch.object(fsn, "sessions_config", return_value={"worktree": {"branchPrefix": "wip"}}):
            code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 0, err)
        self.assertEqual(git(self.target, "rev-parse", "--abbrev-ref", "HEAD"), "wip/demo")

    def test_bad_branch_prefix_is_refused(self):
        with mock.patch.object(fsn, "sessions_config", return_value={"worktree": {"branchPrefix": "-x"}}):
            code, out, err = self.run_main("--worktree")
        self.assertEqual(code, 1)
        self.assertIn("branchPrefix", err)

    def test_path_join_is_pure_for_windows_and_posix(self):
        self.assertEqual(fsn.worktree_target("C:\\work\\repo.worktrees", "demo", ntpath), "C:\\work\\repo.worktrees\\demo")
        self.assertEqual(fsn.worktree_target("/w/repo.worktrees", "demo", posixpath), "/w/repo.worktrees/demo")

    def test_npm_runner_picks_npm_cmd_on_windows(self):
        seen = []
        with mock.patch.object(fsn, "host_platform", return_value="win32"), \
                mock.patch.object(fsn.shutil, "which", side_effect=lambda n: seen.append(n)):
            self.assertEqual(fsn.run_npm_ci(self.tmp), 127)
        self.assertEqual(seen, ["npm.cmd"])


if __name__ == "__main__":
    unittest.main()
