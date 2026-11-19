import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_config import render_prompt

ROOT = Path(__file__).resolve().parent.parent
CLAUSE = "then send the child the intercom message `foreman:close`"


class CloseMessageClauseTest(unittest.TestCase):
    def test_multi_session_rendering_says_foreman_close_is_a_message(self):
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        on = render_prompt(text, {"multiSession": "on"})
        self.assertIn(CLAUSE, on)
        self.assertNotIn("; then `foreman:close`.", on)

    def test_single_session_rendering_has_no_clause(self):
        text = (ROOT / "instructions" / "foreman.md").read_text(encoding="utf-8")
        self.assertNotIn(CLAUSE, render_prompt(text, {"multiSession": "off"}))


if __name__ == "__main__":
    unittest.main()
