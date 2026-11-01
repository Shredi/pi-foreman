"""Replay: a worktree child cannot write into the foreman's checkout (ceremony-fixes-2 item 1).

A builder launched with `worktree: true` whose brief names the foreman's checkout tries `cd <root>; git add; git commit`,
`git -C <root> commit`, `echo x > <root>/f` and an `edit` of `<root>/src/a.ts`: every one is denied by the gate (no dialog,
nothing changes in the checkout). Reading `<root>/.workflow/LEDGER-x.md` and writing inside its own worktree work.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

DENIED = "the foreman's checkout"


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=str(cwd), check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode()


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestChildWorktreeFence(ReplayCase):
    def test_worktree_builder_cannot_write_the_foreman_checkout(self):
        rig = self.rig("worktreefence", load_fixture("child_worktree_fence"))
        root = str(rig.project)
        # the manifest has no worktree entries: only the launch binding says this child is a worktree launch
        script = rig.script.read_text("utf-8").replace("@ROOT@", json.dumps(root)[1:-1])
        rig.script.write_text(script, "utf-8")
        (rig.project / "src").mkdir()
        (rig.project / "src" / "a.ts").write_text("alpha\n", "utf-8")
        (rig.project / ".workflow").mkdir()
        (rig.project / ".workflow" / "LEDGER-x.md").write_text("LEDGER-MARK\n", "utf-8")
        git(rig.project, "add", "-f", "src/a.ts", ".workflow/LEDGER-x.md")
        git(rig.project, "commit", "-q", "-m", "init")
        head = git(rig.project, "rev-parse", "HEAD")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:s1]] go", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("child: fence finished", notice)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(dialogs, [], dialogs)
        self.assertFalse((rig.project / "f").exists(), "the builder wrote into the foreman's checkout")
        self.assertEqual((rig.project / "src" / "a.ts").read_text("utf-8"), "alpha\n")
        self.assertEqual(git(rig.project, "rev-parse", "HEAD"), head)
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertGreaterEqual(text.count(DENIED), 4, text[-3000:])
        self.assertIn("LEDGER-MARK", text)
        self.assertIn("own-ok", text)


if __name__ == "__main__":
    unittest.main()
