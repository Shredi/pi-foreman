"""`foreman session open --plan-first` starts the child in the native plan phase (R46 item 7)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn


class PlanPhaseEnvTest(unittest.TestCase):
    # reuse the fixture of the session tests without inheriting (and rerunning) their cases
    setUp = base.SessionTest.setUp
    run_main = base.SessionTest.run_main
    registry = base.SessionTest.registry
    open_args = base.SessionTest.open_args

    def launch_line(self, *extra):
        code, out, err = self.run_main(*self.open_args("--dry-run", "--print-all", *extra), HERDR_PANE_ID="")
        self.assertEqual(code, 0, err)
        return out

    def test_child_env_carries_the_plan_phase_only_when_asked(self):
        on = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {}, plan_phase=True)
        self.assertIn(("PI_FOREMAN_PLAN_PHASE", "1"), on)
        off = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {})
        self.assertNotIn("PI_FOREMAN_PLAN_PHASE", [k for k, _ in off])

    def test_plan_first_open_sets_the_env_in_the_launch_line(self):
        self.assertIn("PI_FOREMAN_PLAN_PHASE=1", self.launch_line("--plan-first"))
        self.assertNotIn("PI_FOREMAN_PLAN_PHASE", self.launch_line())

    def test_plan_first_footer_asks_for_questions_and_the_template(self):
        text = fsn.footer("demo", True)
        self.assertIn("ask_user_question", text)
        self.assertIn("## Decisions and assumptions", text)
        self.assertIn("## Open questions", text)
        self.assertNotIn("ask_user_question", fsn.footer("demo", False))


if __name__ == "__main__":
    unittest.main()
