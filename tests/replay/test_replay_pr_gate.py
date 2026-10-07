"""Replay: review before PR (ledger items 10-12, 17) on the fake provider, permissions="baseline".

One foreman session walks the gate: `gh pr create` with no review is refused (no_review); a
reviewer PASS at HEAD lets it through; a new commit makes the review stale; a `git push -o
merge_request.create` is gated like it, `-o ci.skip` is not; a registered package PR tool goes
through the permission system (the owner allows it) and is gated too. A child's `gh pr create`
is refused (child) and a workspace that is not a repository refuses (head_unknown). `gh` is a
fake program on PATH that leaves a marker file, so "allowed" means the program really ran.

Run: python -m unittest discover -s tests/replay -v (same prerequisites as test_replay.py).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

PR_TOOL = "github_create_pr"
ASK_YES = [{"confirmed": True, "value": "Yes"}] * 12  # answers a select and a confirm alike


def commit(project, msg):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", msg],
                   cwd=str(project), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def fake_gh(rig):
    """A `gh` that only records its arguments; returns (bin dir, marker file)."""
    bindir = rig.root / "fakebin"
    bindir.mkdir()
    marker = rig.root / "gh-ran.txt"
    (bindir / "gh").write_text('#!/bin/sh\necho "$@" >> "%s"\necho fake gh ran\n' % marker, "utf-8")
    (bindir / "gh").chmod(0o755)
    (bindir / "gh.cmd").write_text('@echo off\r\necho %%* >> "%s"\r\necho fake gh ran\r\n' % marker, "utf-8")
    return bindir, marker


def allow_tool(rig, name):
    """The owner allows the package tool, so only the foreman's gate stands in its way."""
    cfg = rig.agent / "extensions" / "pi-permission-system" / "config.json"
    data = json.loads(cfg.read_text("utf-8"))
    data.setdefault("tools", {})[name] = "allow"
    data.setdefault("permission", {})[name] = "allow"
    cfg.write_text(json.dumps(data, indent=1), "utf-8")


def last(res):
    return res[-1]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestPrGate(ReplayCase):
    def pr_rig(self, name):
        rig = self.rig(name, load_fixture("pr_gate"), permissions="baseline")
        commit(rig.project, "chore: init")
        bindir, marker = fake_gh(rig)
        env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "FOREMAN_FAKE_PR_TOOL": PR_TOOL}
        return rig, env, marker

    def attempt(self, pi, tag):
        return tool_results(pi.prompt("[[replay:%s]] go" % tag, answers=ASK_YES, timeout=90))

    def test_gate_walk(self):
        rig, env, marker = self.pr_rig("prgate")
        allow_tool(rig, PR_TOOL)
        pi = rig.start(env=env)

        none = last(self.attempt(pi, "pr-gh"))
        self.assertTrue(none[1], none)
        self.assertIn("pr_refused:no_review", none[2])
        self.assertFalse(marker.exists(), "gh ran without a review")

        self.attempt(pi, "pr-review")
        pi.wait_child_notify(timeout=120, answers=ASK_YES)
        ok = last(self.attempt(pi, "pr-gh"))
        self.assertFalse(ok[1], ok)
        self.assertIn("fake gh ran", ok[2])
        self.assertTrue(marker.exists(), "gh did not run after a PASS at HEAD")

        commit(rig.project, "feat: more work after the review")
        stale = last(self.attempt(pi, "pr-gh"))
        self.assertTrue(stale[1], stale)
        self.assertIn("pr_refused:stale_review", stale[2])
        self.assertIn("reviewer", stale[2])

        mr = last(self.attempt(pi, "pr-mr"))
        self.assertIn("pr_refused:stale_review", mr[2])
        ci = last(self.attempt(pi, "pr-ci"))
        self.assertNotIn("pr_refused", ci[2], "ci.skip must not be gated by the PR rule")

        tool = last(self.attempt(pi, "pr-tool"))
        self.assertTrue(tool[1], tool)
        self.assertIn("pr_refused:stale_review", tool[2])
        pi.close()

        reasons = [r.get("reason") for r in trace_of(rig.traces(), "foreman") if r.get("event") == "pr_refused"]
        self.assertEqual(reasons, ["no_review", "stale_review", "stale_review", "stale_review"])

    def test_pr_tool_without_review(self):
        rig, env, _ = self.pr_rig("prtool")
        allow_tool(rig, PR_TOOL)
        pi = rig.start(env=env)
        tool = last(self.attempt(pi, "pr-tool"))
        pi.close()
        self.assertTrue(tool[1], tool)
        self.assertIn("pr_refused:no_review", tool[2])

    def test_compound_refused(self):
        # B-M1: a commit in the same command would move HEAD after the check; even a reviewed HEAD is refused.
        rig, env, marker = self.pr_rig("prcompound")
        pi = rig.start(env=env)
        self.attempt(pi, "pr-review")
        pi.wait_child_notify(timeout=120, answers=ASK_YES)
        res = last(self.attempt(pi, "pr-compound"))
        pi.close()
        self.assertTrue(res[1], res)
        self.assertIn("pr_refused:pr_compound", res[2])
        self.assertIn("run the PR step on its own", res[2])
        self.assertFalse(marker.exists(), "gh ran in a compound command")
        reasons = [r.get("reason") for r in trace_of(rig.traces(), "foreman") if r.get("event") == "pr_refused"]
        self.assertEqual(reasons, ["pr_compound"])

    def test_child_pr_refused(self):
        rig, env, marker = self.pr_rig("prchild")
        pi = rig.start(env=env)
        pi.prompt("[[replay:pr-child]] go", answers=ASK_YES, timeout=90)
        notice, _ = pi.wait_child_notify(timeout=120, answers=ASK_YES)
        pi.close()
        self.assertIn("child: pr attempt finished", notice)
        self.assertTrue([p for p in rig.root.rglob("control.txt") if p.is_file()], "the child's harmless bash call did not run")
        self.assertFalse(marker.exists(), "the child's gh pr create reached the program")

    def test_non_repository_head_unknown(self):
        rig, env, marker = self.pr_rig("prnogit")
        # rename, not delete: git objects are read-only on Windows and rmtree fails there
        os.rename(str(rig.project / ".git"), str(rig.project / "git-off"))
        pi = rig.start(env=env)
        res = last(self.attempt(pi, "pr-gh"))
        pi.close()
        self.assertTrue(res[1], res)
        self.assertIn("pr_refused:head_unknown", res[2])
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
