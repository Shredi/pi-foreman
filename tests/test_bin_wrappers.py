"""bin/foreman, foreman.ps1 and foreman.cmd expose the same subcommands."""
import re
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
