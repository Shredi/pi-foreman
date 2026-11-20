"""bin/foreman, foreman.ps1 and foreman.cmd expose the same subcommands."""
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from foreman_docs import bin_subcommands  # noqa: E402

USAGE = re.compile(r"foreman ([a-z|-]+) \[args\]")


def text(name):
    return (ROOT / "bin" / name).read_text(encoding="utf-8")


def usage_lists(src):
    return {tuple(m.split("|")) for m in USAGE.findall(src.replace("^|", "|"))}


class BinWrappers(unittest.TestCase):
    def test_ps1_subcommands(self):
        src = text("foreman.ps1")
        names = set(re.findall(r"^\s+'([a-z-]+)' \{", src, re.M))
        names |= set(re.findall(r"\$sub -eq '([a-z-]+)'", src))
        self.assertEqual(names, bin_subcommands())

    def test_cmd_subcommands(self):
        src = text("foreman.cmd")
        names = set(re.findall(r'if /i "%~1"=="([a-z-]+)"', src))
        self.assertEqual(names, bin_subcommands())

    def test_cmd_fallback_arms(self):
        """The retired-backlog arm (written with `equ`, invisible to the `==` regex) and the usage arm."""
        lines = text("foreman.cmd").splitlines()
        backlog = [l for l in lines if 'if /i "%~1" equ "backlog"' in l]
        self.assertEqual(len(backlog), 1)
        self.assertIn("foreman backlog is retired: use foreman reports", backlog[0])
        self.assertTrue(backlog[0].rstrip().endswith("exit /b 2)"))
        usage = [l for l in lines if l.startswith("if not defined PF_SCRIPT (echo usage: foreman ")]
        self.assertEqual(len(usage), 1)
        self.assertIn("[args] 1>&2", usage[0])
        self.assertTrue(usage[0].rstrip().endswith("exit /b 2)"))

    @unittest.skipUnless(os.name == "nt", "runs foreman.cmd")
    def test_cmd_fallback_arms_run(self):
        cmd = str(ROOT / "bin" / "foreman.cmd")
        r = subprocess.run([cmd, "nope"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("usage: foreman setup|update-check", r.stderr)
        r = subprocess.run([cmd, "backlog"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertIn("foreman backlog is retired: use foreman reports (list|show|set|expire|migrate)", r.stderr)

    def test_usage_lists_agree(self):
        expected = {tuple(sorted(bin_subcommands()))}
        for name in ("foreman", "foreman.ps1", "foreman.cmd"):
            found = usage_lists(text(name))
            self.assertTrue(found, name)
            self.assertEqual({tuple(sorted(f)) for f in found}, expected, name)


class PrsDispatch(unittest.TestCase):
    """`foreman prs poll` runs extensions/core-adapter/prs-cli.ts behind the Node >= 22.6 gate in all three wrappers."""

    def test_posix_wrapper(self):
        src = text("foreman")
        self.assertRegex(src, r'if \[ "\$sub" = "prs" \]')
        self.assertIn("extensions/core-adapter/prs-cli.ts", src)
        self.assertIn("foreman prs needs Node >= 22.6", src)

    def test_cmd_wrapper_passes_every_argument(self):
        src = text("foreman.cmd")
        self.assertIn('if /i "%~1"=="prs" goto prs', src)
        body = src.split(":prs\n", 1)[1].split(":setup\n", 1)[0]
        self.assertIn("prs-cli.ts", body)
        self.assertIn("set PF_ARGS=%PF_ARGS% %1", body)
        self.assertNotIn('"%~2"', body)

    def test_ps1_wrapper(self):
        src = text("foreman.ps1")
        self.assertIn("$sub -eq 'prs'", src)
        self.assertIn("prs-cli.ts", src)
        self.assertIn("@rest", src.split("$sub -eq 'prs'", 1)[1].split("$sub -eq 'dialogs'", 1)[0])

    @unittest.skipIf(os.name == "nt" or not shutil.which("node"), "needs sh and node")
    def test_posix_usage_exit_codes(self):
        for args in (["prs"], ["prs", "nope"], ["prs", "poll", "--jsn"]):
            r = subprocess.run([str(ROOT / "bin" / "foreman")] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(r.returncode, 2, args)
            self.assertIn("usage: foreman prs poll [--json]", r.stderr)


class RoundsDispatch(unittest.TestCase):
    """`foreman rounds` runs extensions/core-adapter/rounds-cli.ts behind the Node >= 22.6 gate in all three wrappers."""

    def test_posix_wrapper(self):
        src = text("foreman")
        self.assertRegex(src, r'if \[ "\$sub" = "rounds" \]')
        self.assertIn("extensions/core-adapter/rounds-cli.ts", src)
        self.assertIn("foreman rounds needs Node >= 22.6", src)

    def test_cmd_wrapper_passes_every_argument(self):
        src = text("foreman.cmd")
        self.assertIn('if /i "%~1"=="rounds" goto rounds', src)
        body = src.split(":rounds\n", 1)[1].split(":paneresume\n", 1)[0]
        self.assertIn("rounds-cli.ts", body)
        self.assertIn("set PF_ARGS=%PF_ARGS% %1", body)
        self.assertNotIn('"%~2"', body)

    def test_ps1_wrapper(self):
        src = text("foreman.ps1")
        self.assertIn("$sub -eq 'rounds'", src)
        body = src.split("$sub -eq 'rounds'", 1)[1].split("$sub -eq 'dialogs'", 1)[0]
        self.assertIn("rounds-cli.ts", body)
        self.assertIn("@rest", body)

    @unittest.skipIf(os.name == "nt" or not shutil.which("node"), "needs sh and node")
    def test_posix_usage_exit_codes(self):
        for args in (["rounds", "nope"], ["rounds", "--pr", "x"], ["rounds", "--since"]):
            r = subprocess.run([str(ROOT / "bin" / "foreman")] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertEqual(r.returncode, 2, args)
            self.assertIn("usage: foreman rounds [--workspace here|KEY]", r.stderr)

    @unittest.skipIf(os.name == "nt" or not shutil.which("node"), "needs sh and node")
    def test_posix_json_on_an_empty_store(self):
        import tempfile
        with tempfile.TemporaryDirectory() as agent:
            env = dict(os.environ, PI_CODING_AGENT_DIR=agent)
            r = subprocess.run([str(ROOT / "bin" / "foreman"), "rounds", "--json"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            self.assertEqual((r.returncode, r.stdout.strip()), (0, "[]"), r.stderr)
