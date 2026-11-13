"""A planning session asks the owner only for real decisions: the instruction, reviewer and brief-footer texts."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from test_foreman_config import render_prompt  # noqa: E402
import test_foreman_session as base  # noqa: E402

fsn = base.fsn
ROOT = Path(__file__).resolve().parent.parent
KNOBS = {"ledgerhelper": "tool", "heavythreshold": "strict", "reviewperrevision": "on", "trivialpath": "builder",
         "ladder": "on", "factrulings": "on", "launchbriefs": "on", "reviewmarks": "on", "research": "on",
         "planreview": "on", "tools.pr": "on", "sizing": "on", "show": "on", "multisession": "on"}
DECISION = "write `DECISION:` after the verdict word of its item line (`3. FAIL: DECISION: ...`)"


class ForemanTextTest(unittest.TestCase):
    def rendered(self, **over):
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        return render_prompt(text, {**KNOBS, **over})

    def test_plan_review_line_revises_until_pass(self):
        out = self.rendered()
        self.assertIn("After a FAIL (`plan_revision_required`) revise the plan and have it reviewed again, as often as needed and without asking, while the findings are defects or gaps.", out)
        self.assertIn("marked it `DECISION:`", out)
        self.assertIn("Go to the checkpoint with a FAIL only for such findings.", out)
        self.assertNotIn("revise the plan once", out)

    def test_fifth_failed_review_is_reported_in_one_line(self):
        out = self.rendered()
        self.assertIn("After every fifth failed review of the same plan in a row, say so in one line with the count (to the parent by a normal update when you have one, otherwise in your chat reply) and go on.", out)

    def test_plan_phase_asks_the_parent_first(self):
        out = self.rendered()
        self.assertIn("real decisions only: in a session a parent opened ask the parent first, by file (`ask.md`), and the owner with `ask_user_question` when the decision is the owner's.", out)
        self.assertIn("At a `[review_loop]` stop in such a session, report the open findings to the parent by file instead and wait for its ruling.", out)

    def test_no_rendering_gains_a_line(self):
        # pinned line counts of the current instructions/foreman.md per (planreview, multisession, ledgerhelper)
        pinned = {
            ("on", "on", "tool"): 68, ("on", "on", "bash"): 73, ("on", "on", "off"): 73,
            ("on", "off", "tool"): 65, ("on", "off", "bash"): 70, ("on", "off", "off"): 70,
            ("off", "on", "tool"): 67, ("off", "on", "bash"): 72, ("off", "on", "off"): 72,
            ("off", "off", "tool"): 64, ("off", "off", "bash"): 69, ("off", "off", "off"): 69,
        }
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        for (plan_review, multi, mode), lines in pinned.items():
            knobs = {**KNOBS, "planreview": plan_review, "multisession": multi, "ledgerhelper": mode}
            self.assertEqual(len(render_prompt(text, knobs).splitlines()), lines, (plan_review, multi, mode))


class ReviewerTextTest(unittest.TestCase):
    def test_reviewer_marks_decision_findings_after_the_verdict_word(self):
        for rel in ("agents/reviewer.md", "instructions/reviewer.md"):
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertIn(DECISION, text, rel)
            self.assertIn("every other finding is a defect the foreman fixes", text, rel)
        self.assertLessEqual(len((ROOT / "agents" / "reviewer.md").read_text(encoding="utf-8").splitlines()), 30)


class FooterTextTest(unittest.TestCase):
    def check(self, text):
        self.assertIn("Findings of your plan review that are defects or gaps are not questions: revise and have the plan reviewed again until it passes.", text)
        self.assertIn("goes to the owner with `ask_user_question`", text)
        self.assertIn("everything else you cannot settle goes to the parent by file (`ask.md`)", text)
        self.assertIn("When unsure whether it is a decision, ask the parent.", text)
        self.assertNotIn("Ask the parent questions with", text)

    def test_local_footer(self):
        self.check(fsn.footer("demo", True))
        self.assertNotIn("Findings of your plan review", fsn.footer("demo", False))

    def test_remote_footer(self):
        self.check(fsn.remote_footer("demo", True))


if __name__ == "__main__":
    unittest.main()
