"""The shared shellvars cases (tests/fixtures/shellvars-cases.json, ledger item 7d); shellvars-cases.test.ts reads them too."""
from __future__ import annotations

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import shell_write_guard as swg  # noqa: E402

with open(os.path.join(os.path.dirname(__file__), "fixtures", "shellvars-cases.json")) as f:
    FX = json.load(f)


class ShellVarsCasesTest(unittest.TestCase):
    def test_grammar_membership_and_the_resolved_word_of_the_last_command(self):
        for c in FX["cases"]:
            with self.subTest(line=c["line"]):
                self.assertEqual(swg.Lexer(c["line"], FX["cwd"], FX["scratch"]).eligible, c["inGrammar"])
                if not c["inGrammar"]:
                    continue
                items = swg.tokenize(c["line"], FX["cwd"], FX["scratch"])
                cmds = [i for i in items if i not in ("(", ")") and i.words and i.words[0].text in swg.GRAMMAR_COMMANDS]
                last = cmds[-1]
                words = [w for _, w in last.redirs] + list(last.words)
                if c["lastWord"] is None:
                    self.assertTrue(any(w.dynamic for w in words), [w.text for w in words])
                else:
                    self.assertIn(c["lastWord"], [w.text for w in words])

    def test_a_tracked_cwd_follows_cd_and_pwd_needs_it(self):
        self.assertEqual(swg.grammar_value("$PWD/x", "/a", None), "/a/x")
        self.assertIsNone(swg.grammar_value("$PWD/x", None, None))
        self.assertIsNone(swg.grammar_value("$PWDX", "/a", None))
        self.assertEqual(swg.grammar_value("$FOREMAN_SCRATCH", None, "/s"), "/s")
        self.assertIsNone(swg.grammar_value("$HOME/x", "/a", "/s"))


if __name__ == "__main__":
    unittest.main()
