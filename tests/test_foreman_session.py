"""scripts/foreman_session.py with a fake `herdr` first on PATH (records argv, returns canned JSON)."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402

FAKE = r'''
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(args) + "\n")
if " ".join(args[:2]) == os.environ.get("FAKE_HERDR_FAIL"):
    sys.stderr.write("boom\n")
    sys.exit(3)
key = " ".join(args[:2])
if key == "workspace list":
    out = {"result": {"workspaces": json.loads(os.environ.get("FAKE_HERDR_WORKSPACES", "[]"))}}
elif key == "workspace create":
    out = {"result": {"workspace": {"workspace_id": "w9"}, "tab": {"tab_id": "w9:t1"}, "root_pane": {"pane_id": "w9:p1"}}}
elif key == "tab create":
    out = {"result": {"tab": {"tab_id": "w2:t5"}, "root_pane": {"pane_id": "w2:p7"}}}
else:
    out = {"result": {}}
print(json.dumps(out))
'''


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_test_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent dir"  # a space: the pane command must quote it
        self.proj = self.tmp / "proj"
        (self.proj / "sub").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.proj)], check=True)
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n\nDo the thing.\n", "utf-8")
        bindir = self.tmp / "bin"
        bindir.mkdir()
        (bindir / "herdr_fake.py").write_text(FAKE, "utf-8")
        if os.name == "nt":
            (bindir / "herdr.cmd").write_text('@"%s" "%%~dp0herdr_fake.py" %%*\r\n' % sys.executable, "utf-8")
        else:
            sh = bindir / "herdr"
            sh.write_text("#!%s\nexec(open(%r).read())\n" % (sys.executable, str(bindir / "herdr_fake.py")), "utf-8")
            sh.chmod(0o755)
        self.log = self.tmp / "herdr.log"
        self.env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "FAKE_HERDR_LOG": str(self.log),
                    "HERDR_PANE_ID": "w1:p1", "PI_CODING_AGENT_DIR": str(self.agent)}
        for k in ("HERDR_BIN", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_HANDOFF_DIR", "FAKE_HERDR_FAIL", "FAKE_HERDR_WORKSPACES"):
            self.env[k] = ""
        for k in os.environ:  # the opener's add-on variables reach the pane command; tests set them explicitly
            if k.startswith("PI_BG_"):
                self.env[k] = ""

    def run_main(self, *argv, **env):
        e = dict(self.env, **env)
        drop = [k for k, v in e.items() if v == ""]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, e), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            for k in drop:
                os.environ.pop(k, None)
            code = fsn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(l) for l in self.log.read_text("utf-8").splitlines()]

    def registry(self):
        return json.loads((self.agent / "pi-foreman" / "state" / "sessions.json").read_text("utf-8"))["sessions"]

    def open_args(self, *extra):
        return ("open", "demo", str(self.brief), "--cwd", str(self.proj / "sub"), "--parent-id", "parent-1") + extra

    def test_workspace_match_opens_a_tab_and_runs_a_quoted_command(self):
        ws = json.dumps([{"workspace_id": "w3", "label": "other"}, {"workspace_id": "w2", "label": "proj"}])
        opener = self.tmp / "opener"  # the opener's own cwd names the parent, not the child's --cwd
        opener.mkdir()
        with mock.patch.object(fsn.Path, "cwd", return_value=opener):
            code, out, err = self.run_main(*self.open_args("--model", "prov/model-1"), FAKE_HERDR_WORKSPACES=ws)
        self.assertEqual(code, 0, err)
        calls = self.calls()
        self.assertEqual(calls[0], ["workspace", "list"])
        self.assertEqual(calls[1], ["tab", "create", "--workspace", "w2", "--cwd", str(self.proj / "sub"), "--label", "demo", "--no-focus"])
        self.assertEqual(calls[2][:3], ["pane", "run", "w2:p7"])
        # the group tag: pane id first, display-only, parent slug = the opener's repo (or cwd) name
        self.assertEqual(calls[3], ["pane", "report-metadata", "w2:p7", "--source", "user:pi-foreman",
                                    "--display-agent", "opener › demo", "--ttl-ms", "180000"])
        self.assertEqual(len(calls), 4)
        entry = self.registry()[0]
        handoff = Path(entry["handoff"])
        self.assertEqual((entry["status"], entry["pane"], entry["label"]), ("open", "w2:p7", "demo"))
        self.assertRegex(entry["child"], r"^fm-demo-[0-9a-f]{6}$")
        self.assertEqual((handoff / "parent").read_text().strip(), "parent-1")
        self.assertEqual((handoff / "child").read_text().strip(), entry["child"])
        self.assertTrue(handoff.parent == self.agent / "pi-foreman" / "handoffs")
        words = shlex.split(calls[2][3])
        self.assertEqual(words, ["env", "PI_FOREMAN_HANDOFF_DIR=%s" % handoff, "PI_FOREMAN_PARENT_INTERCOM=parent-1",
                                 "PI_INTERCOM_STABLE_ID=%s" % entry["child"], "PI_FOREMAN_PARENT_LABEL=opener",
                                 "PI_FOREMAN_SESSION_MODEL=prov/model-1", "pi", "--model", "prov/model-1",
                                 "Read the handoff brief at %s and proceed." % (handoff / "brief.md").as_posix()])

    def test_group_tag_parent_slug_from_an_opened_child_and_off_switch(self):
        opener = {"PI_FOREMAN_HANDOFF_DIR": str(self.tmp / "20261009-101010-top-abc123"), "PI_INTERCOM_STABLE_ID": "fm-top-abc123"}
        code, _, err = self.run_main(*self.open_args(), **opener)
        self.assertEqual(code, 0, err)
        tags = [c for c in self.calls() if c[:2] == ["pane", "report-metadata"]]
        self.assertEqual([c[2] for c in tags], ["w9:p1"])
        self.assertEqual(tags[0][tags[0].index("--display-agent") + 1], "top › demo")
        self.agent.mkdir(parents=True, exist_ok=True)
        (self.agent / "foreman.json").write_text(json.dumps({"herdr": {"groupTag": False}}), "utf-8")
        self.log.unlink()
        code, _, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        self.assertTrue(self.calls())
        self.assertFalse([c for c in self.calls() if c[:2] == ["pane", "report-metadata"]])

    def test_workspace_create_renames_the_first_tab_and_focuses(self):
        code, _, err = self.run_main(*self.open_args("--focus"))
        self.assertEqual(code, 0, err)
        calls = self.calls()
        self.assertEqual(calls[1], ["workspace", "create", "--cwd", str(self.proj / "sub"), "--label", "proj", "--no-focus"])
        self.assertEqual(calls[2], ["tab", "rename", "w9:t1", "demo"])
        self.assertEqual(calls[3][:3], ["pane", "run", "w9:p1"])
        self.assertEqual(calls[4], ["tab", "focus", "w9:t1"])
        self.assertEqual(self.registry()[0]["workspace"], "w9")

    def test_herdr_failure_exits_2_and_prints_the_fallback(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_HERDR_FAIL="pane run")
        self.assertEqual(code, 2)
        self.assertIn("pane run exited 3", err)
        self.assertIn("PI_FOREMAN_PARENT_INTERCOM", out)
        self.assertEqual(self.registry()[0]["status"], "failed")

    def test_validation_refusals_touch_nothing(self):
        bad = [
            ("open", "a;b", str(self.brief), "--parent-id", "p"),
            ("open", "demo", str(self.tmp / "missing.md"), "--parent-id", "p"),
            ("open", "demo", str(self.brief), "--cwd", str(self.brief), "--parent-id", "p"),
            ("open", "demo", str(self.brief), "--model", "x$(id)", "--parent-id", "p"),
            ("open", "demo", str(self.brief), "--parent-id", "p q"),
            ("open", "demo", str(self.brief)),  # no parent id anywhere
        ]
        for argv in bad:
            code, _, err = self.run_main(*argv)
            self.assertEqual(code, 1, argv)
            self.assertIn("refused", err)
        quoted = self.tmp / "it's"
        quoted.mkdir()
        self.assertEqual(self.run_main("open", "demo", str(self.brief), "--cwd", str(quoted), "--parent-id", "p")[0], 1)
        for q in "\u2018\u2019\u201a\u201b\u201c\u201d\u201e":  # PowerShell treats these as quotes
            typo = self.tmp / ("a" + q + "b")
            typo.mkdir()
            self.assertEqual(self.run_main("open", "demo", str(self.brief), "--cwd", str(typo), "--parent-id", "p")[0], 1)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.agent / "pi-foreman").exists())

    def test_fallback_without_herdr_prints_posix_and_powershell(self):
        code, out, err = self.run_main(*self.open_args("--print-all"), HERDR_PANE_ID="")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.calls(), [])
        entry = self.registry()[0]
        self.assertEqual(entry["status"], "pending")
        lines = out.splitlines()
        posix = lines[lines.index("POSIX shell:") + 1].strip()
        ps = lines[lines.index("PowerShell:") + 1].strip()
        self.assertEqual(shlex.split(posix)[:4], ["env", "PI_FOREMAN_HANDOFF_DIR=%s" % entry["handoff"], "PI_FOREMAN_PARENT_INTERCOM=parent-1", "PI_INTERCOM_STABLE_ID=%s" % entry["child"]])
        self.assertTrue(ps.startswith("$env:PI_FOREMAN_HANDOFF_DIR='%s'; $env:PI_FOREMAN_PARENT_INTERCOM='parent-1'; " % entry["handoff"]), ps)
        self.assertIn("; pi 'Read the handoff brief at ", ps)
        code, out, _ = self.run_main(*self.open_args(), HERDR_PANE_ID="")
        self.assertEqual(code, 0)
        self.assertEqual(("PowerShell" in out or "$env:" in out), sys.platform == "win32")

    def test_dry_run_writes_nothing(self):
        code, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertEqual(code, 0, err)
        self.assertIn("dry run: would open a tab 'demo' in the Herdr workspace 'proj'", out)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.agent / "pi-foreman").exists())

    def test_dry_run_prints_the_requested_model_in_the_command(self):
        code, out, err = self.run_main(*self.open_args("--dry-run", "--print-all", "--model", "prov/model-2"))
        self.assertEqual(code, 0, err)
        self.assertIn("--model prov/model-2", out)

    def test_dry_run_leaves_the_handoffs_dir_and_agent_dir_unchanged(self):
        handoffs = self.agent / "pi-foreman" / "handoffs"
        handoffs.mkdir(parents=True)
        (handoffs / "20260101-000000-old").mkdir()
        tree = sorted(str(p.relative_to(self.agent)) for p in self.agent.rglob("*"))
        code, out, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/model-3"))
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(p.name for p in handoffs.iterdir()), ["20260101-000000-old"])
        self.assertEqual(sorted(str(p.relative_to(self.agent)) for p in self.agent.rglob("*")), tree)
        self.assertIn("handoff: ", out)
        self.assertIn("child intercom id: fm-demo-", out)
        self.assertEqual(self.calls(), [])

    def write_ranks(self):
        self.agent.mkdir(parents=True, exist_ok=True)
        ranks = [{"match": "big-*", "tier": 0}, {"match": "mid-*", "tier": 1}, {"match": "small-*", "tier": 2}]
        (self.agent / "foreman.json").write_text(json.dumps({"providers": {"prov": {"ranks": ranks}}}), "utf-8")

    def test_model_is_exported_to_the_child_and_dry_run_prints_it(self):
        code, out, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/model-4"))
        self.assertEqual(code, 0, err)
        self.assertIn("session model: prov/model-4", out)
        self.assertIn("PI_FOREMAN_SESSION_MODEL=prov/model-4", out)
        code, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertNotIn("PI_FOREMAN_SESSION_MODEL", out)
        self.assertNotIn("session model:", out)

    def test_rank_check_is_skipped_when_the_own_model_is_unknown(self):
        self.write_ranks()
        code, out, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/big-1"))
        self.assertEqual(code, 0, err)
        self.assertIn("rank check skipped: own model unknown", out)

    def test_known_own_model_refuses_a_higher_ranked_child(self):
        self.write_ranks()
        code, out, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/big-1", "--own-model", "prov/mid-1"))
        self.assertEqual(code, 1)
        self.assertIn("session open refused [session_rank]", err)
        self.assertIn("prov/big-1 is tier 0, this session is tier 1", err)
        self.assertEqual(out, "")
        self.assertFalse((self.agent / "pi-foreman").exists())
        # the env var names the own model too
        code, _, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/big-1"), PI_FOREMAN_SESSION_MODEL="prov/mid-1")
        self.assertEqual(code, 1)
        self.assertIn("session_rank", err)

    def test_known_own_model_allows_equal_and_lower_and_refuses_unranked(self):
        self.write_ranks()
        for child in ("prov/mid-2", "prov/small-1"):
            code, out, err = self.run_main(*self.open_args("--dry-run", "--model", child, "--own-model", "prov/mid-1"))
            self.assertEqual(code, 0, err)
            self.assertNotIn("rank check skipped", out)
        code, _, err = self.run_main(*self.open_args("--dry-run", "--model", "prov/odd", "--own-model", "prov/mid-1"))
        self.assertEqual(code, 1)
        self.assertIn("prov/odd is unranked", err)

    def test_footer_contract_and_no_home_path(self):
        code, _, _ = self.run_main(*self.open_args("--plan-first"))
        self.assertEqual(code, 0)
        brief = next((self.agent / "pi-foreman" / "handoffs").iterdir()) / "brief.md"
        text = brief.read_text("utf-8")
        self.assertTrue(text.startswith("# Task\n\nDo the thing.\n"))
        for want in ("Plan from demo:", "Result from demo:", "Update from demo:", "foreman:closed <path>", "`parent`"):
            self.assertIn(want, text)
        tail = text.split("Do the thing.")[1]
        for private in (str(Path.home()), str(self.tmp), str(self.agent)):
            self.assertNotIn(private, tail)
        self.assertNotIn("Plan from", fsn.footer("demo", False))

    def open_one(self, *extra):
        code, _, err = self.run_main(*self.open_args(*extra))
        self.assertEqual(code, 0, err)
        return self.registry()[-1]

    def test_list_shows_label_model_state_and_handoff(self):
        entry = self.open_one("--model", "prov/model-5")
        self.assertEqual(entry["model"], "prov/model-5")
        code, out, _ = self.run_main("list")
        self.assertEqual(code, 0)
        row = [l for l in out.splitlines() if l.startswith("  demo")][0].split()
        self.assertEqual(row[:4], ["demo", "prov/model-5", "open", entry["handoff"].split()[0]])
        self.assertIn(entry["handoff"], out)

    def test_brief_by_label_and_by_handoff_dir_sends_to_the_child(self):
        entry = self.open_one()
        sent = []
        with mock.patch.object(fsn, "send_intercom", side_effect=lambda to, text: (sent.append((to, text)), (True, ""))[1]):
            code, out, err = self.run_main("brief", "demo", "go ahead with B", "--parent-id", "parent-1")
            self.assertEqual(code, 0, err)
            code, _, err = self.run_main("brief", entry["handoff"], "second", "--parent-id", "parent-1")
        self.assertEqual(code, 0, err)
        self.assertEqual(sent, [(entry["child"], "go ahead with B"), (entry["child"], "second")])
        self.assertIn("brief sent to %s" % entry["child"], out)

    def test_brief_with_a_file_uses_the_brief_from_wording(self):
        entry = self.open_one()
        note = self.tmp / "ruling.md"
        note.write_text("APPROVED\n", "utf-8")
        sent = []
        with mock.patch.object(fsn, "send_intercom", side_effect=lambda to, text: (sent.append((to, text)), (True, ""))[1]):
            code, _, err = self.run_main("brief", "demo", str(note), "--parent-id", "parent-1")
        self.assertEqual(code, 0, err)
        self.assertEqual(sent, [(entry["child"], "Brief from parent-1: read %s and act on it" % note.resolve())])

    def test_brief_failure_prints_the_manual_fallback_and_never_calls_herdr(self):
        entry = self.open_one()
        self.log.unlink()
        with mock.patch.object(fsn, "send_intercom", return_value=(False, "broker down")):
            code, out, err = self.run_main("brief", "demo", "hello", "--parent-id", "parent-1")
        self.assertEqual(code, 1)
        self.assertIn("not sent (broker down)", err)
        self.assertIn("Not sent. Send it yourself", out)
        self.assertIn(entry["child"], out)
        self.assertEqual(self.calls(), [])

    def test_brief_unknown_target_is_refused_and_send_uses_an_argv_list(self):
        code, _, err = self.run_main("brief", "nope", "x", "--parent-id", "parent-1")
        self.assertEqual(code, 1)
        self.assertIn("no session with", err)
        cli = self.tmp / "cli.mjs"
        cli.write_text("", "utf-8")
        done = mock.Mock(returncode=0, stdout=b"", stderr=b"")
        with mock.patch.object(fsn, "intercom_cli", return_value=cli), mock.patch.object(fsn.shutil, "which", return_value="/bin/node"), \
                mock.patch.object(fsn.subprocess, "run", return_value=done) as run:
            self.assertEqual(fsn.send_intercom("fm-x-abc123", "hi there"), (True, ""))
        self.assertEqual(run.call_args[0][0], ["/bin/node", str(cli), "send", "--to", "fm-x-abc123", "--text", "hi there"])
        self.assertNotIn("shell", run.call_args[1])
        with mock.patch.object(fsn, "intercom_cli", return_value=None):
            self.assertFalse(fsn.send_intercom("fm-x-abc123", "hi")[0])

    # -- ledger 9: the opener's PI_BG_* reach the child; launch.txt holds the exact launch line --------------------

    def test_pi_bg_features_set_reaches_the_pane_command_and_launch_txt(self):
        code, _, err = self.run_main(*self.open_args(), PI_BG_FEATURES="process,attribution", PI_BG_LOG_DIR="/tmp/bg logs")
        self.assertEqual(code, 0, err)
        command = [c for c in self.calls() if c[:2] == ["pane", "run"]][0][3]
        words = shlex.split(command)
        self.assertIn("PI_BG_FEATURES=process,attribution", words)
        self.assertIn("PI_BG_LOG_DIR=/tmp/bg logs", words)
        self.assertLess(words.index("PI_BG_FEATURES=process,attribution"), words.index("pi"))
        handoff = Path(self.registry()[0]["handoff"])
        self.assertEqual((handoff / "launch.txt").read_text("utf-8"), command + "\n")

    def test_pi_bg_features_unset_is_absent_and_launch_txt_still_written(self):
        code, _, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        command = [c for c in self.calls() if c[:2] == ["pane", "run"]][0][3]
        self.assertNotIn("PI_BG_", command)
        handoff = Path(self.registry()[0]["handoff"])
        self.assertEqual((handoff / "launch.txt").read_text("utf-8"), command + "\n")

    def test_launch_txt_without_herdr_is_the_printed_fallback_line(self):
        code, out, err = self.run_main(*self.open_args(), HERDR_PANE_ID="", PI_BG_FEATURES="process")
        self.assertEqual(code, 0, err)
        handoff = Path(self.registry()[0]["handoff"])
        line = (handoff / "launch.txt").read_text("utf-8").rstrip("\n")
        self.assertIn("  " + line, out.splitlines())
        self.assertIn("PI_BG_FEATURES", line)

    def test_dry_run_writes_no_launch_txt(self):
        code, out, err = self.run_main(*self.open_args("--dry-run"), PI_BG_FEATURES="process")
        self.assertEqual(code, 0, err)
        self.assertIn("PI_BG_FEATURES=process", out)
        self.assertFalse((self.agent / "pi-foreman").exists())


class AddonEnvTest(unittest.TestCase):
    def test_only_pi_bg_vars_features_first_and_bad_values_skipped(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            pairs = fsn.addon_env({"PI_BG_Z": "1", "PI_BG_FEATURES": "process", "PI_BGX": "no", "HOME": "/h",
                                   "PI_BG_EVIL": "x; id", "PI_BG_Q": "it\u2019s"})
        self.assertEqual(pairs, [("PI_BG_FEATURES", "process"), ("PI_BG_Z", "1")])
        self.assertIn("PI_BG_EVIL not forwarded", err.getvalue())
        self.assertIn("PI_BG_Q not forwarded", err.getvalue())
        self.assertEqual(fsn.addon_env({}), [])

    def test_powershell_line_carries_the_features(self):
        env = fsn.child_env(Path("/h/x"), "p", "c", "s", None, {"PI_BG_FEATURES": "process"})
        self.assertIn("$env:PI_BG_FEATURES='process'; ", fsn.powershell_command(env, None, "go"))
        self.assertEqual(fsn.child_env(Path("/h/x"), "p", "c", "s", None, {})[-1][0], fsn.ENV_PARENT_LABEL)


class OpenerIdTest(unittest.TestCase):
    def test_precedence_given_published_stable_config(self):
        env = {fsn.ENV_PUBLISHED: "pub", fsn.ENV_STABLE: "stable"}
        with mock.patch.object(fsn, "parent_from_config", return_value="cfg"):
            self.assertEqual(fsn.opener_id("given", Path("."), env), "given")
            self.assertEqual(fsn.opener_id(None, Path("."), env), "pub")
            self.assertEqual(fsn.opener_id(None, Path("."), {fsn.ENV_STABLE: " stable "}), "stable")
            self.assertEqual(fsn.opener_id(None, Path("."), {}), "cfg")


class AskFooterTest(unittest.TestCase):
    def test_footer_names_the_ask_file_contract_in_both_variants(self):
        for plan_first in (True, False):
            text = fsn.footer("demo", plan_first)
            for needle in ("# Ask <n>: <topic>", "ask.md", "ruling-<n>.md", ".seen", ".ask", "foreman_wait", "Session not found"):
                self.assertIn(needle, text)
            self.assertIn("Never ask by `herdr agent prompt`", text)


class PlanFirstFooterTest(unittest.TestCase):
    def test_plan_first_footer_names_the_ruling_handoff(self):
        text = fsn.footer("demo", True)
        self.assertIn("ruling.md", text)
        self.assertIn("APPROVED", text)
        self.assertIn("foreman session brief demo", text)
        self.assertNotIn("ruling.md", fsn.footer("demo", False))


if __name__ == "__main__":
    unittest.main()
