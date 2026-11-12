"""shell_write_guard.py: a line that uses a same-line relative or quoted value is allowed only when every write on it
lands in an always-writable place, unless the line was already allowed without resolving the value (the main
behaviour). The property test below needs no copy of main: the guard's first pass (the local step off) is main's
verdict, whichever quoted values main resolves on the platform. Strings are only parsed, nothing runs."""
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402

def fwd(path):
    """Forward slashes: a `\\` in an unquoted word is eaten by the shell lexer, so a path in a command is written the way bash reads it."""
    return path.replace("\\", "/")


# (line after the assignment `D=VALUE; `, how the writes resolve, path parts below the value, base override)
#   phys: realpath(value/parts) (the kernel follows a symlink before a `..`)
#   lex: a `cd` chain is lexical (bash keeps the logical cwd), then the file name
#   cdphys: `cd $D` then a relative operand with `..` (the kernel starts at the real cwd)
FORMS = [
    ('echo x >> "$D/f"', "phys", ("f",), None), ('echo x 2>> "$D/f"', "phys", ("f",), None),
    ('echo x &>> "$D/f"', "phys", ("f",), None), ('echo x | tee "$D/f"', "phys", ("f",), None),
    ('echo x >> "$D/../../f"', "phys", ("..", "..", "f"), None),
    ('cp a "$D/f"', "phys", ("f",), None), ('cp a "$D/../../f"', "phys", ("..", "..", "f"), None),
    ('cp -t "$D" a', "phys", ("a",), None), ("cp -t$D a", "phys", ("a",), None), ("cp -rt$D a", "phys", ("a",), None),
    ("cp -at$D a", "phys", ("a",), None), ("cp a b -t$D", "phys", ("a",), None),
    ("cp --target-directory=$D a", "phys", ("a",), None), ("cp --target-directory=$D/x a", "phys", ("x", "a"), None),
    ("cp -t$D/../.. a", "phys", ("..", "..", "a"), None),
    ('mv a "$D/f"', "phys", ("f",), None), ('mv -t "$D" .workflow/a', "phys", ("a",), None),
    ("mv -t$D .workflow/a", "phys", ("a",), None), ("mv --target-directory=$D .workflow/a", "phys", ("a",), None),
    ("mv --target-directory=$D/x .workflow/a", "phys", ("x", "a"), None),
    ('touch "$D/f"', "phys", ("f",), None), ('touch "$D/../../f"', "phys", ("..", "..", "f"), None),
    ('ln -s a "$D/f"', "phys", ("f",), None), ('install a "$D/f"', "phys", ("f",), None),
    ('sed -i s/a/b/ "$D/f"', "phys", ("f",), None),
    ('tar -xf a.tar -C "$D"', "phys", ("f",), None), ("tar -xf a.tar -C$D", "phys", ("f",), None),
    ("tar -xf a.tar --directory=$D", "phys", ("f",), None), ("tar -xf a.tar -C$D/../..", "phys", ("..", "..", "f"), None),
    ('unzip a.zip -d "$D"', "phys", ("f",), None),
    ('git -C "$D" checkout -- x', "phys", ("x",), None), ("git -C$D checkout -- x", "phys", ("x",), None),
    ("git --work-tree=$D checkout -- x", "phys", ("x",), None), ('env -C "$D" touch f', "phys", ("f",), None),
    ('patch -d "$D" -p1', "phys", ("f",), None),
    ('cd "$D"; touch f', "lex", ("f",), None), ("cd $D; cd ..; touch f", "lex", ("..", "f"), None),
    ("cd $D; cd ..; cd ..; touch f", "lex", ("..", "..", "f"), None), ("cd $D; touch ../../f", "cdphys", ("..", "..", "f"), None),
    ("pushd $D; touch f", "lex", ("f",), None), ("(cd $D; touch f)", "lex", ("f",), None),
    ("D=..; cp -t$D a", "phys", ("a",), ".."), ("E=$D; cp -t$E a", "phys", ("a",), None),
    ('E=$D; echo x > "$E/../../f"', "phys", ("..", "..", "f"), None),
]
VALUES = ["..", ".", "../../.ssh", "x/../..", ".workflow", ".workflow/closed", ".workflow/..", "src",
          "OUTSIDE", "OUTSIDE_BLANK", "HANDOFF", ".workflow/link"]


