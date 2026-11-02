"""Replay: a worktree child gets the foreman's checkout in its env and the worktree line in its brief (ceremony-fixes-2 item 1).

A builder launched with `worktree: true` (a single launch) finds `FOREMAN_CHECKOUT` in its shell env and the worktree line in
the task it received. Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

LINE = "You run in your own worktree (your cwd)."


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildWorktreeBinding(ReplayCase):
    def test_worktree_builder_gets_the_env_and_the_brief_line(self):
        rig = self.rig("worktreefence", load_fixture("child_worktree_fence"))
        # an isolation worktree needs a base commit
        (rig.project / "a.txt").write_text("a\n", "utf-8")
        for args in ((["add", "-f", "a.txt"]), (["commit", "-q", "-m", "init"])):
            subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=str(rig.project), check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:s1]] go", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("child: fence finished", notice)
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        # printenv exits 1 when FOREMAN_CHECKOUT is unset; the result carries the foreman's checkout
        self.assertRegex(text, r'"toolName":"bash","isError":false,"text":"[^"]*(?:/|\\\\)project\\n"')
        self.assertIn(LINE, text)


if __name__ == "__main__":
    unittest.main()
