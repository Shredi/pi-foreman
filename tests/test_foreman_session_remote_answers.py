"""PR 3 of the intercom round: the registry `ask` of a remote child is answered by a brief (or a `ruling-<n>.md` from a parent on the old
footer), never by a plan ruling or a steer; the remote footer says the answer comes as a brief."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_session_remote import PARENT, RemoteBase, fsn


class RemoteAskAnswerTest(RemoteBase):
    def setUp(self):
        super().setUp()
        self.entry, self.rh = self.opened()

    def set_ask(self, ask):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        data = json.loads(reg.read_text("utf-8"))
        for s in data["sessions"]:
            if s["child"] == self.entry["child"]:
                s["ask"] = ask
        reg.write_text(json.dumps(data), "utf-8")

    def deliver(self, name):
        f = self.tmp / name
        f.write_text("x", "utf-8")
        self.assertEqual(self.run_main("brief", "demo", str(f), "--parent-id", PARENT)[0], 0, name)
        return self.parent_registry()[0]

    def test_a_brief_clears_the_ask_whatever_its_number(self):
        for ask in ({"seq": 5, "n": 2}, {"seq": 5}):
            for name in ("brief-1.md", "brief-9.md"):
                self.set_ask(ask)
                entry = self.deliver(name)
                self.assertIsNone(entry.get("ask"), (ask, name))

    def test_a_text_brief_clears_the_ask(self):
        self.set_ask({"seq": 5, "n": 2})
        self.assertEqual(self.run_main("brief", "demo", "go with option B", "--parent-id", PARENT)[0], 0)
        self.assertIsNone(self.parent_registry()[0].get("ask"))

    def test_a_ruling_with_the_asks_number_still_clears_it(self):
        self.set_ask({"seq": 5, "n": 2})
        self.assertIsNone(self.deliver("ruling-2.md").get("ask"))

    def test_a_plan_ruling_or_a_steer_never_clears_it(self):
        for ask in ({"seq": 5, "n": 2}, {"seq": 5}):
            for name in ("ruling.md", "ruling-plan.md", "steer-1.md"):
                self.set_ask(ask)
                self.assertEqual(self.deliver(name).get("ask"), ask, (ask, name))

    def test_answers_count_briefs_and_numbered_rulings_only(self):
        counts = []
        for name in ("steer-1.md", "ruling.md", "ruling-plan.md", "brief-4.md", "ruling-2.md"):
            counts.append(self.deliver(name).get("answers"))
        self.assertEqual(counts, [None, None, None, 1, 2])


class RemoteFooterAnswerTest(unittest.TestCase):
    def test_the_remote_footer_answers_by_brief_and_waits_on_no_ruling_file(self):
        for plan_first in (False, True):
            text = fsn.remote_footer("demo", plan_first)
            self.assertIn("answer comes as a brief", text)
            self.assertNotIn("ruling-<n>.md", text)
            self.assertNotIn(".seen", text)
            self.assertIn("dialog", text)
            self.assertIn("`# Ask <n>: <topic>`".replace("`", ""), text.replace("`", ""))

    def test_the_remote_plan_first_notes_end_the_turn_after_an_ask_file(self):
        notes = "\n".join(fsn.plan_first_notes(False))
        self.assertIn("the answer comes as a brief", notes)
        self.assertNotIn("ruling-<n>.md", notes)

    def test_the_local_footer_ask_by_file_answers_by_brief_too(self):
        text = fsn.footer("demo", False)
        self.assertIn("The answer comes as a brief", text)
        self.assertNotIn("ruling-<n>.md", text)
        self.assertNotIn(".seen", text)
        self.assertNotIn(".ask`", text)


if __name__ == "__main__":
    unittest.main()
