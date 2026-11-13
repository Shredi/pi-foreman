"""Replay: the pr_draft op over the real script entry point (draft handling of an owned PR, phase A).

pr_draft is not a model-facing tool: the session's PR watch calls it, in process, as `python scripts/safe_ops.py` with the request on stdin
(the same call `prRun` makes). This case runs that entry point as a child process, as the session does, against the fake gh
(tests/fixtures/fake_pr_host.py behind sh and .cmd shims, first on PATH): draft off is `gh pr ready`, draft on is `gh pr ready --undo`,
both with the repository and host of the request (never the checkout's default); a GitLab host and a failing gh answer without a crash.
The golden holds the host calls only (argv), no PR content. Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "fixtures"))
from pr_host_shims import make_bin  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

SAFE_OPS = Path(__file__).resolve().parents[2] / "scripts" / "safe_ops.py"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPrDraft(ReplayCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix="pr-draft-replay-")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        subprocess.run(["git", "init", "-q", self.repo], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.host = Path(self.tmp, "host")
        self.host.mkdir()

    def run_op(self, args, scenario, pr_host="auto"):
        (self.host / "scenario.json").write_text(json.dumps(scenario), "utf-8")
        bin_dir = make_bin(self.tmp, ["gh", "glab"])
        env = {**os.environ, "PATH": bin_dir + os.pathsep + os.environ.get("PATH", ""), "FAKE_PR_HOST_DIR": str(self.host)}
        req = {"op": "pr_draft", "args": args, "cwd": self.repo, "config": {"prHost": pr_host}}
        p = subprocess.run([sys.executable, str(SAFE_OPS)], input=json.dumps(req).encode("utf-8"), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        return json.loads(p.stdout.decode("utf-8"))

    def calls(self):
        f = self.host / "calls.jsonl"
        return [json.loads(x)["argv"] for x in f.read_text("utf-8").splitlines()] if f.exists() else []

    def test_draft_off_and_on_carry_the_repository_and_host(self):
        scenario = {"gh pr ready": {"stdout": ""}}
        off = self.run_op({"number": 7, "repo": "own/repo", "host": "ghe.example.com", "draft": False}, scenario)
        on = self.run_op({"number": 7, "repo": "own/repo", "host": "github.com", "draft": True}, scenario)
        self.assertEqual([(r["ok"], r["draft"]) for r in (off, on)], [(True, False), (True, True)])
        calls = self.calls()
        self.assertEqual(calls, [["gh", "pr", "ready", "7", "-R", "ghe.example.com/own/repo"], ["gh", "pr", "ready", "7", "-R", "github.com/own/repo", "--undo"]])
        self.golden("pr_draft", {"calls": calls})

    def test_a_failing_gh_is_an_answer_not_a_crash(self):
        res = self.run_op({"number": 7, "repo": "own/repo", "draft": True}, {"gh pr ready": {"stderr": "unknown flag: --undo\n", "exit": 1}})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "pr_host_failed")

    def test_a_gitlab_host_is_unsupported_and_nothing_runs(self):
        res = self.run_op({"number": 7, "repo": "own/repo", "draft": True}, {}, pr_host="glab")
        self.assertEqual((res["ok"], res.get("precondition")), (False, "pr_unsupported"))
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
