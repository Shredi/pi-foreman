"""`foreman session restart`: the restarted child gets the crash restart's one message through PI_FOREMAN_RESUMED (read at session start by paneresume.ts)."""
import unittest
from unittest import mock

from tests.test_foreman_session_restart import LocalRestartBase, fsn


class RestartMessageTest(LocalRestartBase):
    def test_new_terminal_carries_the_resumed_marker(self):
        self.write_entry()
        with mock.patch.object(fsn, "hc_terminal_addresses", return_value={"t0"}):
            code, out, err = self.restart()
        self.assertEqual(code, 0, err)
        _, argv = self.run_head()
        marks = [a for a in argv if a.startswith("PI_FOREMAN_RESUMED=")]
        self.assertEqual(len(marks), 1, argv)
        self.assertRegex(marks[0], r"^PI_FOREMAN_RESUMED=\d{1,16}$")


if __name__ == "__main__":
    unittest.main()
