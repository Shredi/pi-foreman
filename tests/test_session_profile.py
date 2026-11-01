"""`foreman session open --profile <name>` sets PI_FOREMAN_PERMS_PROFILE for the child (r79 item 8, owner CLI only)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn


class SessionProfileTest(unittest.TestCase):
    # reuse the fixture of the session tests without inheriting (and rerunning) their cases
    setUp = base.SessionTest.setUp
    run_main = base.SessionTest.run_main
    registry = base.SessionTest.registry
    calls = base.SessionTest.calls
    open_args = base.SessionTest.open_args

    def user_profiles(self, names):
        f = self.agent / "pi-foreman" / "permissions.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"profiles": {n: {"mode": "ask"} for n in names}}), "utf-8")

    def open_dry(self, *extra):
        return self.run_main(*self.open_args("--dry-run", "--print-all", *extra), HERDR_PANE_ID="")

    def test_builtin_steward_sets_the_env_in_the_launch_line(self):
        code, out, err = self.open_dry("--profile", "steward")
        self.assertEqual(code, 0, err)
        self.assertIn("PI_FOREMAN_PERMS_PROFILE=steward", out)

    def test_user_profile_from_permissions_json_is_accepted(self):
        self.user_profiles(["review-only"])
        code, out, err = self.open_dry("--profile", "review-only")
        self.assertEqual(code, 0, err)
        self.assertIn("PI_FOREMAN_PERMS_PROFILE=review-only", out)

    def test_no_flag_sets_no_profile(self):
        code, out, err = self.open_dry()
        self.assertEqual(code, 0, err)
        self.assertNotIn("PI_FOREMAN_PERMS_PROFILE", out)

    def test_unknown_profile_refuses_and_lists_the_known_names(self):
        self.user_profiles(["review-only"])
        code, out, err = self.open_dry("--profile", "nope")
        self.assertEqual(code, 1)
        self.assertIn("unknown permissions profile", err)
        self.assertIn("steward", err)
        self.assertIn("review-only", err)
        self.assertEqual(self.calls(), [])  # nothing opened

    def test_an_unreadable_permissions_file_leaves_only_the_builtin_names(self):
        f = self.agent / "pi-foreman" / "permissions.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("{not json", "utf-8")
        self.assertEqual(fsn.profile_names(self.agent), ["steward"])

    def test_profile_with_machine_is_refused(self):
        code, _, err = self.run_main(*self.open_args("--machine", "box", "--profile", "steward"))
        self.assertEqual(code, 1)
        self.assertIn("--profile is not supported with --machine", err)

    def test_child_env_carries_the_profile_only_when_given(self):
        on = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {}, profile="steward")
        self.assertIn(("PI_FOREMAN_PERMS_PROFILE", "steward"), on)
        off = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {})
        self.assertNotIn("PI_FOREMAN_PERMS_PROFILE", [k for k, _ in off])


if __name__ == "__main__":
    unittest.main()
