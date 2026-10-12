"""Pi project trust for session worktrees: foreman_session open writes trust.json, worktree removal revokes it."""
from __future__ import annotations

import contextlib
import functools
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
import foreman_session as fsn  # noqa: E402
import foreman_trust as ft  # noqa: E402
import foreman_worktree as fw  # noqa: E402


def g(cwd, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(cwd),
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)


@functools.lru_cache(maxsize=1)
def pi_package():
    """The installed pi-coding-agent entry (`npm root -g`, run once and only by the test that needs it)."""
    try:
        root = subprocess.run(["npm", "root", "-g"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60,
                              check=True).stdout.decode().strip()
    except (OSError, subprocess.SubprocessError):
        return None
    for scope in ("@earendil-works", "@mariozechner"):
        p = Path(root) / scope / "pi-coding-agent" / "dist" / "index.js"
        if p.is_file():
            return p
    return None


class TrustTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(os.path.realpath(tempfile.mkdtemp(prefix="trust_test_")))
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        patch = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        patch.start()
        self.addCleanup(patch.stop)
        self.agent = self.tmp / "agent"
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        g(self.repo, "init", "-q")
        (self.repo / "README").write_text("x\n")
        g(self.repo, "add", "README")
        g(self.repo, "commit", "-q", "-m", "init")
        g(self.repo, "branch", "-M", "main")
        self.wt = self.tmp / "repo.worktrees" / "round"
        g(self.repo, "worktree", "add", "-q", "-b", "round", str(self.wt))
        (self.wt / ".agents" / "skills").mkdir(parents=True)  # what makes Pi ask
        self.other = self.tmp / "elsewhere"
        g(self.repo, "worktree", "add", "-q", "-b", "other", str(self.other))
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n", "utf-8")
        self.trust = self.agent / "trust.json"

    def open(self, cwd, *extra):
        out = io.StringIO()
        env = {"PI_CODING_AGENT_DIR": str(self.agent)}
        with mock.patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            os.environ.pop("HERDR_PANE_ID", None)
            code = fsn.main(["open", "t", str(self.brief), "--cwd", str(cwd), "--parent-id", "p-1", "--agent-dir",
                             str(self.agent)] + list(extra))
        return code, out.getvalue()

    def store(self):
        return json.loads(self.trust.read_text("utf-8"))

    def test_open_trusts_the_exact_fresh_worktree_and_keeps_other_entries(self):
        self.agent.mkdir()
        self.trust.write_text(json.dumps({"/some/other": False, "/keep": True}), "utf-8")
        code, _ = self.open(self.wt)
        self.assertEqual(code, 0)
        data = self.store()
        self.assertEqual(data, {"/keep": True, "/some/other": False, str(self.wt): True})
        self.assertNotIn(str(self.wt.parent), data)
        entry = fsn.read_registry(self.agent)["sessions"][0]
        self.assertEqual(entry["trusted"], str(self.wt))

    def test_dry_run_writes_nothing(self):
        code, _ = self.open(self.wt, "--dry-run")
        self.assertEqual(code, 0)
        self.assertFalse(self.agent.exists())

    def test_non_managed_cwd_and_main_worktree_are_not_trusted(self):
        for cwd in (self.other, self.repo, self.repo / ".git"):
            self.open(cwd)
        self.assertFalse(self.trust.exists())

    def test_existing_user_entry_is_neither_changed_nor_recorded(self):
        self.agent.mkdir()
        self.trust.write_text(json.dumps({str(self.wt): True}), "utf-8")
        self.open(self.wt)
        self.assertNotIn("trusted", fsn.read_registry(self.agent)["sessions"][0])
        self.assertTrue(ft.release(self.wt, self.agent) is False)
        self.assertEqual(self.store(), {str(self.wt): True})

    def test_malformed_store_is_left_alone(self):
        self.agent.mkdir()
        self.trust.write_text("{not json", "utf-8")
        code, _ = self.open(self.wt)
        self.assertEqual(code, 0)
        self.assertEqual(self.trust.read_text("utf-8"), "{not json")

    def test_worktree_removal_deletes_only_the_recorded_entry(self):
        self.agent.mkdir()
        self.trust.write_text(json.dumps({"/keep": True}), "utf-8")
        self.open(self.wt)
        self.assertIn(str(self.wt), self.store())
        state = self.tmp / "state"
        state.mkdir()
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(self.agent)}), contextlib.redirect_stdout(out):
            fw.main(["sweep", "--cwd", str(self.repo), "--state", str(state / "s.json"), "--session", "s"])
        self.assertFalse(self.wt.exists(), out.getvalue())
        self.assertEqual(self.store(), {"/keep": True})
        self.assertNotIn("trusted", fsn.read_registry(self.agent)["sessions"][0])

    def test_pi_trust_store_sees_the_worktree_as_trusted(self):
        pkg = pi_package()
        if pkg is None:
            self.skipTest("pi-coding-agent is not installed")
        self.open(self.wt)
        js = ("import {ProjectTrustStore} from %s; const s = new ProjectTrustStore(process.argv[1]);"
              "console.log(JSON.stringify([s.get(process.argv[2]), s.get(process.argv[3])]));"
              % json.dumps(pkg.as_uri()))
        r = subprocess.run(["node", "--input-type=module", "-e", js, str(self.agent), str(self.wt / "sub"),
                            str(self.other)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(json.loads(r.stdout.decode()), [True, None], r.stderr.decode())


if __name__ == "__main__":
    unittest.main()
