"""PR 4 (the child owns its plan): the plan-first item of both footers. No wait on `ruling.md` and no approval by the parent;
heavy = the plan review's PASS, then the owner's checkpoint dialog in the child's own pane; below heavy = the PASS ends the plan
phase. A local child sends the plain checkpoint line first, a remote child sends nothing. A brief that changes the plan makes a
new plan version."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn


def flat(text):
    return " ".join(text.split())


COMMON = (
    "you own your plan; the parent does not approve it",
    "Record your tier with `foreman_triage`",
    "have the plan reviewed (`[plan-review]`) until it passes",
    "Below tier heavy: the plan review's PASS on the current plan version ends the plan phase",
    "call `foreman_checkpoint`; the owner answers in a dialog in this pane",
    "A brief that changes the plan makes a new plan version: have it reviewed again and, at heavy, take it to the checkpoint again.",
    "it approves nothing",
    "builders wait until the plan phase ends",
)
GONE = ("APPROVED", "wait for the parent's ruling", "kind `file` on `ruling.md`", "builders wait for the approval", "a copy of the ruling")


class LocalFooterTest(unittest.TestCase):
    def test_plan_first_item(self):
        text = flat(fsn.footer("demo", True))
        for want in COMMON:
            self.assertIn(want, text)
        self.assertIn("send `Plan from demo: <absolute path of plan.md>`; it informs the parent, so do not wait for an answer to it.", text)
        for gone in GONE:
            self.assertNotIn(gone, text)

    def test_html_plan_clause(self):
        text = flat(fsn.footer("demo", True))
        self.assertIn("an HTML plan stays in your scratch dir: copy its generated `plan-<topic>.md` there", text)

    def test_the_plain_checkpoint_line_comes_before_the_checkpoint(self):
        text = flat(fsn.footer("demo", True))
        line = "send the parent the plain line `demo waits on the owner at its plan checkpoint`, then call `foreman_checkpoint`"
        self.assertIn(line, text)
        self.assertIn("not as an `Update from` message, which is a report", text)
        self.assertLess(text.index("waits on the owner at its plan checkpoint"), text.index("call `foreman_checkpoint`"))

    def test_without_plan_first_no_plan_item(self):
        text = flat(fsn.footer("demo", False))
        for gone in ("waits on the owner at its plan checkpoint", "foreman_checkpoint", "foreman_triage"):
            self.assertNotIn(gone, text)


class RemoteFooterTest(unittest.TestCase):
    def test_plan_first_item(self):
        text = flat(fsn.remote_footer("demo", True))
        for want in COMMON:
            self.assertIn(want, text)
        self.assertIn("It informs the parent, so do not wait for an answer to it.", text)
        self.assertIn("attaching to it from the other machine", text)
        for gone in GONE:
            self.assertNotIn(gone, text)

    def test_html_plan_clause(self):
        text = flat(fsn.remote_footer("demo", True))
        self.assertIn("an HTML plan stays in your scratch dir: copy its generated `plan-<topic>.md` there", text)

    def test_a_remote_child_sends_nothing_before_the_checkpoint(self):
        text = flat(fsn.remote_footer("demo", True))
        self.assertNotIn("waits on the owner at its plan checkpoint", text)
        self.assertIn("Run no notice before it: the parent learns from its own check that you wait on the owner.", text)
        notices = [l.strip() for l in fsn.remote_footer("demo", True).splitlines() if " remote notice " in l]
        self.assertEqual([n.rsplit(" ", 1)[1] for n in notices], ["plan", "result", "update", "ask"])


if __name__ == "__main__":
    unittest.main()
