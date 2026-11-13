"""The registry row of `session open --machine` stores the remote's intercom name cleaned like the printed one."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_session_remote import RemoteBase, fsn  # noqa: E402


class OriginCleanTest(RemoteBase):
    def stored(self, name):
        """`originMachine` of the parent registry row after an open whose probe reply carries `intercomMachineName: name`."""
        real = fsn.hc_exec_verb

        def verb(binary, machine, argv, v, payload, timeout):
            reply = real(binary, machine, argv, v, payload, timeout)
            if v == "probe":
                reply["intercomMachineName"] = name
            return reply

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=verb):
            code, _out, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        return self.parent_registry()[-1]["originMachine"]

    def test_escape_and_newline_are_removed(self):
        self.assertEqual(self.stored("win\x1b[2Jbox\nx\x9b"), "win[2Jboxx")

    def test_a_plain_name_is_kept(self):
        self.assertEqual(self.stored("winbox"), "winbox")

    def test_a_non_string_is_stored_as_none(self):
        self.assertIsNone(self.stored(7))

    def test_a_name_of_control_characters_only_is_stored_as_none(self):
        self.assertIsNone(self.stored("\x1b\x07\n"))


if __name__ == "__main__":
    unittest.main()
