"""`foreman backlog` is retired: it prints one pointer line to `foreman reports` and exits 2; it is not a listed subcommand."""
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POINTER = "foreman backlog is retired: use foreman reports (list|show|set|expire|migrate)"


class BacklogRetired(unittest.TestCase):
    def test_sh_wrapper_points_to_reports(self):
        r = subprocess.run(["sh", str(ROOT / "bin" / "foreman"), "backlog", "list"], capture_output=True, text=True, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stderr.strip(), POINTER)

    def test_other_wrappers_carry_the_same_pointer(self):
        for name in ("foreman.ps1", "foreman.cmd"):
            src = (ROOT / "bin" / name).read_text(encoding="utf-8").replace("^", "")
            self.assertIn(POINTER, src, name)

    def test_usage_lists_do_not_name_it(self):
        for name in ("foreman", "foreman.ps1", "foreman.cmd"):
            usage = re.findall(r"usage: foreman setup[^'\"\n]*", (ROOT / "bin" / name).read_text(encoding="utf-8"))
            self.assertTrue(usage, name)
            self.assertFalse([u for u in usage if "backlog" in u], name)


if __name__ == "__main__":
    unittest.main()
