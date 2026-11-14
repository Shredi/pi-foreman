"""Replay: the pr_label op over the real script entry point (the ready label of a watched PR).

pr_label is not a model-facing tool: the session's PR watch calls it, in process, as `python scripts/safe_ops.py` with the request on stdin
(the same call `prRun` makes). This case runs that entry point as a child process, as the session does, against the fake gh
(tests/fixtures/fake_pr_host.py behind sh and .cmd shims, first on PATH): an add reads the labels (`gh pr view --json labels`) and then edits, a label already in
the wanted state answers `changed: false` with no write, a GitLab host answers pr_unsupported. The golden holds the host calls only (argv), no PR content.
Same prerequisites and skips as test_replay.py.
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
ARGS = {"number": 7, "repo": "own/repo", "host": "ghe.example.com", "label": "ready", "on": True}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPrLabel(ReplayCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.mkdtemp(prefix="pr-label-replay-")
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
        req = {"op": "pr_label", "args": args, "cwd": self.repo, "config": {"prHost": pr_host}}
        p = subprocess.run([sys.executable, str(SAFE_OPS)], input=json.dumps(req).encode("utf-8"), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        return json.loads(p.stdout.decode("utf-8"))

    def calls(self):
        f = self.host / "calls.jsonl"
        return [json.loads(x)["argv"] for x in f.read_text("utf-8").splitlines()] if f.exists() else []

    def test_add_and_remove_read_first_and_carry_the_repository_and_host(self):
        scenario = {"gh pr view": {"stdout": json.dumps({"labels": [{"name": "bug"}]})}, "gh pr edit": {"stdout": ""}}
        added = self.run_op(ARGS, scenario)
        self.assertEqual((added["ok"], added["changed"], added["on"]), (True, True, True))
        scenario = {"gh pr view": {"stdout": json.dumps({"labels": [{"name": "Ready"}]})}, "gh pr edit": {"stdout": ""}}
        removed = self.run_op({**ARGS, "on": False}, scenario)
        self.assertEqual((removed["ok"], removed["changed"], removed["on"]), (True, True, False))
        calls = self.calls()
        self.assertEqual(
            calls,
            [
                ["gh", "pr", "view", "7", "-R", "ghe.example.com/own/repo", "--json", "labels"],
                ["gh", "pr", "edit", "7", "-R", "ghe.example.com/own/repo", "--add-label", "ready"],
                ["gh", "pr", "view", "7", "-R", "ghe.example.com/own/repo", "--json", "labels"],
                ["gh", "pr", "edit", "7", "-R", "ghe.example.com/own/repo", "--remove-label", "ready"],
            ],
        )
        self.golden("pr_label", {"calls": calls})

    def test_a_label_already_in_the_wanted_state_writes_nothing(self):
        res = self.run_op(ARGS, {"gh pr view": {"stdout": json.dumps({"labels": [{"name": "ready"}]})}})
        self.assertEqual((res["ok"], res["changed"]), (True, False))
        self.assertEqual([c[:3] for c in self.calls()], [["gh", "pr", "view"]])

    def test_a_failing_gh_is_an_answer_not_a_crash(self):
        res = self.run_op(ARGS, {"gh pr view": {"stderr": "boom\n", "exit": 1}})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "pr_host_failed")

    def test_a_gitlab_host_is_unsupported_and_nothing_runs(self):
        res = self.run_op(ARGS, {}, pr_host="glab")
        self.assertEqual((res["ok"], res.get("precondition")), (False, "pr_unsupported"))
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
