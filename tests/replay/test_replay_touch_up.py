"""Replay: a comment-only touch-up after a PASS (retro-harvest item 6).

The builder adds a field to hub.go and the reviewer passes it; the harness records the working tree.
A second builder run then only rewords a comment: the revision is withdrawn (trace
`revision_comment_only`), no revision round is used and the finish goes through without a re-review.
The same touch-up plus a one-token code change re-opens the reviewer step as before.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402
from test_replay_ceremony_gate import events, gate_messages  # noqa: E402

HUB = "package hub\n\n// Hub fans messages out.\ntype Hub struct{}\n"


def git(project, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(project), check=True, stdout=subprocess.DEVNULL)


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestTouchUp(ReplayCase):
    def run_flow(self, tag):
        rig = self.rig("tu-" + tag, load_fixture("touch_up"))
        (rig.project / "hub.go").write_text(HUB, "utf-8")
        git(rig.project, "add", "hub.go")
        git(rig.project, "commit", "-q", "-m", "init")
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:%s1]] build it" % tag, timeout=60)
        for _ in range(3):
            recs += pi.wait_child_notify(timeout=180)[1]
        pi.close()
        return rig, sid, recs

    def test_comment_only_touch_up_needs_no_rereview(self):
        rig, sid, recs = self.run_flow("c")
        self.assertIn("// It counts them in n.", (rig.project / "hub.go").read_text("utf-8"))
        self.assertEqual([r["files"] for r in events(rig, sid, "revision_comment_only")], [1])
        self.assertEqual(gate_messages(recs), [])
        self.assertEqual(events(rig, sid, "finish_refused"), [])
        self.assertEqual(events(rig, sid, "revision"), [])

    def test_comment_plus_code_change_reopens_the_review(self):
        rig, sid, recs = self.run_flow("d")
        self.assertIn("{ n int64 }", (rig.project / "hub.go").read_text("utf-8"))
        self.assertEqual(events(rig, sid, "revision_comment_only"), [])
        msgs = gate_messages(recs)
        self.assertTrue(msgs, "the finish after a code change needs a re-review")
        self.assertIn("re-review needed: revised after the last PASS", msgs[0])


if __name__ == "__main__":
    unittest.main()
