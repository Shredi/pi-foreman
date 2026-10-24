import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_config import render_prompt  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
BASE = "fe71c9b"  # origin/main: foreman.md as before the sizing fold


class SizingPromptTest(unittest.TestCase):
    def knobs(self, **over):
        k = {"ledgerhelper": "tool", "heavythreshold": "strict", "reviewperrevision": "on", "trivialpath": "builder",
             "ladder": "on", "factrulings": "on", "launchbriefs": "on", "reviewmarks": "on", "research": "on",
             "planreview": "on", "tools.pr": "on", "sizing": "on"}
        k.update(over)
        return k

    def test_sizing_on_fits_and_is_neutral(self):
        text = (ROOT / "instructions" / "foreman.md").read_text()
        for mode in ("tool", "bash", "off"):
            for heavy in ("strict", "eee843d"):
                for review in ("on", "off"):
                    for trivial in ("builder", "off"):
                        kept = render_prompt(text.lower(), self.knobs(ledgerhelper=mode, heavythreshold=heavy,
                                                                      reviewperrevision=review, trivialpath=trivial))
                        self.assertLessEqual(len(kept.splitlines()), 70, (mode, heavy, review, trivial))
        self.assertIn("size: {files", render_prompt(text, self.knobs()))
        for word in ("claude", "sonnet", "opus", "fable", "gpt", "gemini", "copilot", "openrouter"):
            self.assertNotIn(word, text.lower())

    def test_sizing_off_bytes_unchanged(self):
        old = subprocess.run(["git", "show", BASE + ":instructions/foreman.md"], cwd=str(ROOT), capture_output=True)
        if old.returncode != 0:
            self.skipTest("base commit not available")
        text = (ROOT / "instructions" / "foreman.md").read_text()
        for brief in ("off",):  # the merged launch-brief lines only render with launchBriefs on
            k = self.knobs(sizing="off", launchbriefs=brief)
            self.assertEqual(render_prompt(text, k), render_prompt(old.stdout.decode("utf-8"), k))
        self.assertNotIn("size: {files", render_prompt(text, self.knobs(sizing="off")))


if __name__ == "__main__":
    unittest.main()
