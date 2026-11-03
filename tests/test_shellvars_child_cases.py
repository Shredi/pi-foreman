"""A7: child-only single literal assignment substitution in git_guard.py (tests/fixtures/shellvars-child-cases.json; the TS test reads it too)."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import git_guard as gg  # noqa: E402

with open(os.path.join(os.path.dirname(__file__), "fixtures", "shellvars-child-cases.json")) as f:
    FX = json.load(f)


@unittest.skipIf(os.name == "nt", "POSIX paths")
class ShellVarsChildCasesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.scratch = os.path.join(self.tmp, "pi-foreman-scratch", "s1", "L1")
        os.makedirs(self.scratch)

    def probe(self, line, mode, env):
        ctx = gg.Ctx(mode, self.tmp, {}, env)
        ctx.root = (line, "bash")
        seg = next(s for s in gg.lex(line, "bash").segs if s.words and s.words[0].raw == "probe")
        w = seg.words[1]
        return gg.child_scratch_word(w, ctx, seg) if w.dynamic else None

    def test_child_fixture_cases(self):
        for c in FX["cases"]:
            with self.subTest(line=c["line"]):
                want = None if c["resolved"] is None else c["resolved"].replace("@SCRATCH@", self.scratch)
                got = self.probe(c["line"].replace("@SCRATCH@", self.scratch), "child", {"FOREMAN_SCRATCH": self.scratch})
                self.assertEqual(got, want)

    def test_no_child_scratch_binding_substitutes_nothing(self):
        for c in FX["cases"]:
            with self.subTest(line=c["line"]):
                self.assertIsNone(self.probe(c["line"].replace("@SCRATCH@", self.scratch), "child", {}))
                self.assertIsNone(self.probe(c["line"].replace("@SCRATCH@", self.scratch), "owner", {"FOREMAN_SCRATCH": self.scratch}))

    def test_stdin_write_exception_only_inside_the_own_scratch(self):
        def level(cmd):
            return gg.decide(cmd, "child", cwd=self.tmp, env={"FOREMAN_SCRATCH": self.scratch}).level
        ok = "S=$FOREMAN_SCRATCH; cat > $S/m.txt <<EOF\nhi\nEOF"
        self.assertEqual(level(ok), 0)
        self.assertEqual(level("cat > $FOREMAN_SCRATCH/m.txt <<EOF\nhi\nEOF"), 0)
        self.assertEqual(level("S=$FOREMAN_SCRATCH; echo | tee $S/a <<EOF\nhi\nEOF"), 0)
        for bad in ("cat > /etc/x <<EOF\nhi\nEOF", "S=/etc; cat > $S/m.txt <<EOF\nhi\nEOF",
                    "S=$FOREMAN_SCRATCH; S=/etc; cat > $S/m.txt <<EOF\nhi\nEOF", "cat > $FOREMAN_SCRATCH/../x <<EOF\nhi\nEOF"):
            self.assertEqual(level(bad), 2, bad)


if __name__ == "__main__":
    unittest.main()
