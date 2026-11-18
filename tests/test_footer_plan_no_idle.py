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
        self.assertIn("Right after sending it go on with your plan review (below heavy: then build; heavy: then the waits-on line and the checkpoint), never idle for the parent.", text)

    def test_remote_footer(self):
        text = flat(fsn.remote_footer("demo", True))
        self.assertIn("Right after running it go on with your plan review (below heavy: then build; heavy: then the checkpoint), never idle for the parent.", text)

    def test_no_sentence_without_plan_first(self):
        self.assertNotIn("never idle for the parent", flat(fsn.footer("demo", False)))
        self.assertNotIn("never idle for the parent", flat(fsn.remote_footer("demo", False)))


if __name__ == "__main__":
    unittest.main()
