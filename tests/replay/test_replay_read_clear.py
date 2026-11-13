"""The read question (docs/permissions.md#the-read-question): a shell line the gate cannot read (a glob in an operand) that the classifier
escalates goes once more to the read judge. A fake model answers the exact read verdict (the call runs, no dialog, a read-clear row in the
gate trace) or a vague sentence (the call reaches the owner's dialog as today). Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def is_dialog(rec):
    return rec.get("type") == "extension_ui_request" and rec.get("method") in ("select", "confirm")


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestReadClear(ReplayCase):
    def run_line(self, kind, answers):
        config = {"providers": {PROVIDER_A: {"review": {"model": "%s/review-%s" % (PROVIDER_A, kind)}}}}
        rig = self.rig("read-clear-" + kind, load_fixture("read_clear"), permissions="baseline", config=config)
        self.user_permissions(rig, {"classifier": {"allow": ["Installing a package from the registry is allowed."]}})
        pi = rig.start()
        recs = pi.prompt("[[replay:d1]] go", timeout=60, answers=answers)
        pi.close()
        events = [r for recs_ in rig.traces().values() for r in recs_]
        return recs, events

    def test_a_cleared_line_runs_without_a_dialog(self):
        recs, events = self.run_line("read", [{"value": "deny"}])
        [(_, err, text)] = tool_results(recs, "bash")
        self.assertFalse(err, text)
        self.assertEqual([r for r in recs if is_dialog(r)], [], "no dialog for a cleared line")
        reviews = [e for e in events if e.get("event") == "review" and e.get("entry") == "read-clear"]
        self.assertEqual(len(reviews), 1, reviews)
        self.assertEqual(reviews[0].get("decision"), "allow")

    def test_a_vague_answer_reaches_the_human(self):
        recs, events = self.run_line("readvague", [{"value": "deny"}])
        self.assertEqual(len([r for r in recs if is_dialog(r)]), 1, "the owner is asked as today")
        [(_, err, _)] = tool_results(recs, "bash")
        self.assertTrue(err)
        self.assertEqual([e for e in events if e.get("event") == "review" and e.get("entry") == "read-clear" and e.get("decision") == "allow"], [])


if __name__ == "__main__":
    unittest.main()
