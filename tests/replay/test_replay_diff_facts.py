"""Replay: diff facts in the reviewer's launch task (frugal-roles D5, go-d shape).

The builder changes `broadcast(msg)` to `broadcast(seq, msg)` (a lowercase Go method called from the
package's test file) and loosens `require.Equal(t, 200, received)` to `require.Greater(t, received, 0)`.
The reviewer's task then carries a "Facts to rule on" block naming the signature change, the modified
test file and the removed assertion; the reviewer's FAIL routes to a re-review per the review gate.
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
from test_replay_ceremony_gate import events  # noqa: E402

HUB = "package hub\n\ntype Hub struct{}\n\nfunc (h *Hub) broadcast(msg []byte) {\n}\n"
HUB_TEST = "package hub\n\nfunc TestBroadcast(t *testing.T) {\n\th := &Hub{}\n\th.broadcast(nil)\n\trequire.Equal(t, 200, received)\n}\n"


def git(project, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"] + list(args), cwd=str(project), check=True, stdout=subprocess.DEVNULL)


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestDiffFacts(ReplayCase):
    def test_facts_reach_the_reviewer_and_a_fail_routes_to_a_rereview(self):
        rig = self.rig("diff-facts", load_fixture("diff_facts"))
        (rig.project / "hub.go").write_text(HUB, "utf-8")
        (rig.project / "hub_test.go").write_text(HUB_TEST, "utf-8")
        git(rig.project, "add", "hub.go", "hub_test.go")
        git(rig.project, "commit", "-q", "-m", "init")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:d1]] build it", timeout=60)
        for _ in range(3):
            pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertIn("broadcast(seq uint64, msg []byte)", (rig.project / "hub.go").read_text("utf-8"))
        transcripts = [p.read_text("utf-8", "replace") for p in rig.agent.rglob("*_reviewer_transcript.jsonl")]
        facts = [t for t in transcripts if "Facts to rule on" in t]
        self.assertTrue(facts, "no reviewer task carried the facts block")
        text = facts[0]
        self.assertIn("not exported, but referenced by test file hub_test.go", text)
        self.assertIn("broadcast", text)
        self.assertIn("test file modified: hub_test.go", text)
        self.assertIn("assertion removed or changed in hub_test.go", text)
        self.assertIn("require.Greater", text)
        self.assertEqual([(r["role"], r["after"]) for r in events(rig, sid, "rereview")], [("reviewer", "fail")])
        self.assertEqual([r["count"] for r in events(rig, sid, "review_facts")], [1, 1])


if __name__ == "__main__":
    unittest.main()
