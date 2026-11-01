"""`foreman session open --first-command / --plan-mode` (scripts/foreman_session.py)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_foreman_session as base  # noqa: E402

fsn = base.fsn


class FirstCommandsTest(unittest.TestCase):
    # reuse the fixture of the session tests without inheriting (and rerunning) their cases
    setUp = base.SessionTest.setUp
    run_main = base.SessionTest.run_main
    registry = base.SessionTest.registry
    open_args = base.SessionTest.open_args

    def launch_line(self, *extra):
        code, out, err = self.run_main(*self.open_args("--dry-run", "--print-all", *extra), HERDR_PANE_ID="")
        self.assertEqual(code, 0, err)
        return out

    def test_helpers_order_dedup_and_plan_first(self):
        self.assertEqual(fsn.first_commands(["/a", "/plan", "/a"], True), ["/plan", "/a"])
        self.assertEqual(fsn.first_commands([], False), [])

    def test_posix_and_powershell_order_and_quoting(self):
        out = self.launch_line("--first-command", "/plan", "--first-command", "/note it's x")
        posix = [l for l in out.splitlines() if l.strip().startswith("env ")][0]
        self.assertIn("pi '/note it'\"'\"'s x' '/plan Read the handoff", posix)
        ps = [l for l in out.splitlines() if l.strip().startswith("$env:")][0]
        self.assertIn("pi '/note it''s x' '/plan Read the handoff", ps)

    def test_plan_mode_is_first_and_deduplicated(self):
        out = self.launch_line("--first-command", "/x", "--plan-mode", "--first-command", "/plan")
        posix = [l for l in out.splitlines() if l.strip().startswith("env ")][0]
        self.assertIn("pi /x '/plan Read the handoff", posix)
        self.assertEqual(posix.count("/plan"), 1)

    def test_plan_first_is_independent(self):
        code, out, err = self.run_main(*self.open_args("--plan-first", "--plan-mode"))
        self.assertEqual(code, 0, err)
        entry = self.registry()[-1]
        self.assertEqual(entry["firstCommands"], ["/plan"])
        brief = Path(entry["handoff"]) / "brief.md"
        self.assertIn("plan.md", brief.read_text("utf-8"))

    def test_refusals(self):
        bad = [("--first-command", "plan"), ("--first-command", "/a\nb"), ("--first-command", "/" + "x" * 200),
               ("--first-command", "/a\x07")]
        for flag in bad:
            code, out, err = self.run_main(*self.open_args("--dry-run", *flag))
            self.assertEqual(code, 1, flag)
            self.assertIn("--first-command", err)
        five = [x for i in range(5) for x in ("--first-command", "/c%d" % i)]
        self.assertEqual(self.run_main(*self.open_args("--dry-run", *five))[0], 1)
        four_plus_plan = [x for i in range(4) for x in ("--first-command", "/c%d" % i)] + ["--plan-mode"]
        self.assertEqual(self.run_main(*self.open_args("--dry-run", *four_plus_plan))[0], 1)
        limit = [x for i in range(4) for x in ("--first-command", "/c%d" % i)]
        self.assertEqual(self.run_main(*self.open_args("--dry-run", *limit))[0], 0)

    def test_typographic_single_quotes_are_refused(self):
        for q in ["\u2018", "\u2019", "\u201a", "\u201b"]:
            code, out, err = self.run_main(*self.open_args("--dry-run", "--first-command", "/a" + q + "b"))
            self.assertEqual(code, 1, repr(q))
            self.assertIn("--first-command", err)

    def test_ps_quote_doubles_every_single_quote_kind(self):
        self.assertEqual(fsn.ps_quote("a'b\u2018c\u2019d\u201ae\u201bf"),
                         "'a''b\u2018\u2018c\u2019\u2019d\u201a\u201ae\u201b\u201bf'")
        self.assertIn("--model 'm\u2019\u2019x'", fsn.powershell_command([], "m\u2019x", "p"))

    def test_dry_run_writes_nothing(self):
        code, out, err = self.run_main(*self.open_args("--dry-run", "--plan-mode"))
        self.assertEqual(code, 0, err)
        self.assertFalse((self.agent / "pi-foreman").exists())

    def test_default_launch_line_is_unchanged(self):
        out = self.launch_line()
        posix = [l for l in out.splitlines() if l.strip().startswith("env ")][0]
        self.assertIn(" pi 'Read the handoff brief at ", posix)
        code, _, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        self.assertNotIn("firstCommands", self.registry()[-1])

    def test_registry_and_launch_file_carry_the_commands(self):
        code, out, err = self.run_main(*self.open_args("--first-command", "/a", "--plan-mode"))
        self.assertEqual(code, 0, err)
        entry = self.registry()[-1]
        self.assertEqual(entry["firstCommands"], ["/plan", "/a"])
        launch = (Path(entry["handoff"]) / fsn.LAUNCH_FILE).read_text("utf-8")
        self.assertIn(" pi /a '/plan Read the handoff", launch)

    def test_launch_messages(self):
        self.assertEqual(fsn.launch_messages([], "P"), ["P"])
        self.assertEqual(fsn.launch_messages(["/x"], "P"), ["/x", "P"])
        self.assertEqual(fsn.launch_messages(["/plan"], "P"), ["/plan P"])
        self.assertEqual(fsn.launch_messages(["/plan", "/x", "/y"], "P"), ["/x", "/y", "/plan P"])
        self.assertEqual(fsn.launch_messages(["/plan start"], "P"), ["/plan start", "P"])
        self.assertEqual(fsn.launch_messages(["/plan start", "/plan"], "P"), ["/plan start", "/plan P"])

    def test_plan_mode_alone_is_one_merged_word(self):
        out = self.launch_line("--plan-mode")
        posix = [l for l in out.splitlines() if l.strip().startswith("env ")][0]
        ps = [l for l in out.splitlines() if l.strip().startswith("$env:")][0]
        self.assertIn(" pi '/plan Read the handoff brief at ", posix)
        self.assertTrue(posix.endswith(" and proceed.'"), posix)
        self.assertIn(" pi '/plan Read the handoff brief at ", ps)
        self.assertEqual(posix.count("/plan"), 1)
        self.assertEqual(ps.count("/plan"), 1)

    def test_explicit_plan_command_equals_plan_mode(self):
        a = self.launch_line("--plan-mode")
        b = self.launch_line("--first-command", "/plan")
        pick = lambda o: [l for l in o.splitlines() if l.strip().startswith("env ")][0].split(" pi ", 1)[1].split("'/plan ", 1)[0]
        self.assertEqual(pick(a), pick(b))
        self.assertIn(" pi '/plan Read the handoff", [l for l in b.splitlines() if l.strip().startswith("env ")][0])

    def test_plan_start_stays_a_separate_word(self):
        out = self.launch_line("--first-command", "/plan start")
        posix = [l for l in out.splitlines() if l.strip().startswith("env ")][0]
        self.assertIn(" pi '/plan start' 'Read the handoff", posix)

    def test_argv_for_hc_ends_in_one_plan_word(self):
        for platform in ("linux", "win32"):
            argv = fsn.hc_child_argv([], None, "Read the handoff brief at X and proceed.", ["/plan"], platform, "/bin")
            if platform == "win32":
                self.assertTrue(argv[-1].endswith("pi '/plan Read the handoff brief at X and proceed.'"), argv[-1])
            else:
                self.assertEqual(argv[-1], "/plan Read the handoff brief at X and proceed.")
                self.assertNotIn("/plan", argv[:-1])


if __name__ == "__main__":
    unittest.main()
