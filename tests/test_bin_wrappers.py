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
