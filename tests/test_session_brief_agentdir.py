"""`open` with a brief that is not a readable file is refused cleanly (no traceback), and a local child keeps the
opener's agent dir (PI_CODING_AGENT_DIR) while a remote child never gets it."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS.parent / "scripts"))
sys.path.insert(0, str(TESTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402
import test_foreman_session as base  # noqa: E402


class BriefAndAgentDirTest(unittest.TestCase):
    setUp = base.SessionTest.setUp
    run_main = base.SessionTest.run_main
    open_args = base.SessionTest.open_args

    def assert_clean_refusal(self, code, err, name):
        self.assertEqual(code, 1, err)
        self.assertIn("refused", err)
        self.assertNotIn("Traceback", err)
        self.assertNotIn(name, err)  # the echo is capped (and control characters stripped)
        self.assertLess(len(err), 400)

    def test_a_long_text_as_brief_is_refused_locally(self):
        name = "x" * 300
        code, _, err = self.run_main("open", "demo", name, "--cwd", str(self.proj / "sub"), "--parent-id", "parent-1")
        self.assert_clean_refusal(code, err, name)

    def test_control_characters_of_the_brief_argument_are_not_echoed(self):
        code, _, err = self.run_main("open", "demo", "a\x1b[31mred\nline.md", "--cwd", str(self.proj / "sub"), "--parent-id", "parent-1")
        self.assertEqual(code, 1, err)
        self.assertNotIn("\x1b", err)
        self.assertEqual(err.count("\n"), 1)

    def test_a_long_text_as_brief_is_refused_for_a_remote_open(self):
        name = "y" * 300
        with mock.patch.object(fsn, "machine_entry", return_value=({}, ["foreman"])):
            code, _, err = self.run_main("open", "demo", name, "--machine", "alpha", "--cwd", "/srv/p", "--parent-id", "parent-1")
        self.assert_clean_refusal(code, err, name)

    def test_child_env_has_the_agent_dir_only_for_a_local_child_of_an_opener_that_has_it(self):
        args = (Path("/h/x"), "p", "c", "s", None)
        local = fsn.child_env(*args, {"PI_CODING_AGENT_DIR": "/opener/agent"}, agent_dir=Path("/resolved/agent"))
        self.assertIn(("PI_CODING_AGENT_DIR", str(Path("/resolved/agent"))), local)
        unset = fsn.child_env(*args, {}, agent_dir=Path("/resolved/agent"))
        self.assertNotIn("PI_CODING_AGENT_DIR", [k for k, _ in unset])
        remote = fsn.child_env(*args, {"PI_CODING_AGENT_DIR": "/opener/agent"}, remote=True, agent_dir=Path("/resolved/agent"))
        self.assertNotIn("PI_CODING_AGENT_DIR", [k for k, _ in remote])
        positional = fsn.child_env(*args, {})
        self.assertNotIn("PI_CODING_AGENT_DIR", [k for k, _ in positional])

    def test_a_local_open_launch_line_carries_the_resolved_agent_dir_only_when_set(self):
        def line(**env):
            code, out, err = self.run_main(*self.open_args("--dry-run", "--print-all"), HERDR_PANE_ID="", **env)
            self.assertEqual(code, 0, err)
            return out

        self.assertIn("PI_CODING_AGENT_DIR=", line())
        self.assertNotIn("PI_CODING_AGENT_DIR=", line(PI_CODING_AGENT_DIR=""))


if __name__ == "__main__":
    unittest.main()
