"""shell_write_guard.py: variables in write targets. A same-line literal assignment (relative or quoted values
included) resolves and the resolved path is judged like the literal one; everything else stays refused, and a
refusal caused only by unresolvable targets says so (`unresolved`). Strings are only parsed, nothing runs."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "shell_write_guard.py"
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402


def fwd(path):
    """Forward slashes: Git Bash keeps a `\\` inside a quoted value, so an absolute value is written the way bash reads it."""
    return path.replace("\\", "/")


class ShellWriteVarsTest(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wv-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        for d in (".workflow/closed", "src", "docs"):
            os.makedirs(os.path.join(self.ws, d))
        self.hand = fwd(os.path.join(self.ws, "agent dir", "handoffs", "h1"))
        os.makedirs(self.hand)
        self.scratch = fwd(os.path.join(self.ws, "scratch"))
        os.makedirs(self.scratch)
        self.outside = fwd(os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wv-out-")))
        self.addCleanup(shutil.rmtree, self.outside, True)

    def decide(self, cmd, cwd=None):
        return swg.decide(cmd, cwd or self.ws, self.ws, "bash", [".workflow"], self.scratch, [], self.hand)

    def allowed(self, cmd):
        self.assertIsNone(self.decide(cmd), cmd)

    def refused(self, cmd, unresolved, cwd=None):
        hit = self.decide(cmd, cwd)
        self.assertIsNotNone(hit, cmd)
        self.assertEqual(hit.unresolved, unresolved, "%s -> %r" % (cmd, tuple(hit)))
        return hit

    # -- resolved
    def test_relative_literal_resolves(self):
        self.allowed('D=.workflow/closed; cp x "$D/y"')
        self.allowed('D=.workflow; echo x > "$D/n.md"')
        self.allowed("D=.workflow; echo x > ${D}/n.md")

    def test_quoted_literal_resolves_spaces_included(self):
        self.allowed('H="%s"; echo x > "$H/result.md"' % self.hand)
        self.allowed("H='%s'; echo x > \"$H/result.md\"" % self.hand)
        self.allowed('H="%s/work"; mkdir -p "$H/a b"' % self.hand)
        self.allowed('S="%s"; echo x > "$S/n.md"' % self.scratch)
        # unquoted, a value with a blank splits into words: not resolved
        self.refused('H="%s"; echo x > $H/result.md' % self.hand, True)

    def test_resolved_value_is_judged_like_the_literal(self):
        self.refused("D=src; echo x > \"$D/a.ts\"", False)
        self.refused('D=.workflow; echo x > "$D/../README.md"', False)
        self.refused('V=../README.md; echo x > ".workflow/$V"', False)
        self.refused('H="%s"; echo x > "$H/brief.md"' % self.hand, False)   # parent-owned name
        self.allowed('H="%s"; echo x > "$H/plan.md"' % self.hand)
        self.refused('H=".ssh"; echo x > "$H/id_rsa"', False)
        self.refused('D=".workflow"; echo x > "$D/../.env"', False)

    def test_relative_value_is_judged_in_the_cwd_where_it_is_used(self):
        for cmd in ('D=.workflow; cd src; echo x > "$D/f"', 'cd src; D=.workflow; echo x > "$D/f"'):
            hit = self.decide(cmd)
            self.assertIsNotNone(hit, cmd)
        self.allowed('cd .workflow; D=closed; echo x > "$D/f"')

    def test_symlink_inside_the_allowed_dir_is_followed(self):
        try:
            os.symlink(os.path.join(self.ws, "src"), os.path.join(self.ws, ".workflow", "link"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.refused('D=.workflow/link; echo x > "$D/f"', False)
        self.refused('D=link; cd .workflow; echo x > "$D/f"', False)

    # -- a local value counts as writable only inside an always-writable place, also outside the workspace
    def test_a_local_value_outside_the_workspace_is_refused(self):
        for cmd in ('D=..; echo x >> "$D/outside.txt"', 'D=.workflow; cd ..; echo x >> "$D/f"',
                    'D=../../.ssh; echo x >> "$D/authorized_keys"', 'D=../..; echo x > "$D/f"',
                    'H="%s x"; echo y > "$H/f"' % self.outside, 'H="%s"; echo y > "$H/f"' % self.outside,
                    "H='%s x'; echo y > \"$H/f\"" % self.outside, 'D="../.ssh"; echo x > "$D/id_rsa"',
                    'D=..; cp x "$D/y"', 'D=..; touch "$D/z"', 'D=..; tar xf a.tar -C "$D"'):
            with self.subTest(cmd=cmd):
                self.refused(cmd, False)

    def test_a_word_mixing_a_local_value_is_judged_on_the_final_path(self):
        self.refused('D=.workflow; echo x > "$D/../x"', False)
        self.refused('D=.workflow; echo x > "pre$D"', False)
        self.refused('D=..; echo x > ".workflow/$D/x"', False)
        self.refused('D=..; echo x > ".workflow/$D/../../x"', False)
        self.allowed('D=closed; echo x > ".workflow/$D/x"')
        self.allowed('D=closed; echo x > ".workflow/${D}/x"')

    def test_a_local_value_in_the_scratch_dir_or_an_owned_dir_is_writable(self):
        self.allowed('S="%s"; echo x > "$S/n.md"' % self.scratch)
        owned = fwd(os.path.join(self.ws, "owned"))
        os.makedirs(owned)
        hit = swg.decide('O="%s"; echo x > "$O/n.md"' % owned, self.ws, self.ws, "bash", [".workflow"], self.scratch, [owned], self.hand)
        self.assertIsNone(hit)
        hit = swg.decide('O="%s"; echo x > "$O/../n.md"' % owned, self.ws, self.ws, "bash", [".workflow"], self.scratch, [owned], self.hand)
        self.assertIsNotNone(hit)

    def test_the_nt_pattern_takes_a_quoted_drive_value_with_blanks(self):
        line = 'H="C:/agent dir/h"; echo x > "$H/plan.md"'
        with mock.patch.object(swg, "_NT", True):
            self.assertIsNone(swg.grammar_statements(line))   # the shared grammar is unchanged
            self.assertIsNotNone(swg._grammar_statements(line, True))
            lx = swg.Lexer(line)
            lx.run()
            self.assertEqual(lx.vars.get("H"), "C:/agent dir/h")
            self.assertTrue(lx.local_line)
            for bad in ('H="C:\\a b\\"; cp f "$H"', 'H="C:a b"; cp f "$H"', 'H="C:/a $X"; cp f "$H"'):
                self.assertIsNone(swg._grammar_statements(bad, True), bad)
        with mock.patch.object(swg, "_NT", False):
            self.assertIsNone(swg._grammar_statements(line, True))

    def test_the_exported_grammar_keeps_its_signature(self):
        self.assertIsNone(swg.grammar_statements('D=.workflow; cp x "$D/y"'))
        self.assertIsNotNone(swg.grammar_statements("H=/x; cp f $H"))
        self.assertEqual(swg.grammar_statements.__code__.co_varnames[:swg.grammar_statements.__code__.co_argcount], ("text",))

    def test_powershell_unresolved_variable_is_flagged(self):
        def ps(cmd):
            return swg.decide(cmd, self.ws, self.ws, "powershell", [".workflow"], self.scratch, [], self.hand)
        for cmd in ('Set-Content ".workflow/$V" x', 'Set-Content .workflow/$V x', 'Set-Content ".workflow/$(Get-Date)" x'):
            with self.subTest(cmd=cmd):
                hit = ps(cmd)
                self.assertIsNotNone(hit)
                self.assertTrue(hit.unresolved)
        hit = ps('Set-Content README.md x')
        self.assertIsNotNone(hit)
        self.assertFalse(hit.unresolved)
        self.assertFalse(ps('Set-Content "$V" x; Set-Content README.md y').unresolved)

    # -- not resolved
    def test_values_with_expansion_or_glob_are_not_resolved(self):
        for value in ('"$PWD/x"', '"`pwd`"', '"$(pwd)"', '".work*"', "'.workflow/$X'", '"~/x"', '"a\\\\b"', '"x?y"', '"{a,b}"'):
            with self.subTest(value=value):
                self.refused("D=%s; echo x > \"$D/f\"" % value, True)

    def test_reassignment_to_a_non_literal_forgets_the_name(self):
        self.refused('D=.workflow; D=$(pwd); echo x > "$D/f"', True)
        self.refused('D=.workflow; D=" x"; echo x > "$D/f"', True)
        self.refused('D=.workflow; D=$X; echo x > "$D/f"', True)

    def test_existing_restrictions_still_hold(self):
        for cmd in ('D=.workflow cp x "$D/y"', 'true && D=.workflow; cp x "$D/y"', '(D=.workflow); cp x "$D/y"',
                    'D=.workflow; export D=src; cp x "$D/y"', 'D=.workflow; read D; cp x "$D/y"',
                    'D=.workflow & cp x "$D/y"', 'D=.workflow*; cp x "$D/y"', 'IFS=.workflow; cp x "$IFS/y"',
                    'D=.workflow; f() { cp x "$D/y"; }; f', 'D=.workflow; while true; do cp x "$D/y"; done',
                    'for l in a b; do cp x ".workflow/closed/$l/"; done'):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(self.decide(cmd), cmd)

    def test_unresolved_targets(self):
        for cmd in ('echo x > ".workflow/$V"', 'echo x > ".workflow/$(echo a)"', 'echo x > ".workflow/`echo a`"',
                    'echo x > "$V/.workflow/x"', 'echo x > "$V"', 'echo x > "${V}/f"',
                    'for l in a b; do cp x ".workflow/closed/$l/"; done', 'echo x > ".workflow/$HOME"'):
            with self.subTest(cmd=cmd):
                self.refused(cmd, True)

    def test_a_real_project_write_next_to_an_unresolved_one_is_no_unresolved_refusal(self):
        self.refused('echo x > "$V"; echo y > README.md', False)
        self.refused('echo y > README.md; echo x > "$V"', False)
        self.refused('echo x > "$V"; echo y > src/*.ts', False)
        self.refused('echo x > "$V"; echo "$(cat f)" > "$W"; rm -rf src', False)
        self.refused('echo x > ".workflow/$V"; echo y > "%s/brief.md"' % self.hand, False)

    def test_refusal_text_names_the_token_and_the_two_ways_out(self):
        text = self.refused('echo x > ".workflow/$V"', True)[1]
        self.assertIn(".workflow/$V (unresolved)", text)
        self.assertIn("$(...)/f (unresolved)", self.refused('echo x > "$(echo a)/f"', True)[1])
        self.assertIn("`...`/f (unresolved)", self.refused('echo x > "`echo a`/f"', True)[1])
        self.assertIn("${V}/f (unresolved)", self.refused('echo x > "${V}/f"', True)[1])


class ShellWriteVarsCwdTest(unittest.TestCase):
    """A relative resolved value is judged in the directory the write really runs in, exactly like the literal path."""

    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wvc-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.hand = fwd(os.path.join(self.ws, "handoffs", "s1"))
        for d in (".workflow", "src/.workflow", "handoffs/s1"):
            os.makedirs(os.path.join(self.ws, d))

    def kind(self, cmd):
        hit = swg.decide(cmd, self.ws, self.ws, "bash", [".workflow"], None, [self.hand])
        return hit[0] if hit else None

    def test_relative_handoff_value_is_allowed_and_a_project_dir_is_not(self):
        self.assertIsNone(self.kind('H=handoffs/s1; cp plan.md "$H/plan.md"'))
        self.assertEqual(self.kind('H=src; cp plan.md "$H/plan.md"'), "cp")

    def test_a_changed_or_uncertain_cwd_refuses_like_the_literal(self):
        # (variable form, literal form of the same write)
        pairs = (
            ('cd src; D=.workflow; echo x > "$D/f"', "cd src; echo x > .workflow/f"),
            ('cd src && D=.workflow; echo x > "$D/f"', "cd src && echo x > .workflow/f"),
            ('D=.workflow; cd src; echo x > "$D/f"', "cd src; echo x > .workflow/f"),
            ('pushd src; D=.workflow; echo x > "$D/f"', "pushd src; echo x > .workflow/f"),
            ('D=.workflow; pushd src; echo x > "$D/f"', "pushd src; echo x > .workflow/f"),
            ('(cd src; D=.workflow; echo x > "$D/f")', "(cd src; echo x > .workflow/f)"),
            ('D=.workflow; (cd src; echo x > "$D/f")', "(cd src; echo x > .workflow/f)"),
            ('cd "$X"; D=.workflow; echo x > "$D/f"', 'cd "$X"; echo x > .workflow/f'),
            ('D=.workflow; if true; then cd src; fi; echo x > "$D/f"', "if true; then cd src; fi; echo x > .workflow/f"),
            ('D=.workflow; while true; do cd src; break; done; echo x > "$D/f"', "while true; do cd src; break; done; echo x > .workflow/f"),
            ('D=.workflow; f() { cd src; }; f; echo x > "$D/f"', "f() { cd src; }; f; echo x > .workflow/f"),
            ('D=.workflow; true && cd src || true; echo x > "$D/f"', "true && cd src || true; echo x > .workflow/f"),
            ('D=.workflow; cd src || true; echo x > "$D/f"', "cd src || true; echo x > .workflow/f"),
            ('D=.workflow; pushd src; popd; echo x > "$D/f"', "pushd src; popd; echo x > .workflow/f"),
            ('D=.workflow; cd nodir; echo x > "$D/f"', "cd nodir; echo x > .workflow/f"),
        )
        for var, lit in pairs:
            with self.subTest(command=var):
                self.assertEqual(self.kind(var), "redirect", var)
                self.assertEqual(self.kind(lit), "redirect", lit)

    def test_cd_back_to_the_workspace_allows_both_forms(self):
        # the write lands in <ws>/.workflow, so allowing is correct
        self.assertIsNone(self.kind('D=.workflow; cd src; cd ..; echo x > "$D/f"'))
        self.assertIsNone(self.kind("cd src; cd ..; echo x > .workflow/f"))

    def test_the_variable_form_is_never_more_permissive_than_the_literal(self):
        # a `cd` in a pipeline or a background job does not carry over: the literal is allowed there, the variable form is refused
        self.assertIsNone(self.kind("cd src & echo x > .workflow/f"))
        self.assertEqual(self.kind('D=.workflow; cd src & echo x > "$D/f"'), "redirect")
        self.assertIsNone(self.kind("cd src | cat; echo x > .workflow/f"))
        self.assertEqual(self.kind('D=.workflow; cd src | cat; echo x > "$D/f"'), "redirect")


class ShellWriteVarsOutputTest(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-wvo-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        os.makedirs(os.path.join(self.ws, ".workflow"))

    def run_script(self, cmd):
        payload = {"tool_input": {"command": cmd}, "cwd": self.ws, "workspace": self.ws, "allowed_dirs": [".workflow"]}
        r = subprocess.run([sys.executable, "-E", "-s", str(SCRIPT)], input=json.dumps(payload), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout) if r.stdout.strip() else None

    def test_unresolved_flag_and_reason_suffix(self):
        out = self.run_script('echo x > ".workflow/$V"')
        self.assertIs(out["unresolved"], True)
        reason = out["hookSpecificOutput"]["permissionDecisionReason"]
        self.assertIn(swg.REFUSAL, reason)
        self.assertIn("(redirect: .workflow/$V (unresolved))", reason)
        self.assertIn("write the path literally or use the edit/write tool", reason)

    def test_no_flag_and_no_suffix_for_a_project_file(self):
        for cmd in ("echo x > README.md", 'echo x > "$V"; echo y > README.md'):
            out = self.run_script(cmd)
            self.assertNotIn("unresolved", out, cmd)
        self.assertNotIn("write the path literally", self.run_script("echo x > README.md")["hookSpecificOutput"]["permissionDecisionReason"])

    def test_resolved_relative_value_is_allowed_end_to_end(self):
        self.assertIsNone(self.run_script('D=.workflow; echo x > "$D/n.md"'))


class ShellWriteVarsDirTest(unittest.TestCase):
    """A local-step value used as a directory: outside the workspace and the always-writable places the cwd is unknown."""
    setUp, decide, allowed, refused = (ShellWriteVarsTest.setUp, ShellWriteVarsTest.decide,
                                       ShellWriteVarsTest.allowed, ShellWriteVarsTest.refused)

    def values(self):
        return (["..", "../../.ssh", '"%s"' % self.outside, '"%s/out dir"' % self.outside]
                + ["src", "./src", ".workflow/../src"])

    def each(self, template):
        for v in self.values():
            self.refused("D=%s; %s" % (v, template), False)

    def test_cd_forms_refuse_the_later_write(self):
        for cd in ('cd "$D"', "cd $D", 'cd -- "$D"', 'cd -P "$D"', 'pushd "$D"', 'cd "$D" &&'):
            for tail in ("echo x >> f", "touch f", "cp a b", "mv a b"):
                self.each("%s%s%s" % (cd, " " if cd.endswith("&&") else "; ", tail))

    def test_git_dir_forms_refuse(self):
        for verb in ("checkout -- x", "apply p.diff", "restore x", "reset --hard", "stash pop"):
            for opt in ('-C "$D"', '--work-tree "$D"', '--work-tree="$D"', "--work-tree=$D"):
                self.each("git %s %s" % (opt, verb))

    def test_other_cwd_options_refuse(self):
        for cmd in ('env -C "$D" touch f', 'env --chdir "$D" touch f', 'uv run --directory "$D" touch f',
                    'yarn exec --cwd "$D" touch f', 'pnpm exec --dir "$D" touch f', 'patch -d "$D" -p1 < p',
                    'tar -xf a.tar -C "$D"',
                    '(cd "$D"; touch f)', 'cd "$D"; cd x; touch f', 'cd "$D/sub"; touch f'):
            self.each(cmd)

    def test_directory_options_the_guard_does_not_read_as_a_word_refuse(self):
        for cmd in ('unzip -d "$D" a.zip', 'curl -O --output-dir "$D" u', 'wget -P "$D" u'):
            for v in self.values():
                self.assertIsNotNone(self.decide("D=%s; %s" % (v, cmd)), cmd)

    def test_a_directory_inside_an_always_writable_place_stays_allowed(self):
        self.allowed('D=.workflow/closed; cd "$D"; touch f')
        self.allowed('D=.workflow/closed; cd "$D"; cp /tmp/a b')
        self.refused('D=src; cd "$D"; touch f', False)
        self.refused('D=src; cd "$D"; echo x >> f', False)

    def test_a_symlinked_directory_out_of_the_workspace_refuses(self):
        try:
            os.symlink(self.outside, os.path.join(self.ws, ".workflow", "out"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.refused('D=.workflow/out; cd "$D"; touch f', False)
        self.refused('D=.workflow/out; git -C "$D" checkout -- x', False)


if __name__ == "__main__":
    unittest.main()
