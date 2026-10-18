"""R13 item 2: a child's `git commit -F <file>` is read only on an allowlisted line: the whole input at depth 0 with no substitution,
group, heredoc, here-string, pipe or redirect, made of an optional first top-level `cd <dir in the worktree>`, any `git add` /
`git status` / `git diff --cached` and exactly one `git commit -F <file>`. Everything else with -F is a child deny ("write the message
file in an earlier command"); `--amend --no-edit` is a child deny with its own reason. The foreman (main mode) keeps
message_file_clobbered and its ask. Command STRINGS only."""
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

LEVEL = {gg.ALLOW: "allow", gg.ASK: "ask", gg.DENY: "deny"}
EARLIER = "write the message file in an earlier command"
MSG = ".workflow/scratch/msg.txt"


def decide(command, mode, cwd):
    d = gg.decide(command, mode, cwd=cwd)
    return LEVEL[d.level], d.reason


class ChildCommitFileAllowlistTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-cf-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        subprocess.run(["git", "-C", self.repo, "init", "-q"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        scratch = Path(self.repo, ".workflow", "scratch")
        scratch.mkdir(parents=True)
        (scratch / "msg.txt").write_text("fix(r13): conforming\n")
        Path(self.repo, "a").write_text("a\n")
        Path(self.repo, "b").write_text("b\n")
        self.outside = tempfile.mkdtemp(prefix="pf-gg-cf-out-")
        self.addCleanup(shutil.rmtree, self.outside, True)
        Path(self.outside, "msg.txt").write_text("fix(r13): conforming\n")

    def expect_earlier(self, command):
        got, reason = decide(command, "child", self.repo)
        self.assertEqual(got, "deny", command)
        self.assertIn(EARLIER, reason, command)
        self.assertIn("-F <file inside the worktree>", reason, command)
        self.assertNotIn("fix(r13): conforming", reason, command)  # the file text never goes into a reason

    def expect_deny(self, command):
        # an earlier child rule (heredoc / inline-code file write) refuses the line before the commit lint runs
        self.assertEqual(decide(command, "child", self.repo)[0], "deny", command)

    # ---------------------------------------------------------------- named deny cases (R12 Open forms)
    def test_bash_c_writer_with_message_file_denied(self):
        self.expect_earlier("bash -c 'printf \"fix(r13): x\\n\" > %s' && git commit -F %s" % (MSG, MSG))
        self.expect_earlier("bash -c 'printf x > %s; git commit -F %s'" % (MSG, MSG))

    def test_sed_in_place_on_message_file_denied(self):
        self.expect_earlier("sed -i 's/fix/review/' %s && git commit -F %s" % (MSG, MSG))
        self.expect_earlier("git add a; sed -i.bak 's/fix/review/' %s; git commit -F %s" % (MSG, MSG))

    def test_dd_of_message_file_denied(self):
        self.expect_earlier("dd if=/dev/null of=%s && git commit -F %s" % (MSG, MSG))

    def test_python_writer_of_message_file_denied(self):
        self.expect_deny("python3 -c \"open('%s','w').write('review: x')\" && git commit -F %s" % (MSG, MSG))
        # R12 Open item 2, form 2: the path through a variable
        self.expect_deny("f=%s; python3 -c \"import sys; open(sys.argv[1],'w').write('review: x')\" $f; git commit -F %s"
                            % (MSG, MSG))
        self.expect_deny("node -e \"require('fs').writeFileSync('%s','review: x')\" && git commit -F %s" % (MSG, MSG))

    def test_basename_over_match_other_file_denied(self):
        # a different file with the same basename outside the worktree: the child line still carries a redirect, so it is refused
        self.expect_earlier("printf x > '%s/msg.txt'; git commit -F %s" % (self.outside, MSG))
        self.expect_earlier("cp a '%s/msg.txt' && git commit -F %s" % (self.outside, MSG))

    def test_amend_no_edit_own_reason(self):
        got, reason = decide("git commit --amend --no-edit", "child", self.repo)
        self.assertEqual(got, "deny")
        self.assertIn("children may not run `git commit --amend --no-edit`", reason)
        self.assertNotIn(EARLIER, reason)
        # the foreman keeps the ask
        self.assertEqual(decide("git commit --amend --no-edit", "main", self.repo)[0], "ask")

    def test_message_path_outside_worktree_denied(self):
        got, reason = decide("git commit -F '%s/msg.txt'" % self.outside, "child", self.repo)
        self.assertEqual(got, "deny")
        self.assertIn("cannot read the message file", reason)
        got, reason = decide("cd '%s' && git commit -F msg.txt" % self.outside, "child", self.repo)
        self.assertEqual(got, "deny")

    def test_other_line_shapes_denied(self):
        self.expect_deny("cat > %s <<'EOF'\nfix(r13): x\nEOF\ngit commit -F %s" % (MSG, MSG))
        for c in ("git commit -F %s 2>&1 | tail -3" % MSG,
                  "git commit -F %s > /dev/null" % MSG,
                  "git commit -F %s <<< x" % MSG,
                  "git diff --cached --output=%s && git commit -F %s" % (MSG, MSG),
                  "git diff --stat && git commit -F %s" % MSG,
                  "git commit -F %s && git log --oneline -1" % MSG,
                  "true || git commit -F %s" % MSG,
                  "git add a & git commit -F %s" % MSG,
                  "{ git add a; } && git commit -F %s" % MSG,
                  "git add $(echo a) && git commit -F %s" % MSG,
                  "git add a && cd . && git commit -F %s" % MSG,
                  "GIT_INDEX_FILE=x git commit -F %s" % MSG,
                  "git -C . commit -F %s" % MSG):
            self.expect_earlier(c)

    # ---------------------------------------------------------------- glob / tilde in the -F value
    def expect_literal(self, command):
        got, reason = decide(command, "child", self.repo)
        self.assertEqual(got, "deny", command)
        self.assertIn("use a literal message path", reason, command)

    def test_child_f_glob_bracket_denied(self):
        Path(self.repo, ".workflow", "scratch", "m[s]g.txt").write_text("fix(r13): conforming\n")
        self.expect_literal("git commit -F .workflow/scratch/m[s]g.txt")
        self.expect_literal("git commit --file .workflow/scratch/m[s]g.txt")

    def test_child_f_glob_star_denied(self):
        self.expect_literal("git commit -F .workflow/scratch/ms*.txt")
        self.expect_literal("git commit -F .workflow/scratch/ms?.txt")

    def test_child_f_brace_denied(self):
        self.expect_literal("git commit -F .workflow/scratch/{msg,x}.txt")

    def test_child_f_tilde_denied(self):
        self.expect_literal("git commit -F ~/msg.txt")

    def test_child_f_glued_glob_denied(self):
        Path(self.repo, ".workflow", "scratch", "m[s]g.txt").write_text("fix(r13): conforming\n")
        self.expect_literal("git commit -F.workflow/scratch/m[s]g.txt")
        self.expect_literal("git commit -F~/msg.txt")

    def test_child_f_long_glued_glob_denied(self):
        Path(self.repo, ".workflow", "scratch", "m[s]g.txt").write_text("fix(r13): conforming\n")
        self.expect_literal("git commit --file=.workflow/scratch/m[s]g.txt")
        self.expect_literal("git commit --file=.workflow/scratch/ms*.txt")

    # ---------------------------------------------------------------- named pass cases
    def test_plain_line_passes(self):
        self.assertEqual(decide("git commit -F %s" % MSG, "child", self.repo), ("allow", ""))

    def test_cd_add_commit_line_passes(self):
        # A child on Windows writes the cd target into the bash line with forward slashes; native backslashes would be bash escapes.
        in_bash = self.repo.replace("\\", "/") if sys.platform == "win32" else self.repo
        c = "cd %s && git add a b && git commit -F %s" % (in_bash, MSG)
        self.assertEqual(decide(c, "child", self.repo), ("allow", ""))
        self.assertEqual(decide(c, "child", self.outside), ("allow", ""))

    def test_add_status_diff_cached_chain_passes(self):
        for c in ("git add a; git status --short && git diff --cached --stat && git commit -F %s" % MSG,
                  "cd '%s'\ngit add a b\ngit status\ngit diff --cached\ngit commit -q -F %s" % (self.repo, MSG)):
            self.assertEqual(decide(c, "child", self.repo), ("allow", ""), c)

    def test_allowed_line_still_linted(self):
        Path(self.repo, ".workflow", "scratch", "bad.txt").write_text("review(r10): x\n")
        got, reason = decide("git add a && git commit -F .workflow/scratch/bad.txt", "child", self.repo)
        self.assertEqual(got, "deny")
        self.assertIn("safety.git.commit.messagePattern", reason)

    # ---------------------------------------------------------------- main mode unchanged
    def test_main_mode_message_file_clobbered_unchanged(self):
        line = "cp a %s && git commit -F %s" % (MSG, MSG)
        ctx = gg.Ctx("main", self.repo, gg.merge_config(gg.DEFAULT_CONFIG, {}))
        ctx.root = (line, "bash")
        lx = gg.lex(line, "bash")
        seg = lx.segs[-1]
        self.assertTrue(gg.message_file_clobbered(seg, ctx, gg.GitCall(ctx), MSG))
        plain = "git add a && git commit -F %s" % MSG
        ctx.root = (plain, "bash")
        self.assertFalse(gg.message_file_clobbered(gg.lex(plain, "bash").segs[-1], ctx, gg.GitCall(ctx), MSG))
        self.assertEqual(decide(line, "main", self.repo)[0], "ask")
        self.assertEqual(decide("git commit -F %s && git log --oneline -1" % MSG, "main", self.repo)[0], "allow")


if __name__ == "__main__":
    unittest.main()
