"""shell_write_guard.py on Windows (ledger r8 item 6): the variable grammar also resolves an unquoted `X:/...` and a
double-quoted `"X:\\..."` value (Git Bash keeps the `\\` there); an unquoted `X:\\x` (drive-relative to bash) never resolves.
Simulated on every host by patching the module's `_NT` flag; decisions over command STRINGS only, nothing is run."""
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402


def known(line, name):
    """The value the lexer resolved for `$name` in the last command of `line` (its last word), or None."""
    lx = swg.Lexer(line)
    lx.run()
    return lx.vars.get(name)


class NtGrammarTest(unittest.TestCase):
    def test_H_C_slash_resolves_on_nt(self):
        with mock.patch.object(swg, "_NT", True):
            for line, value in (('H=C:/Users/RUNNER~1/h; cp plan.md "$H/plan.md"', "C:/Users/RUNNER~1/h"),
                                ('H="C:\\Users\\RUNNER~1\\h"; cp plan.md "$H/plan.md"', "C:\\Users\\RUNNER~1\\h"),
                                ("H=C:/a/h && mkdir -p ${H}/x", "C:/a/h")):
                with self.subTest(line=line):
                    self.assertIsNotNone(swg.grammar_statements(line))
                    self.assertEqual(known(line, "H"), value)
            self.assertEqual(swg.grammar_value("C:/a"), "C:/a")
            self.assertEqual(swg.grammar_value("C:\\a"), "C:\\a")

    def test_H_C_backslash_unquoted_stays_unresolved_on_nt(self):
        with mock.patch.object(swg, "_NT", True):
            # a trailing `\` escapes the closing quote: the line is unreadable (refused)
            self.assertIsNone(swg.grammar_statements('H="C:\\a\\"; cp f $H'))
            self.assertRaises(swg.Unreadable, known, 'H="C:\\a\\"; cp f $H', "H")
            for line in ("H=C:\\a\\h; cp plan.md $H/plan.md", "H=C:x; cp plan.md $H/plan.md", 'H="C:x"; cp f $H',
                         "H=C:/a~b; cp f $H", "H=C:/~1; cp f $H", "H='C:\\a'; cp f $H"):
                with self.subTest(line=line):
                    self.assertIsNone(swg.grammar_statements(line))
                    self.assertIsNone(known(line, "H"))
            self.assertIsNone(swg.grammar_value("C:x"))

    def test_H_C_slash_stays_unresolved_off_nt(self):
        with mock.patch.object(swg, "_NT", False):
            for line in ('H=C:/a/h; cp plan.md "$H/plan.md"', 'H="C:\\a\\h"; cp plan.md "$H/plan.md"'):
                with self.subTest(line=line):
                    self.assertIsNone(swg.grammar_statements(line))
                    self.assertIsNone(known(line, "H"))
            self.assertIsNone(swg.grammar_value("C:/a"))


if __name__ == "__main__":
    unittest.main()