class ShellWriteVarsMatrixTest(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wm-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        for d in (".workflow/closed", "src"):
            os.makedirs(os.path.join(self.ws, d))
        self.hand = os.path.join(self.ws, "agent dir", "handoffs", "h1")
        os.makedirs(self.hand)
        self.scratch = os.path.join(self.ws, "scratch")
        os.makedirs(self.scratch)
        self.outside = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wm-out-"))
        self.addCleanup(shutil.rmtree, self.outside, True)
        os.makedirs(os.path.join(self.outside, "a b"))
        self.linked = True
        try:
            os.symlink(self.outside, os.path.join(self.ws, ".workflow", "link"))
        except (OSError, NotImplementedError):
            self.linked = False

    def decide(self, cmd):
        return swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], self.scratch, [], self.hand)

    def allowed(self, cmd):
        self.assertIsNone(self.decide(cmd), cmd)

    def refused(self, cmd):
        self.assertIsNotNone(self.decide(cmd), cmd)

    def value(self, name):
        """(the text of the assignment value, the value as a path)."""
        if name == "OUTSIDE":
            return '"%s"' % fwd(self.outside), self.outside
        if name == "OUTSIDE_BLANK":
            return '"%s/a b"' % fwd(self.outside), self.outside + "/a b"
        if name == "HANDOFF":
            return '"%s"' % fwd(self.hand), self.hand
        return name, os.path.join(self.ws, name)

    def writable(self, p):
        """p (a real path) lies in an always-writable place: below .workflow/ or the scratch dir, a child-written name of the handoff dir."""
        for root in (os.path.join(self.ws, ".workflow"), self.scratch):
            if p.startswith(root + os.sep):
                return True
        if os.path.dirname(p) == self.hand and os.path.basename(p) in swg.HANDOFF_CHILD_NAMES:
            return True
        return p.startswith(os.path.join(self.hand, "work") + os.sep)

    def lands_writable(self, form, base):
        _, mode, parts, override = form
        if override is not None:
            base = os.path.join(self.ws, override)
        if mode == "phys":
            return self.writable(os.path.realpath(os.path.join(base, *parts)))
        if mode == "lex":
            return self.writable(os.path.realpath(os.path.normpath(os.path.join(base, *parts))))
        return self.writable(os.path.realpath(os.path.join(os.path.realpath(os.path.normpath(base)), *parts)))

    def lines(self):
        """(line, whether every write lands in an always-writable place)."""
        for name in VALUES:
            if name.endswith("link") and not self.linked:
                continue
            text, base = self.value(name)
            for form in FORMS:
                writes_ok = self.lands_writable(form, base)
                for sep in ("; ", ";", " && "):
                    yield ("D=%s; %s" % (text, form[0])).replace("; ", sep), writes_ok

    def test_an_allowed_line_is_a_main_allow_or_writes_only_to_always_writable_places(self):
        total = allowed = 0
        for line, writes_ok in self.lines():
            total += 1
            if self.decide(line) is not None:
                continue
            allowed += 1
            with self.subTest(line=line):
                self.assertTrue(writes_ok or self.main_allows(line), line)
        self.assertGreater(total, 1000)
        self.assertGreater(allowed, 50)   # the writable places do resolve

    def main_allows(self, cmd):
        """The line analysed with the local step off: what main decides."""
        try:
            swg.Analyzer(swg.Scope(self.ws, [".workflow"], self.scratch, [], self.hand)).text(cmd, self.ws, 0)
        except (swg.Found, swg.Unreadable):
            return False
        return True

    def loose_flags(self, cmd):
        """(handoff, unresolved) of the line analysed with the local step on and the scope not strict."""
        def refused(ignore_handoff, ignore_unresolved):
            scope = swg.Scope(self.ws, [".workflow"], self.scratch, [], self.hand)
            scope.local = True
            scope.ignore_handoff = ignore_handoff
            scope.ignore_unresolved = ignore_unresolved
            try:
                swg.Analyzer(scope).text(cmd, self.ws, 0)
            except (swg.Found, swg.Unreadable):
                return True
            return False
        return not refused(True, False), not refused(False, True)

    def test_the_flags_of_a_refused_line_are_those_of_the_non_strict_analysis(self):
        checked = 0
        for line, _ in self.lines():
            hit = self.decide(line)
            if hit is None:
                continue
            checked += 1
            with self.subTest(line=line):
                self.assertEqual((hit.handoff, hit.unresolved), self.loose_flags(line), line)
        self.assertGreater(checked, 1000)

    def test_a_harmless_assignment_does_not_change_the_flags(self):
        for tail in ("echo x >> /tmp/x", "cp a ../sibling/x", "git -C /tmp checkout x"):
            for pre in ("", "D=.workflow; "):
                with self.subTest(pre=pre, tail=tail):
                    hit = self.decide('%secho y >> "$V"; %s' % (pre, tail))
                    self.assertTrue(hit.unresolved)
        hand = os.path.join(self.outside, "handoffs", "h1")   # outside the workspace, so that setting it aside leaves no project file
        os.makedirs(hand)
        lit = swg.decide('echo x >> "%s/brief.md"; echo y >> /tmp/x' % hand, self.ws, self.ws, "bash", [".workflow"], self.scratch, [], hand)
        var = swg.decide('H="%s"; echo x >> "$H/brief.md"; echo y >> /tmp/x' % hand, self.ws, self.ws, "bash", [".workflow"], self.scratch, [], hand)
        self.assertTrue(lit.handoff)
        self.assertEqual((var.handoff, var.unresolved), (lit.handoff, lit.unresolved))

    def test_a_project_file_on_the_line_still_raises_the_tier(self):
        for line in ('D=src; echo x >> "$D/f"', 'D=.workflow; echo x >> "$D/a"; echo y >> README.md'):
            hit = self.decide(line)
            self.assertFalse(hit.unresolved, line)
            self.assertFalse(hit.handoff, line)

    def test_an_outside_value_is_refused_by_its_resolved_target_without_the_unresolved_claim(self):
        for line, target in (('D=..; echo x >> "$D/f"', "../f"), ("D=../../.ssh; cp -t$D a", "../../.ssh")):
            hit = self.decide(line)
            self.assertEqual(tuple(hit)[1], target)
            self.assertNotIn("unresolved", tuple(hit)[1])
            self.assertTrue(hit.unresolved)   # the flag key keeps its name: no project file is written, no tier raise

    def test_the_lines_the_review_listed_stay_refused(self):
        lines = ["D=../../.ssh; cp -t$D authorized_keys", "D=../../.aws; cp --target-directory=$D credentials",
                 "D=..; cp -t$D a", "D=..; cp -rt$D a", "D=..; cp -at$D a", "D=..; cp a b -t$D", "D=..; cp --target-directory=$D/x a",
                 "D=..; mv -t$D .workflow/a", "D=..; mv --target-directory=$D .workflow/a", "D=..; tar -xf a.tar -C$D",
                 "D=..; tar -xf a.tar --directory=$D", "D=..; tar --extract --file=a.tar --directory=$D",
                 "D=x/../..; cp -t$D a", "D=.workflow; cp -t$D/../.. a", "D=.workflow; tar -xf a.tar -C$D/../..",
                 "D=.workflow; D=..; cp -t$D a", "D=.workflow; cd $D; cd ..; cd ..; touch f", "D=.; cd $D; cd ..; touch f",
                 "D=.workflow; cd $D; touch ../../f", "D=.workflow; cd $D; cd ..; touch f"]
        for line in lines:
            for sep in ("; ", ";", " && "):
                with self.subTest(line=line, sep=sep):
                    self.refused(line.replace("; ", sep))

    def test_the_writable_places_stay_allowed(self):
        self.allowed('D=.workflow/closed; cp x "$D/y"')
        self.allowed('D=.workflow/closed; cd "$D"; touch f')
        self.allowed('H="%s"; echo x > "$H/result.md"' % self.hand)
        self.allowed("D=.workflow/closed; cp -t$D a")
        self.allowed("D=.workflow/closed; tar -xf a.tar -C$D")
        self.refused('H="%s"; echo x > "$H/brief.md"' % self.hand)
        self.refused("D=.workflow; D=src; cp -t$D a")
        self.refused('D=.workflow; cd "$D/../src"; touch f')

    def test_a_line_mixing_a_writable_value_and_a_literal_write_outside_is_not_looser_than_main(self):
        # main refuses it (`$D` stays unresolved there); the head must refuse it too: the literal write is judged
        # strictly while the line uses a local value
        line = 'D=.workflow; touch "$D/a"; touch %s/x' % fwd(self.outside)
        self.refused(line)
        self.allowed("touch %s/x" % fwd(self.outside))   # alone it is allowed as on main

    def test_a_symlinked_prefix_stays_refused(self):
        if not self.linked:
            self.skipTest("symlinks unavailable")
        for line in ('D=.workflow/link; touch "$D/f"', "D=.workflow/link; cp -t$D a", "D=.workflow/link; cd $D; touch f"):
            self.refused(line)


if __name__ == "__main__":
    unittest.main()
