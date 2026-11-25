"""A child's ask goes to its parent (PR C): the child's `git branch -D old-topic` is on the judge-first list (`danger-git`), the judge (a fake
model, `review-<kind>`) answers `owner` with a class (docs/permissions.md "Who decides": only that asks), the child's gate writes ask.md in the
parent-owned ask dir, the parent's pane shows one dialog naming the child, and the answer decides the child's call. A clear runs the call;
an unsure or invalid judge refuses the call with a reason and asks nobody.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture
from test_replay import REASON, ReplayCase

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
        rig = self.rig("child-ask-" + kind, load_fixture("child_ask"), config=config)
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
        seen, dialogs, notice, _ = self.run_child("owner", ALLOW)
        self.assertEqual(len(seen), 1, "one dialog for the child's ask")
        self.assertIn("builder", seen[0]["title"])
        self.assertIn("git branch -D old-topic", seen[0]["title"])
        self.assertIn("cause: danger-git", seen[0]["title"])
        self.assertIn("parent-allow", [d.get("decision") for d in dialogs])
        self.assertIn("builder child finished", notice)

    def test_deny_from_the_parent_blocks_the_call(self):
        seen, dialogs, notice, _ = self.run_child("owner", {"value": "deny with reason"})
        self.assertEqual(len(seen), 1)
        self.assertIn("parent-deny", [d.get("decision") for d in dialogs])

    def test_dismissed_dialog_denies(self):
        seen, dialogs, _, _ = self.run_child("owner", {"cancelled": True})
        self.assertEqual(len(seen), 1)
        self.assertIn("parent-deny", [d.get("decision") for d in dialogs])

    def assert_refused_without_dialog(self, kind):
        seen, dialogs, _, events = self.run_child(kind, {"value": "deny with reason"})
        self.assertEqual(seen, [], "an unsure or unusable judge asks nobody")
        self.assertEqual([d.get("decision") for d in dialogs], [])
        gate = [(r.get("decision"), r.get("rule")) for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("role") == "builder"]
        self.assertEqual(gate, [("blocked", "judge:danger-git")], gate)

    def test_unsure_verdict_refuses_without_a_parent_dialog(self):
        # plan D1 / Who decides: an unsure judge gives the child a refusal with the reason; nobody is asked
        self.assert_refused_without_dialog("ask")

    def test_invalid_verdict_refuses_without_a_parent_dialog(self):
        # plan D1 / Who decides: an unusable judge reply (a verdict outside the closed set) is no clear and no owner: a refusal, nobody is asked
        self.assert_refused_without_dialog("invalid")

    def test_clear_runs_without_a_parent_dialog(self):
        seen, dialogs, notice, _ = self.run_child("allow", {"value": "deny with reason"})
        self.assertEqual(seen, [])
        self.assertEqual([d.get("decision") for d in dialogs], [])
        self.assertIn("builder child finished", notice)

    def test_child_ask_deny_keeps_the_old_deny_without_a_parent_dialog(self):
        seen, dialogs, _, events = self.run_child("owner", ALLOW, gate={"childAsk": "deny"})
        self.assertEqual(seen, [])
        self.assertEqual([d.get("decision") for d in dialogs], ["no-parent"])
        gate = [(r.get("decision"), r.get("rule")) for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("role") == "builder"]
        self.assertEqual(gate, [("blocked", "danger-git")], gate)


if __name__ == "__main__":
    unittest.main()
