"""Report tools (docs/retro.md#reporting-at-the-source): the `retro.report` key, the role tool lists, the deferred and child-denied sets, the features row and the `foreman reports` wrappers."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


def read(*parts):
    return (ROOT.joinpath(*parts)).read_text(encoding="utf-8")


class ReportConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()
        self.project = Path(self.tmp.name) / "proj"
        (self.project / ".pi").mkdir(parents=True)
        old = os.environ.get("PI_CODING_AGENT_DIR")
        os.environ["PI_CODING_AGENT_DIR"] = str(self.agent)
        self.addCleanup(lambda: os.environ.pop("PI_CODING_AGENT_DIR", None) if old is None else os.environ.update(PI_CODING_AGENT_DIR=old))

    def load(self, user=None):
        if user is not None:
            (self.agent / "foreman.json").write_text(json.dumps(user))
        return fc.load_config(project_dir=str(self.project))

    def test_key_in_schema_and_defaults(self):
        schema = json.loads(read("config", "foreman.schema.json"))
        self.assertEqual(schema["properties"]["retro"]["properties"]["report"]["type"], "boolean")
        self.assertIs(json.loads(read("config", "foreman.defaults.json"))["retro"]["report"], True)

    def test_false_validates_and_a_non_boolean_does_not(self):
        res = self.load({"retro": {"report": False}})
        self.assertEqual(res["errors"], [])
        self.assertIs(res["config"]["retro"]["report"], False)
        self.assertNotEqual(self.load({"retro": {"report": "no"}})["errors"], [])

    def test_report_tool_for_every_role_and_reports_tool_for_none(self):
        cfg = self.load({})["config"]
        for role in fc.CHILD_ROLES:
            self.assertIn("foreman_report", fc.role_allowlist(cfg, role), role)
            self.assertNotIn("foreman_reports", fc.role_allowlist(cfg, role), role)
        self.assertIn("foreman_reports", fc.CHILD_DENIED_TOOLS)
        self.assertIn("foreman_reports", cfg["tools"]["deferred"])
        self.assertNotIn("foreman_report", cfg["tools"]["deferred"])

    def test_report_off_takes_the_tool_from_every_role(self):
        cfg = self.load({"retro": {"report": False}})["config"]
        for role in fc.CHILD_ROLES:
            self.assertNotIn("foreman_report", fc.role_allowlist(cfg, role), role)

    def test_agent_files_list_the_tool_and_keep_the_friction_line(self):
        for name in ("builder", "explorer", "reviewer"):
            text = read("agents", f"{name}.md")
            tools = [l for l in text.splitlines() if l.startswith("tools:")][0]
            self.assertIn("foreman_report", tools, name)
            self.assertIn("foreman_report", text.split("---", 2)[2], name)
        self.assertIn("6. Friction: <what blocked, retried, or was missing", read("agents", "builder.md"))

    def test_features_row_and_docs(self):
        feats = json.loads(read("config", "features.json"))
        text = json.dumps(feats)
        self.assertIn("retro.report", text)
        self.assertIn("foreman reports", text)
        self.assertIn("foreman_report", read("docs", "tools.md"))
        self.assertIn("foreman_reports", read("docs", "tools.md"))
        self.assertIn("Reporting at the source", read("docs", "retro.md"))
        self.assertIn("retro.report", read("docs", "features.md"))


@unittest.skipIf(os.name == "nt" or not shutil.which("node"), "needs sh and node")
class ReportsWrappers(unittest.TestCase):
    def run_cli(self, cwd, *args):
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(cwd))
        return subprocess.run([str(ROOT / "bin" / "foreman"), "reports", *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

    def test_posix_wrapper_runs_the_cli(self):
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            r = self.run_cli(d, "list")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("no entries", r.stdout)
            bad = self.run_cli(d, "import")
            self.assertEqual(bad.returncode, 2)
            self.assertIn("usage: foreman reports list", bad.stderr)
            self.assertEqual(self.run_cli(d, "show", "ffffffffffff").returncode, 1)


class ReportsWrapperText(unittest.TestCase):
    def test_posix(self):
        src = read("bin", "foreman")
        self.assertIn('if [ "$sub" = "reports" ]', src)
        self.assertIn("extensions/core-adapter/reports-cli.ts", src)
        self.assertIn("foreman reports needs Node >= 22.6", src)

    def test_cmd_passes_every_argument(self):
        src = read("bin", "foreman.cmd")
        self.assertIn('if /i "%~1"=="reports" goto reports', src)
        body = src.split(":reports\n", 1)[1].split(":runreports", 1)[0]
        self.assertIn("set PF_ARGS=%PF_ARGS% %1", body)
        self.assertIn("reports-cli.ts", src.split(":runreports", 1)[1])

    def test_ps1(self):
        body = read("bin", "foreman.ps1").split("$sub -eq 'reports'", 1)[1].split("\n}", 1)[0]
        self.assertIn("reports-cli.ts", body)
        self.assertIn("@rest", body)

    def test_no_migrate_or_import(self):
        for name in ("foreman", "foreman.cmd", "foreman.ps1"):
            src = read("bin", name)
            self.assertNotIn("reports migrate", src)
            self.assertNotIn("reports import", src)


if __name__ == "__main__":
    unittest.main()
