"""Round 67: `sidebar.py check`, the read-only PR colour-rule check of the Herdr config.

Exit 0 when the $fm_pr rules match the set's glyphs, 1 when stale or a token is missing, 2 when unreadable."""
import argparse
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _isolation  # noqa: E402,F401  (scrub leaked session env)
import sidebar  # noqa: E402

SNIPPET = (PLUGIN / "config-snippet.toml").read_text(encoding="utf-8")
# the round-53 emoji dots in place of the unicode circles
EMOJI_DOTS = {"\u25cf": "\U0001F534", "\u25c9": "\U0001F7E1", "\u25cb": "\U0001F7E2"}


class PrRuleCheckTest(unittest.TestCase):
    def test_current_snippet_passes_for_its_set(self):
        code, line = sidebar.pr_rule_check(SNIPPET, "unicode")
        self.assertEqual(code, 0, line)
        self.assertTrue(line.startswith("ok"), line)

    def test_round_53_emoji_rules_are_stale_and_named(self):
        old = SNIPPET
        for glyph, dot in EMOJI_DOTS.items():
            old = old.replace(glyph, dot)
        code, line = sidebar.pr_rule_check(old, "unicode")
        self.assertEqual(code, 1, line)
        self.assertTrue(line.startswith("stale: set unicode expects \u25cf \u25c9 \u25cb"), line)
        self.assertIn("config has \U0001F534 \U0001F7E1 \U0001F7E2", line)
        self.assertIn("rerun configure and merge", line)

    def test_missing_token_is_stale_and_named(self):
        text = SNIPPET.replace("$fm_pr2", "$fm_other")
        code, line = sidebar.pr_rule_check(text, "unicode")
        self.assertEqual(code, 1, line)
        self.assertIn("missing $fm_pr2", line)

    def test_ascii_expects_no_rules(self):
        code, line = sidebar.pr_rule_check(SNIPPET, "ascii")
        self.assertEqual(code, 1, line)
        self.assertIn("expects no rules", line)

    def test_no_pi_rows_is_unreadable(self):
        code, line = sidebar.pr_rule_check("[ui.sidebar.agents.rows_by_agent]\nother = []\n", "unicode")
        self.assertEqual(code, 2, line)

    def test_invalid_toml_is_unreadable(self):
        code, line = sidebar.pr_rule_check("[ui\nbroken", "unicode")
        self.assertEqual(code, 2, line)
        self.assertIn("not valid TOML", line)

    def test_missing_file_is_unreadable_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "absent.toml"
            code, line = sidebar.check_config_text(str(missing), "unicode")
            self.assertEqual(code, 2, line)
            self.assertFalse(missing.exists())
            self.assertEqual(list(Path(tmp).iterdir()), [])


class DaemonStartCheckTest(unittest.TestCase):
    """run_daemon runs the PR rule check once after its start line; nothing real is spawned."""

    def start(self, config_text):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        Path(tmp.name, "config.toml").write_text(config_text, encoding="utf-8")
        args = argparse.Namespace(symbols="unicode", agent_dir=None)
        with mock.patch.object(sidebar, "state_dir", return_value=tmp.name), \
                mock.patch.object(sidebar, "_lock", return_value=(True, None)), \
                mock.patch.object(sidebar, "herdr_config_dir", return_value=tmp.name), \
                mock.patch.object(sidebar, "Publisher", return_value=mock.Mock()), \
                mock.patch.object(sidebar, "_spawn_radar", side_effect=SystemExit(0)), \
                mock.patch.object(sidebar, "log") as log, \
                mock.patch.object(sidebar.signal, "signal"), \
                mock.patch.object(sidebar.faulthandler, "register", create=True):
            with self.assertRaises(SystemExit):
                sidebar.run_daemon(args, "/nonexistent/foreman")
        return [c.args[0] for c in log.call_args_list]

    def test_stale_config_logs_exactly_one_stale_line(self):
        old = SNIPPET
        for glyph, dot in EMOJI_DOTS.items():
            old = old.replace(glyph, dot)
        msgs = self.start(old)
        stale = [m for m in msgs if m.startswith("stale:")]
        self.assertEqual(len(stale), 1, msgs)
        self.assertIn("config has \U0001F534 \U0001F7E1 \U0001F7E2", stale[0])
        self.assertTrue(msgs[0].startswith("started, foreman"), msgs)

    def test_ok_config_logs_no_stale_line(self):
        msgs = self.start(SNIPPET)
        self.assertEqual([m for m in msgs if m.startswith("stale:")], [], msgs)
        self.assertEqual(len(msgs), 1, msgs)


if __name__ == "__main__":
    unittest.main()
