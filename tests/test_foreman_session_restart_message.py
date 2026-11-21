"""`foreman session restart`: the restarted child gets the crash restart's one message through PI_FOREMAN_RESUMED (read at session start by paneresume.ts)."""
import re
import sys
import unittest
from unittest import mock

from tests.test_foreman_session_restart import LocalRestartBase, assign, fsn, has_session_arg, word


def resumed_marks(argv, win=None):
    """The PI_FOREMAN_RESUMED digits of a `hc run` argv, one entry per occurrence (None when malformed): anchored argv elements on POSIX, `$env:...='N';` statements on win32."""
    if sys.platform == "win32" if win is None else win:
        text = " ".join(argv)
        found = re.findall(r"\$env:PI_FOREMAN_RESUMED='(\d{1,16})';", text)
        return found if len(found) == text.count("PI_FOREMAN_RESUMED") else [None] * max(1, text.count("PI_FOREMAN_RESUMED"))
    found = [a for a in argv if "PI_FOREMAN_RESUMED" in a]
    return [(re.fullmatch(r"PI_FOREMAN_RESUMED=(\d{1,16})", a) or [None, None])[1] for a in found]


class RestartMessageTest(LocalRestartBase):
    def test_new_terminal_carries_the_resumed_marker(self):
        self.write_entry()
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        _, argv = self.run_head()
        marks = resumed_marks(argv)
        self.assertEqual(len(marks), 1, argv)
        self.assertIsNotNone(marks[0], argv)


class LaunchFormTest(unittest.TestCase):
    def test_assign_and_word_read_both_forms(self):
        self.assertEqual(assign("K", "a b", win=False), "K=a b")
        self.assertEqual(assign("K", "C:\\x y\\it's", win=True), "$env:K='C:\\x y\\it''s'")
        self.assertEqual((word("--session", win=False), word("--session", win=True)), ("--session", "'--session'"))

    def test_matchers_reject_loose_argv(self):
        path = "/s/a.jsonl"
        for win in (False, True):
            self.assertFalse(has_session_arg(["pi", "--session=%s.bak" % path], path, win=win))
        self.assertTrue(has_session_arg(["pi", "--session", path], path, win=False))
        self.assertTrue(has_session_arg(["pi '--session' '%s'" % path], path, win=True))
        self.assertFalse(has_session_arg(["pi '--session' '%s.bak'" % path], path, win=True))
        self.assertEqual(resumed_marks(["PI_FOREMAN_RESUMED=123"], win=False), ["123"])
        self.assertEqual(resumed_marks(["x;$env:PI_FOREMAN_RESUMED='123';y"], win=True), ["123"])
        self.assertEqual(resumed_marks(["PI_FOREMAN_RESUMED=%s" % ("1" * 20) + "x"], win=False), [None])
        self.assertEqual(resumed_marks(["PI_FOREMAN_RESUMED=1", "PI_FOREMAN_RESUMED=2"], win=False), ["1", "2"])


if __name__ == "__main__":
    unittest.main()
