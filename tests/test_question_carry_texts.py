"""PR 2 of the intercom round: the wording of the question-by-message contract in the local footer, the plan-first notes, the foreman rules and the settings
texts; the remote footer keeps the ask-by-file wording it had."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_session as fsn  # noqa: E402


class LocalFooterTest(unittest.TestCase):
    def test_local_footer_asks_by_plain_send_and_ends_the_turn(self):
        for plan_first in (True, False):
            text = fsn.footer("demo", plan_first)
            for want in (
                "Question to the parent: send it with the intercom tool (`send`)",
                "starts with\n`Question`",
                "Then end your\nturn: the answer arrives as a message and starts your next turn.",
                "Do not use the blocking `ask` action and do not\n`foreman_wait` for the answer.",
                "is lifted by a brief from the parent,\nnever by a message.",
                "Ask by file: use this only when the parent is not a Pi session",
            ):
                self.assertIn(want, text)

    def test_local_plan_first_notes_send_the_question_in_a_message(self):
        text = fsn.footer("demo", True)
        self.assertIn("goes to the parent in a message whose first line starts with `Question`", text)
        self.assertIn("(no human at the pane), ask the parent in a message.", text)
        self.assertNotIn("goes to the parent by file (`ask.md`)", text)


class RemoteFooterTest(unittest.TestCase):
    def test_remote_footer_keeps_the_ask_by_file_wording(self):
        text = fsn.remote_footer("demo", True)
        self.assertIn("everything else you cannot settle goes to the parent by file (`ask.md`). When unsure", text)
        self.assertIn("(no human at the pane), ask by file (`ask.md`).", text)
        self.assertNotIn("starts with `Question`", text)
        self.assertNotIn("Question to the parent", fsn.remote_footer("demo", False))


class RulesAndSettingsTest(unittest.TestCase):
    def test_foreman_rules_name_the_question_contract(self):
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        self.assertIn("A child's question reaches you as an intercom message whose first line starts with `Question`", text)
        self.assertIn("A message lifts no stop: a child's `[review_loop]` stop or spent read budget is lifted by a brief.", text)
        self.assertIn("then end your turn: the answer arrives as a message and starts your next turn; no blocking ask, no `foreman_wait`", text)
        self.assertIn("the parent lifts the stop with a brief, a message does not", text)

    def test_notice_setting_texts_cover_the_unanswered_question(self):
        schema = json.loads((ROOT / "config" / "foreman.schema.json").read_text(encoding="utf-8"))
        desc = schema["properties"]["sessions"]["properties"]["blockedNoticeSeconds"]["description"]
        self.assertIn("has waited for this session's answer to its question (a message whose first line starts with Question)", desc)
        self.assertIn("0 turns both off", desc)
        features = (ROOT / "config" / "features.json").read_text(encoding="utf-8")
        self.assertIn("parent gets one reminder after `sessions.blockedNoticeSeconds` when it has not answered", features)


if __name__ == "__main__":
    unittest.main()
