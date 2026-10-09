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
        for k in ("HERDR_BIN", "PI_INTERCOM_STABLE_ID", "FAKE_HERDR_FAIL", "FAKE_HERDR_WORKSPACES"):
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
        code, out, err = self.run_main(*self.open_args("--model", "prov/model-1"), FAKE_HERDR_WORKSPACES=ws)
        self.assertEqual(code, 0, err)
        calls = self.calls()
        self.assertEqual(calls[0], ["workspace", "list"])
        self.assertEqual(calls[1], ["tab", "create", "--workspace", "w2", "--cwd", str(self.proj / "sub"), "--label", "demo", "--no-focus"])
        self.assertEqual(calls[2][:3], ["pane", "run", "w2:p7"])
        self.assertEqual(len(calls), 3)
        entry = self.registry()[0]
        handoff = Path(entry["handoff"])
        self.assertEqual((entry["status"], entry["pane"], entry["label"]), ("open", "w2:p7", "demo"))
        self.assertRegex(entry["child"], r"^fm-demo-[0-9a-f]{6}$")
        self.assertEqual((handoff / "parent").read_text().strip(), "parent-1")
        self.assertEqual((handoff / "child").read_text().strip(), entry["child"])
        self.assertTrue(handoff.parent == self.agent / "pi-foreman" / "handoffs")
        words = shlex.split(calls[2][3])
        self.assertEqual(words, ["env", "PI_FOREMAN_HANDOFF_DIR=%s" % handoff, "PI_FOREMAN_PARENT_INTERCOM=parent-1",
                                 "PI_INTERCOM_STABLE_ID=%s" % entry["child"], "pi", "--model", "prov/model-1",
                                 "Read the handoff brief at %s and proceed." % (handoff / "brief.md").as_posix()])

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

    def test_dry_run_writes_the_handoff_only(self):
        code, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertEqual(code, 0, err)
        self.assertIn("dry run: would open a tab 'demo' in the Herdr workspace 'proj'", out)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.agent / "pi-foreman" / "state" / "sessions.json").exists())
        dirs = list((self.agent / "pi-foreman" / "handoffs").iterdir())
        self.assertEqual(len(dirs), 1)
        self.assertTrue((dirs[0] / "brief.md").is_file())

    def test_footer_contract_and_no_home_path(self):
        code, _, _ = self.run_main(*self.open_args("--plan-first", "--dry-run"))
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


if __name__ == "__main__":
    unittest.main()
