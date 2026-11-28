"""A local open without herdr: the printed fallback and launch.txt carry the model once, never the command line."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session as base  # noqa: E402


class LaunchModelTest(base.SessionTest):
    def test_no_model_prints_no_model_option(self):
        code, out, err = self.run_main(*self.open_args("--print-all"), HERDR_PANE_ID="")
        self.assertEqual(code, 0, err)
        self.assertNotIn("--model", out)
        entry = self.registry()[0]
        self.assertNotIn("--model", (Path(entry["handoff"]) / "launch.txt").read_text("utf-8"))

    def test_model_shows_once(self):
        code, out, err = self.run_main(*self.open_args("--print-all", "--model", "prov/model-1"), HERDR_PANE_ID="")
        self.assertEqual(code, 0, err)
        posix = out.splitlines()[out.splitlines().index("POSIX shell:") + 1]
        self.assertEqual(posix.count("--model"), 1, posix)
        self.assertIn("--model prov/model-1", posix)


for _n in [n for n in dir(base.SessionTest) if n.startswith("test_") and n not in LaunchModelTest.__dict__]:
    setattr(LaunchModelTest, _n, None)  # the inherited tests run in test_foreman_session.py


if __name__ == "__main__":
    unittest.main()
