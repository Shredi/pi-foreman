"""`foreman session restart`: the restarted child gets the crash restart's one message through PI_FOREMAN_RESUMED (read at session start by paneresume.ts)."""
import re
import unittest
from unittest import mock

from tests.test_foreman_session_restart import LocalRestartBase, assign, fsn, launch_text, word


class RestartMessageTest(LocalRestartBase):
    def test_new_terminal_carries_the_resumed_marker(self):
        self.write_entry()
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        _, argv = self.run_head()
        text = launch_text(argv)
        self.assertEqual(text.count("PI_FOREMAN_RESUMED"), 1, argv)
        mark = re.search(r"PI_FOREMAN_RESUMED=?'?(\d{1,16})", text)
        self.assertIsNotNone(mark, argv)
        self.assertIn(assign("PI_FOREMAN_RESUMED", mark.group(1)), text)


class LaunchFormTest(unittest.TestCase):
    def test_assign_and_word_read_both_forms(self):
        self.assertEqual(assign("K", "a b", win=False), "K=a b")
        self.assertEqual(assign("K", "C:\\x y\\it's", win=True), "$env:K='C:\\x y\\it''s'")
        self.assertEqual((word("--session", win=False), word("--session", win=True)), ("--session", "'--session'"))


if __name__ == "__main__":
    unittest.main()
