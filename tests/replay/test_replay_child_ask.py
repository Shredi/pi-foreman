"""A child's policy ask goes to its parent (plan Addendum 5): the child's `pip install requests` is the dangerous class `danger-install`, the
classifier (a fake model against the rig's one-sentence whitelist) escalates, the child's gate writes ask.md in the
parent-owned ask dir, the parent's pane shows one dialog naming the child, and the answer decides the child's call.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

ALLOW = {"value": "allow once"}


def is_child_ask(rec):
    return rec.get("method") == "select" and "asks\n" in str(rec.get("title", ""))


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildAsk(ReplayCase):
    def run_child(self, kind, answer_child, gate=None):
        review = {"model": "%s/review-%s" % (PROVIDER_A, kind)}
        config = {"providers": {PROVIDER_A: {"review": review}}}
        if gate:
            config["gate"] = gate
        rig = self.rig("child-ask-" + kind, load_fixture("child_ask"), permissions="baseline", config=config)
        self.user_permissions(rig, {"classifier": {"allow": ["Installing a package from the registry is allowed."]}})
        pi = rig.start()
        pi.prompt("[[replay:f1]] go", timeout=60, answers=[ALLOW])
        seen = []

        def answer(rec):
            # the owner's role launch is a default and opens no dialog; answer the child's ask as the case says (anything else is allowed)
            if is_child_ask(rec):
                seen.append(rec)
                return answer_child
            return ALLOW

        notice, recs = pi.wait_child_notify(timeout=120, answers=[answer] * 6)
        pi.close()
        events = [r for recs_ in rig.traces().values() for r in recs_]
        dialogs = [r for r in events if r.get("event") == "dialog" and r.get("guard") == "gate"]
        return seen, dialogs, notice, events

    def test_allow_from_the_parent_lets_the_call_run(self):
        seen, dialogs, notice, _ = self.run_child("ask", ALLOW)
        self.assertEqual(len(seen), 1, "one dialog for the child's ask")
        self.assertIn("builder", seen[0]["title"])
        self.assertIn("pip install requests", seen[0]["title"])
        self.assertIn("cause: danger-install", seen[0]["title"])
        self.assertIn("parent-allow", [d.get("decision") for d in dialogs])
        self.assertIn("builder child finished", notice)

    def test_deny_from_the_parent_blocks_the_call(self):
        seen, dialogs, notice, _ = self.run_child("ask", {"value": "deny with reason"})
        self.assertEqual(len(seen), 1)
        self.assertIn("parent-deny", [d.get("decision") for d in dialogs])

    def test_dismissed_dialog_denies(self):
        seen, dialogs, _, _ = self.run_child("ask", {"cancelled": True})
        self.assertEqual(len(seen), 1)
        self.assertIn("parent-deny", [d.get("decision") for d in dialogs])

    def test_invalid_verdict_escalates_to_the_parent(self):
        # r79: an unusable classifier reply (a verdict citing no whitelist entry) escalates, so the child's ask reaches the parent like any other
        seen, dialogs, _, events = self.run_child("invalid", {"value": "deny with reason"})
        self.assertEqual(len(seen), 1, "an unusable classifier reply is an ask to the parent")
        self.assertIn("parent-deny", [d.get("decision") for d in dialogs])
        self.assertNotIn("parent-allow", [d.get("decision") for d in dialogs])

    def test_child_ask_deny_keeps_the_old_deny_without_a_parent_dialog(self):
        seen, dialogs, _, _ = self.run_child("ask", ALLOW, gate={"childAsk": "deny"})
        self.assertEqual(seen, [])
        self.assertNotIn("parent-allow", [d.get("decision") for d in dialogs])


if __name__ == "__main__":
    unittest.main()
