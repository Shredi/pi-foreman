"""scripts/foreman_session.py `open` under herdr-core: a fake `hc` (records argv, returns canned JSON), no real binary."""
from __future__ import annotations

import contextlib
import io
import json
import os
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

FAKE_HC = r'''
import json, os, sys
with open(os.environ["FAKE_HC_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
if os.environ.get("FAKE_HC_FAIL"):
    sys.stderr.write("boom\n")
    sys.exit(3)
if os.environ.get("FAKE_HC_RAW"):
    print(os.environ["FAKE_HC_RAW"])
    sys.exit(0)
out = {"address": "t2", "name": "x", "state": "live"}
if sys.argv[1] == "get" and os.environ.get("FAKE_HC_LABELS"):
    out["labels"] = json.loads(os.environ["FAKE_HC_LABELS"])
if os.environ.get("FAKE_HC_PARENT"):
    out["parent"] = os.environ["FAKE_HC_PARENT"]
print(json.dumps(out))
'''

FAKE_HERDR = r'''
import json, os, sys
with open(os.environ["FAKE_HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
key = " ".join(sys.argv[1:3])
if key == "workspace list":
    out = {"result": {"workspaces": []}}
elif key == "workspace create":
    out = {"result": {"workspace": {"workspace_id": "w9"}, "tab": {"tab_id": "w9:t1"}, "root_pane": {"pane_id": "w9:p1"}}}
else:
    out = {"result": {}}
print(json.dumps(out))
'''

CALLER_PATH = os.pathsep.join(["/opt/fake/bin", "/usr/bin"])
FAKE_PI = "/opt/fake/bin/pi"


def which_pi(name, *a, **k):
    return FAKE_PI if name == "pi" else shutil.which(name, *a, **k)


class HcSessionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_hc_test_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.proj = self.tmp / "proj"
        self.proj.mkdir()
        subprocess.run(["git", "init", "-q", str(self.proj)], check=True)
        self.brief = self.tmp / "brief.md"
        self.brief.write_text("# Task\n\nDo the thing.\n", "utf-8")
        self.bindir = self.tmp / "bin"
        self.bindir.mkdir()
        self.hc_log, self.herdr_log = self.tmp / "hc.log", self.tmp / "herdr.log"
        self.hc = self.fake("hc", FAKE_HC)
        self.herdr = self.fake("herdr", FAKE_HERDR)
        self.env = {"PATH": CALLER_PATH, "PI_CODING_AGENT_DIR": str(self.agent), "FAKE_HC_LOG": str(self.hc_log),
                    "FAKE_HERDR_LOG": str(self.herdr_log), "HC_TERMINAL_ID": "t1", "HC_BIN": str(self.hc)}
        for k in ("HERDR_PANE_ID", "HERDR_BIN", "HC_SCOPE", "HC_TERMINAL_SOCKET", "PI_INTERCOM_STABLE_ID",
                  "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_HANDOFF_DIR", "FAKE_HC_FAIL", "FAKE_HC_RAW", "FAKE_HC_PARENT",
                  "FAKE_HC_LABELS"):
            self.env[k] = ""
        for k in os.environ:
            if k.startswith("PI_BG_"):
                self.env[k] = ""

    def fake(self, name, body):
        script = self.bindir / (name + "_fake.py")
        script.write_text(body, "utf-8")
        if os.name == "nt":
            target = self.bindir / (name + ".cmd")
            target.write_text('@"%s" "%s" %%*\r\n' % (sys.executable, script), "utf-8")
        else:
            target = self.bindir / name
            target.write_text("#!%s\nexec(open(%r).read())\n" % (sys.executable, str(script)), "utf-8")
            target.chmod(0o755)
        return target

    def config(self, **sessions):
        self.agent.mkdir(parents=True, exist_ok=True)
        (self.agent / "foreman.json").write_text(json.dumps({"sessions": sessions}), "utf-8")

    def run_main(self, *argv, platform=None, **env):
        e = dict(self.env, **env)
        drop = [k for k, v in e.items() if v == ""]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, e), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(fsn.shutil, "which", which_pi):
            for k in drop:
                os.environ.pop(k, None)
            if platform:
                with mock.patch.object(fsn, "host_platform", return_value=platform):
                    code = fsn.main(list(argv))
            else:
                code = fsn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def open_args(self, *extra):
        return ("open", "demo", str(self.brief), "--cwd", str(self.proj), "--parent-id", "parent-1") + extra

    def log(self, path):
        return [json.loads(l) for l in path.read_text("utf-8").splitlines()] if path.exists() else []

    def registry(self):
        return json.loads((self.agent / "pi-foreman" / "state" / "sessions.json").read_text("utf-8"))["sessions"]

    def run_calls(self):
        return [c for c in self.log(self.hc_log) if c[:1] == ["run"]]

    def hc_call(self):
        calls = self.run_calls()
        self.assertEqual(len(calls), 1, calls)
        return calls[0]

    # ------------------------------------------------------------------ backend selection

    def test_auto_uses_hc_when_a_terminal_id_is_set(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_HC_PARENT="t1")
        self.assertEqual(code, 0, err)
        self.assertIn("opened under herdr-core: t2 (parent t1)", out)
        self.assertEqual(self.log(self.herdr_log), [])
        entry = self.registry()[0]
        self.assertEqual((entry["status"], entry["backend"], entry["hc"]),
                         ("open", "hc", {"address": "t2", "parent": "t1", "space": None, "tab": None}))
        self.assertNotIn("pane", entry)

    def test_auto_prefers_herdr_over_hc(self):
        code, out, err = self.run_main(*self.open_args(), HERDR_PANE_ID="w1:p1", HERDR_BIN=str(self.herdr))
        self.assertEqual(code, 0, err)
        self.assertIn("opened in Herdr", out)
        self.assertEqual(self.log(self.hc_log), [])
        self.assertNotIn("backend", self.registry()[0])

    def test_auto_without_an_hc_binary_prints_the_command(self):
        code, out, err = self.run_main(*self.open_args(), HC_BIN=str(self.tmp / "missing"))
        self.assertEqual(code, 0, err)
        self.assertIn("Run this in a new terminal", out)
        self.assertEqual(self.registry()[0]["status"], "pending")

    def test_auto_without_a_terminal_id_prints_the_command(self):
        code, out, err = self.run_main(*self.open_args(), HC_TERMINAL_ID="")
        self.assertEqual(code, 0, err)
        self.assertIn("Run this in a new terminal", out)
        self.assertEqual(self.log(self.hc_log), [])

    def test_forced_terminal_ignores_hc(self):
        self.config(backend="terminal")
        code, out, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        self.assertIn("Run this in a new terminal", out)
        self.assertEqual(self.log(self.hc_log), [])

    def test_forced_hc_without_binary_is_refused(self):
        self.config(backend="hc")
        code, out, err = self.run_main(*self.open_args(), HC_BIN=str(self.tmp / "missing"))
        self.assertEqual(code, 1)
        self.assertIn("refused [backend_unavailable]", err)
        self.assertFalse((self.agent / "pi-foreman").exists())

    def test_forced_herdr_without_server_is_refused(self):
        self.config(backend="herdr")
        code, out, err = self.run_main(*self.open_args(), HERDR_BIN=str(self.tmp / "missing"))
        self.assertEqual(code, 1)
        self.assertIn("refused [backend_unavailable]", err)

    def test_forced_hc_without_terminal_id_is_parentless(self):
        self.config(backend="hc")
        code, out, err = self.run_main(*self.open_args(), HC_TERMINAL_ID="")
        self.assertEqual(code, 0, err)
        self.assertIn("not nested: no parent terminal", out)
        self.assertEqual(self.registry()[0]["hc"], {"address": "t2", "parent": None, "space": None, "tab": None})

    def test_forced_hc_wins_over_herdr(self):
        self.config(backend="hc")
        code, out, err = self.run_main(*self.open_args(), HERDR_PANE_ID="w1:p1", HERDR_BIN=str(self.herdr))
        self.assertEqual(code, 0, err)
        self.assertEqual(self.log(self.herdr_log), [])
        self.assertEqual(len(self.run_calls()), 1)

    # ------------------------------------------------------------------ argv

    def test_posix_argv_shape(self):
        code, out, err = self.run_main(*self.open_args("--model", "prov/model-1", "--first-command", "/plan"), platform="linux",
                                         FAKE_HC_PARENT="t1")
        self.assertEqual(code, 0, err)
        call = self.hc_call()
        entry = self.registry()[0]
        handoff = entry["handoff"]
        sep = call.index("--")
        head, tail = call[:sep], call[sep + 1:]
        name = head[head.index("--name") + 1]
        self.assertEqual(head, ["run", "--json", "--bg", "--no-notify", "--keep", "--cwd", str(self.proj), "--name", name, "--outlive-parent"])
        self.assertRegex(name, r"^fm-demo-[0-9a-f]{6}$")
        self.assertEqual(name[-6:], entry["child"][-6:])
        self.assertEqual(tail, [
            "env", "-u", "HERDR_ENV", "-u", "HERDR_PANE_ID", "PATH=" + CALLER_PATH,
            "PI_FOREMAN_HANDOFF_DIR=" + handoff, "PI_FOREMAN_PARENT_INTERCOM=parent-1",
            "PI_INTERCOM_STABLE_ID=" + entry["child"], "PI_FOREMAN_PARENT_LABEL=" + fsn.opener_slug(Path.cwd(), fsn.git_top(Path.cwd())),
            "PI_FOREMAN_SESSION_MODEL=prov/model-1", FAKE_PI, "--model", "prov/model-1", "/plan",
            "Read the handoff brief at %s and proceed." % (Path(handoff) / "brief.md").as_posix()])
        launch = (Path(handoff) / "launch.txt").read_text("utf-8")
        self.assertTrue(launch.startswith("env PI_FOREMAN_HANDOFF_DIR="), launch)

    def test_no_notify_is_always_passed(self):
        for cfg in ({}, {"hc": {"outliveParent": False}}):
            self.hc_log.unlink(missing_ok=True)
            self.config(**cfg)
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
            self.assertIn("--no-notify", self.hc_call())

    def test_outlive_parent_follows_the_config_key(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertIn("--outlive-parent", self.hc_call())
        self.hc_log.unlink()
        self.config(hc={"outliveParent": False})
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        self.assertNotIn("--outlive-parent", self.hc_call())

    def test_win32_argv_uses_powershell_with_the_identity_removed(self):
        code, out, err = self.run_main(*self.open_args(), platform="win32", PATH="C:\\bin;C:\\it's")
        self.assertEqual(code, 0, err)
        call = self.hc_call()
        sep = call.index("--")
        self.assertIn("--no-notify", call[:sep])
        self.assertEqual(call[sep + 1:sep + 4], ["powershell", "-NoProfile", "-Command"])
        self.assertEqual(len(call), sep + 5)
        script = call[-1]
        self.assertTrue(script.startswith("Remove-Item Env:HERDR_ENV,Env:HERDR_PANE_ID -ErrorAction SilentlyContinue; "
                                          "$env:PATH = 'C:\\bin;C:\\it''s'; $env:PI_FOREMAN_HANDOFF_DIR="), script)
        self.assertIn("; pi 'Read the handoff brief at ", script)
        launch = (Path(self.registry()[0]["handoff"]) / "launch.txt").read_text("utf-8")
        self.assertTrue(launch.startswith("$env:PI_FOREMAN_HANDOFF_DIR="), launch)

    def test_name_shape_for_a_long_label(self):
        label = "a" * 40
        code, out, err = self.run_main("open", label, str(self.brief), "--cwd", str(self.proj), "--parent-id", "parent-1")
        self.assertEqual(code, 0, err)
        call = self.hc_call()
        name = call[call.index("--name") + 1]
        self.assertRegex(name, r"^fm-a{22}-[0-9a-f]{6}$")
        self.assertLessEqual(len(name), 32)

    def test_hc_name_is_always_valid(self):
        for slug in ("x", "a-b", "-".join(["seg"] * 20), "s" * 32):
            child = "fm-%s-abcdef" % slug
            self.assertRegex(fsn.hc_name(child), r"^fm-[a-z0-9-]{1,22}-abcdef$")
            self.assertLessEqual(len(fsn.hc_name(child)), 32)

    # ------------------------------------------------------------------ results

    def test_dry_run_prints_the_argv_and_writes_nothing(self):
        code, out, err = self.run_main(*self.open_args("--dry-run"))
        self.assertEqual(code, 0, err)
        self.assertIn("would run under herdr-core", out)
        self.assertIn("--no-notify", out)
        self.assertIn("--keep", out)
        self.assertEqual(self.run_calls(), [])
        self.assertFalse((self.agent / "pi-foreman").exists())

    def test_focus_is_ignored(self):
        code, out, err = self.run_main(*self.open_args("--focus"))
        self.assertEqual(code, 0, err)
        self.assertNotIn("--focus", self.hc_call())

    def test_failure_marks_the_entry_failed_and_prints_the_fallback(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_HC_FAIL="1")
        self.assertEqual(code, 2)
        self.assertIn("boom", err)
        self.assertIn("Run this in a new terminal", out)
        entry = self.registry()[0]
        self.assertEqual(entry["status"], "failed")
        self.assertNotIn("hc", entry)

    def test_output_without_an_address_is_a_failure(self):
        for raw in ("not json", "[]", '{"parent": "t1"}'):
            code, out, err = self.run_main(*self.open_args(), FAKE_HC_RAW=raw)
            self.assertEqual(code, 2, raw)
        self.assertTrue(all(e["status"] == "failed" for e in self.registry()))

    def test_list_shows_the_hc_address(self):
        self.assertEqual(self.run_main(*self.open_args())[0], 0)
        code, out, err = self.run_main("list")
        self.assertEqual(code, 0, err)
        self.assertIn(" hc:t2", out)

    # ------------------------------------------------------------------ helpers

    def test_hc_bin_resolution(self):
        with mock.patch.dict(os.environ, {"HC_BIN": str(self.tmp / "missing")}):
            self.assertIsNone(fsn.hc_bin())
        with mock.patch.dict(os.environ, {"HC_BIN": str(self.hc)}):
            self.assertEqual(fsn.hc_bin(), str(self.hc))
        with mock.patch.dict(os.environ, {"PATH": str(self.bindir)}):
            os.environ.pop("HC_BIN", None)
            self.assertTrue(fsn.hc_bin())

    def test_invalid_backend_value_falls_back_to_auto(self):
        with mock.patch.dict(os.environ, {"HC_BIN": str(self.hc)}):
            self.assertEqual(fsn.backend_of({"backend": "nonsense"}, {"HC_TERMINAL_ID": "t1"}), ("hc", str(self.hc)))
            self.assertEqual(fsn.backend_of({}, {})[0], "terminal")

    # ------------------------------------------------------------------ keep and own tab

    LABELS = json.dumps({"herdr.space": "sp_1", "herdr.tab": "tbparent"})

    def test_keep_is_always_passed(self):
        for cfg in ({}, {"hc": {"outliveParent": False}}):
            self.hc_log.unlink(missing_ok=True)
            self.config(**cfg)
            self.assertEqual(self.run_main(*self.open_args())[0], 0)
            self.assertIn("--keep", self.hc_call())

    def test_run_args_with_and_without_labels(self):
        plain = fsn.hc_run_args("n", "/w", ["x"], False)
        self.assertEqual(plain, ["run", "--json", "--bg", "--no-notify", "--keep", "--cwd", "/w", "--name", "n", "--", "x"])
        labelled = fsn.hc_run_args("n", "/w", ["x"], True, "sp", "tb1")
        self.assertEqual(labelled, ["run", "--json", "--bg", "--no-notify", "--keep", "--cwd", "/w", "--name", "n",
                                    "--outlive-parent", "--label", "herdr.space=sp", "--label", "herdr.tab=tb1", "--", "x"])

    def test_space_label_gives_the_child_its_own_tab(self):
        code, out, err = self.run_main(*self.open_args(), FAKE_HC_LABELS=self.LABELS)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.log(self.hc_log)[0], ["get", "t1", "--json"])
        call = self.hc_call()
        sep = call.index("--")
        self.assertEqual(call[sep - 4], "--label")
        self.assertEqual(call[sep - 3], "herdr.space=sp_1")
        tab = call[sep - 1].split("=", 1)[1]
        self.assertEqual(call[sep - 2:sep - 1], ["--label"])
        self.assertRegex(tab, r"^tb[0-9a-f]{32}$")
        self.assertEqual(self.registry()[0]["hc"], {"address": "t2", "parent": None, "space": "sp_1", "tab": tab})

    def test_dry_run_shows_the_labels(self):
        code, out, err = self.run_main(*self.open_args("--dry-run"), FAKE_HC_LABELS=self.LABELS)
        self.assertEqual(code, 0, err)
        self.assertIn("herdr.space=sp_1", out)
        self.assertIn("herdr.tab=tb", out)
        self.assertEqual(self.run_calls(), [])

    def test_no_labels_when_the_lookup_gives_nothing(self):
        cases = {"hc failure": {"FAKE_HC_FAIL": "1"}, "no label": {"FAKE_HC_LABELS": json.dumps({"where": "x"})},
                 "invalid value": {"FAKE_HC_LABELS": json.dumps({"herdr.space": "a b;c"})},
                 "non-string value": {"FAKE_HC_LABELS": json.dumps({"herdr.space": 5})},
                 "no terminal id": {"HC_TERMINAL_ID": "", "FAKE_HC_LABELS": self.LABELS}}
        self.config(backend="hc")
        for name, env in cases.items():
            self.hc_log.unlink(missing_ok=True)
            code, out, err = self.run_main(*self.open_args("--dry-run"), **env)
            self.assertEqual(code, 0, (name, err))
            self.assertNotIn("--label", out, name)
            self.assertIn("--keep", out, name)

    def test_parent_space_never_raises(self):
        self.assertIsNone(fsn.hc_parent_space(str(self.hc), None))
        self.assertIsNone(fsn.hc_parent_space(str(self.hc), "bad id"))
        self.assertIsNone(fsn.hc_parent_space(str(self.tmp / "missing"), "t1"))


if __name__ == "__main__":
    unittest.main()
