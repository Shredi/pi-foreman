"""The plan-first footers tell the child to go on after its `Plan from`, never idle for the parent."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import foreman_session as fsn  # noqa: E402


def flat(text):
    return " ".join(text.split())


class PlanNoIdleTest(unittest.TestCase):
    def test_local_footer(self):
        text = flat(fsn.footer("demo", True))
        self.assertIn("it informs the parent, so do not wait for an answer to it.", text)
        self.assertIn("The review is done: next, below heavy go on and build; at heavy take the heavy step below (the waits-on line, then the checkpoint). Never idle waiting for the parent.", text)
        self.assertNotIn("go on with your plan review", text)

    def test_remote_footer(self):
        text = flat(fsn.remote_footer("demo", True))
        self.assertIn("The review is done: next, below heavy go on and build; at heavy call `foreman_checkpoint`. Never idle waiting for the parent.", text)
        self.assertNotIn("go on with your plan review", text)

    def test_no_sentence_without_plan_first(self):
        self.assertNotIn("Never idle waiting for the parent", flat(fsn.footer("demo", False)))
        self.assertNotIn("Never idle waiting for the parent", flat(fsn.remote_footer("demo", False)))


if __name__ == "__main__":
    unittest.main()
