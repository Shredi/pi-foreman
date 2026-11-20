"""`foreman session open --profile <name>` is accepted and ignored with a stderr notice: permission profiles are gone."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base

fsn = base.fsn


class SessionProfileTest(unittest.TestCase):
    # reuse the fixture of the session tests without inheriting (and rerunning) their cases
    setUp = base.SessionTest.setUp
    run_main = base.SessionTest.run_main
    registry = base.SessionTest.registry
    calls = base.SessionTest.calls
    open_args = base.SessionTest.open_args

    def open_dry(self, *extra):
        return self.run_main(*self.open_args("--dry-run", "--print-all", *extra), HERDR_PANE_ID="")

    def test_profile_is_accepted_ignored_and_noticed(self):
        for name in ("steward", "anything-at-all"):
            code, out, err = self.open_dry("--profile", name)
            self.assertEqual(code, 0, err)
            self.assertNotIn("PI_FOREMAN_PERMS_PROFILE", out)
            self.assertIn("--profile is ignored", err)

    def test_no_flag_prints_no_notice(self):
        code, out, err = self.open_dry()
        self.assertEqual(code, 0, err)
        self.assertNotIn("PI_FOREMAN_PERMS_PROFILE", out)
        self.assertNotIn("--profile", err)

    def test_profile_with_machine_is_no_longer_refused_for_the_profile(self):
        code, _, err = self.run_main(*self.open_args("--machine", "box", "--profile", "steward"))
        self.assertIn("--profile is ignored", err)
        self.assertNotIn("--profile is not supported with --machine", err)

    def test_child_env_has_no_profile_variable(self):
        env = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {})
        self.assertNotIn("PI_FOREMAN_PERMS_PROFILE", [k for k, _ in env])


if __name__ == "__main__":
    unittest.main()
