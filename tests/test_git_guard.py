"""git_guard.py: decisions over command STRINGS only. Nothing here runs a git command
from the table; git itself is only used to set up temp repos (init, config, commit) for
the alias, checkout-path and push-target cases."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

A, Q, D = "allow", "ask", "deny"
LEVEL = {gg.ALLOW: A, gg.ASK: Q, gg.DENY: D}
HAVE_GIT = shutil.which("git") is not None

# (command, flavor, child decision, main decision)
TABLE = [
    # plain and harmless
    ("git status", "bash", A, A),
    ("git log --oneline", "bash", A, A),
    ("git diff HEAD~1 -- src", "bash", A, A),
    ("git add a.txt b.txt", "bash", A, A),
    ("git fetch origin", "bash", A, A),
    ("git --version", "bash", A, A),
    ("echo git push", "bash", A, A),            # echo prints; nothing runs
    ("grep -r 'git push' docs", "bash", A, A),
    ("ls; pwd", "bash", A, A),
    # push in every shape
    ("git push", "bash", D, A),
    ("git push origin feature", "bash", D, A),
    ("g\"i\"t push", "bash", D, A),
    ("'git' push", "bash", D, A),
    ("\\git push", "bash", D, A),
    ("/usr/bin/git push", "bash", D, A),
    ("GIT push", "bash", D, A),                 # case-insensitive file systems
    ("git.exe push", "bash", D, A),
    ("'C:\\Program Files\\Git\\cmd\\git.exe' push", "bash", D, A),
    ("bash -c 'git push'", "bash", D, A),
    ("sh -lc \"cd x && git push\"", "bash", D, A),
    ("env GIT_DIR=x git push", "bash", D, A),
    ("GIT_DIR=x git push", "bash", D, A),
    ("$(echo git) push", "bash", D, Q),
    ("`echo git` push", "bash", D, Q),
    ("$G push", "bash", D, Q),                 # computed program, push-like args
    ("git -C .. push", "bash", D, A),
    ("git -c user.name=x --no-pager push", "bash", D, A),
    ("echo origin | xargs git push", "bash", D, Q),  # main: refspecs come from stdin
    ("echo push | xargs git", "bash", D, Q),
    ("eval \"git push\"", "bash", D, A),
    ("command git push", "bash", D, A),
    ("exec git push", "bash", D, A),
    ("nohup git push &", "bash", D, A),
    ("time git push", "bash", D, A),
    ("sudo -u bob git push", "bash", D, A),
    ("true && git push || echo no", "bash", D, A),
    ("echo $(git push)", "bash", D, A),
    ("bash <<'EOF'\ngit push\nEOF", "bash", D, A),
    ("echo git push | bash", "bash", D, Q),
    ("find . -name x -exec git push \\;", "bash", D, Q),
    ("pwsh -Command 'git push'", "bash", D, A),
    ("powershell -enc ZwBpAHQA", "bash", D, Q),
    ("git-push origin", "bash", D, A),
    ("python3 -c \"import os; os.system('git push')\"", "bash", D, Q),
    ("& git push", "powershell", D, A),
    ("git.exe push", "powershell", D, A),
    ("& 'C:\\Program Files\\Git\\cmd\\git.exe' push", "powershell", D, A),
    ("C:\\Program Files\\Git\\cmd\\git.exe push", "powershell", D, A),
    ("g`it push", "powershell", D, A),
    ("Start-Process git -ArgumentList push", "powershell", D, A),
    ("$g = 'git'; & $g push", "powershell", D, Q),
    ("Invoke-Expression 'git push'", "powershell", D, A),
    ("cmd /c g^it push", "bash", D, A),
    # destructive forms (child)
    ("git reset --hard HEAD~1", "bash", D, A),
    ("git reset --ha", "bash", D, A),           # git accepts unique prefixes
    ("git reset --keep HEAD~1", "bash", A, A),
    ("git reset HEAD a.txt", "bash", A, A),
    ("git checkout -- a.txt", "bash", D, A),
    ("git checkout .", "bash", D, A),
    ("git checkout -f main", "bash", D, A),
    ("git checkout HEAD a.txt", "bash", D, A),
    ("git checkout -b feature", "bash", A, A),
    ("git switch --discard-changes main", "bash", D, A),
    ("git switch -f main", "bash", D, A),
    ("git switch -c feature", "bash", A, A),
    ("git restore a.txt", "bash", D, A),
    ("git restore --staged a.txt", "bash", D, A),
    ("git clean -fd", "bash", D, A),
    ("git clean -xfd", "bash", D, A),
    ("git clean --force", "bash", D, A),
    ("git clean -n", "bash", A, A),
    ("git stash", "bash", A, A),
    ("git stash drop", "bash", D, A),
    ("git stash clear", "bash", D, A),
    ("git branch -D old", "bash", D, A),
    ("git branch -d -f old", "bash", D, A),
    ("git branch --delete --force old", "bash", D, A),
    ("git branch -d old", "bash", A, A),
    ("git worktree remove --force ../wt", "bash", D, A),
    ("git worktree remove ../wt", "bash", A, A),
    ("git update-ref -d refs/heads/x", "bash", D, A),
    ("git reflog expire --expire=now --all", "bash", D, A),
    ("git gc --prune=now", "bash", D, A),
    ("git gc", "bash", A, A),
    ("git -c alias.p=push p", "bash", D, A),
    ("git config alias.p push", "bash", D, A),
    ("git config --get alias.p", "bash", A, A),
    ("git config core.pager 'git push'", "bash", D, A),
    ("git -c core.pager='git push' log", "bash", D, A),
    ("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p", "bash", D, A),
    ("git rebase -x 'git push' main", "bash", D, A),
    ("git submodule foreach 'git push'", "bash", D, A),
    # commit lint (main)
    ("git commit -m \"feat(x): y\"", "bash", A, A),
    ("git commit -m 'merge: phase 2'", "bash", A, A),
    ("git commit -m 'did stuff'", "bash", A, D),
    ("git commit -am 'feat: y'", "bash", A, D),
    ("git commit --all -m 'feat: y'", "bash", A, D),
    ("git commit -m 'feat: y' a.txt", "bash", A, D),
    ("git commit --only -m 'feat: y'", "bash", A, D),
    ("git commit -m \"$(cat msg.txt)\"", "bash", A, Q),
    ("git commit -F - <<'EOF'\nfeat: y\nEOF", "bash", A, Q),
    ("git commit", "bash", A, Q),
    ("git commit --amend --no-edit", "bash", A, Q),
    ("git commit -n -m 'fix(guard): z' -m 'body'", "bash", A, A),
    # push lint (main)
    ("git push --force origin main", "bash", D, D),
    ("git push --forc origin main", "bash", D, D),
    ("git push -f origin feature", "bash", D, A),
    ("git push origin +main", "bash", D, D),
    ("git push origin +HEAD:refs/heads/master", "bash", D, D),
    ("git push origin :main", "bash", D, D),
    ("git push --delete origin main", "bash", D, D),
    ("git push --force-with-lease origin main", "bash", D, D),
    ("git push --mirror origin", "bash", D, D),
    ("git push origin main", "bash", D, A),
    ("git push --dry-run --force origin main", "bash", D, A),
    ("git -c alias.pf='push --force' pf origin main", "bash", D, D),
]


def decide(command, mode, flavor="bash", cwd=None, config=None):
    d = gg.decide(command, mode, cwd=cwd or tempfile.gettempdir(), config=config, flavor=flavor)
    return LEVEL[d.level], d.reason


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd] + list(args), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class TableTest(unittest.TestCase):
    def setUp(self):
        # An empty temp dir: no repo, so no repo aliases and no implicit push target.
        self.cwd = tempfile.mkdtemp(prefix="pf-gg-")
        self.addCleanup(shutil.rmtree, self.cwd)

    def test_table(self):
        self.assertGreaterEqual(len(TABLE), 60)
        for command, flavor, child, main in TABLE:
            for mode, want in (("child", child), ("main", main)):
                with self.subTest(command=command, mode=mode):
                    got, reason = decide(command, mode, flavor, self.cwd)
                    self.assertEqual(got, want, reason)
                    if got != A:
                        self.assertTrue(reason.startswith(gg.PREFIX), reason)


@unittest.skipUnless(HAVE_GIT, "git not on PATH")
class RepoTest(unittest.TestCase):
    """Temp repos only (tempfile.mkdtemp, removed with shutil.rmtree on that path)."""

    def setUp(self):
        self.repo = tempfile.mkdtemp(prefix="pf-gg-repo-")
        self.addCleanup(shutil.rmtree, self.repo, True)
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "config", "user.email", "t@example.invalid")
        git(self.repo, "config", "user.name", "t")
        Path(self.repo, "a.txt").write_text("a\n")
        git(self.repo, "add", "a.txt")
        git(self.repo, "commit", "-q", "-m", "chore: init")

    def test_alias_to_push_and_shell_alias(self):
        git(self.repo, "config", "alias.p", "push")
        git(self.repo, "config", "alias.pp", "p --force")
        git(self.repo, "config", "alias.sh1", "!echo hi")
        git(self.repo, "config", "alias.st", "status")
        self.assertEqual(decide("git p", "child", cwd=self.repo)[0], D)
        self.assertEqual(decide("git pp origin feature", "child", cwd=self.repo)[0], D)
        self.assertEqual(decide("git sh1", "child", cwd=self.repo)[0], D)
        self.assertEqual(decide("git st", "child", cwd=self.repo)[0], A)
        # main: the alias chain resolves to a force push of the current branch (main).
        self.assertEqual(decide("git pp", "main", cwd=self.repo)[0], D)
        self.assertEqual(decide("git p origin feature", "main", cwd=self.repo)[0], A)

    def test_checkout_of_an_existing_path_is_a_restore(self):
        self.assertEqual(decide("git checkout a.txt", "child", cwd=self.repo)[0], D)
        self.assertEqual(decide("git checkout some-branch", "child", cwd=self.repo)[0], A)

    def test_implicit_force_push_target_is_the_current_branch(self):
        self.assertEqual(decide("git push --force", "main", cwd=self.repo)[0], D)
        git(self.repo, "checkout", "-q", "-b", "feature")
        self.assertEqual(decide("git push --force", "main", cwd=self.repo)[0], A)
        git(self.repo, "config", "branch.feature.merge", "refs/heads/main")
        self.assertEqual(decide("git push -f", "main", cwd=self.repo)[0], D)
        cfg = {"protectedBranches": ["release/*"]}
        self.assertEqual(decide("git push -f origin release/1.0", "main", cwd=self.repo, config=cfg)[0], D)
        self.assertEqual(decide("git push -f origin feature", "main", cwd=self.repo, config=cfg)[0], A)

    def test_message_file_and_trailers(self):
        msg = Path(self.repo, "msg.txt")
        msg.write_text("feat(x): y\n\nbody\n\nCo-Authored-By: A <a@example.invalid>\n")
        cfg = {"commit": {"requiredTrailers": ["^Co-Authored-By: "], "forbiddenTrailers": ["^Signed-off-by:"]}}
        self.assertEqual(decide("git commit -F msg.txt", "main", cwd=self.repo, config=cfg)[0], A)
        self.assertEqual(decide("git commit -s -F msg.txt", "main", cwd=self.repo, config=cfg)[0], D)
        got, reason = decide("git commit -m 'feat: y'", "main", cwd=self.repo, config=cfg)
        self.assertEqual(got, D)
        self.assertIn("requiredTrailers", reason)
        self.assertEqual(decide("git commit -m 'feat: y' --trailer 'Co-Authored-By: B'", "main", cwd=self.repo, config=cfg)[0], A)
        self.assertEqual(decide("git commit -m 'anything'", "main", cwd=self.repo, config={"commit": {"messagePattern": "^any"}})[0], A)

    def test_check_command_gets_the_staged_diff(self):
        Path(self.repo, "a.txt").write_text("a\nSECRET-MARKER\n")
        git(self.repo, "add", "a.txt")
        script = Path(self.repo, "check.py")
        script.write_text(
            "import os, sys\n"
            "data = sys.stdin.buffer.read().decode()\n"
            "if 'SECRET-MARKER' in data or 'bad' in os.environ.get('PI_FOREMAN_COMMIT_MESSAGE', ''):\n"
            "    sys.stderr.write('public-repo grep hit')\n"
            "    sys.exit(1)\n")
        cfg = {"commit": {"checkCommand": [sys.executable, str(script)]}}
        got, reason = decide("git commit -m 'feat: y'", "main", cwd=self.repo, config=cfg)
        self.assertEqual(got, D)
        self.assertIn("public-repo grep hit", reason)
        Path(self.repo, "a.txt").write_text("a\nfine\n")
        git(self.repo, "add", "a.txt")
        self.assertEqual(decide("git commit -m 'feat: y'", "main", cwd=self.repo, config=cfg)[0], A)
        self.assertEqual(decide("git commit -m 'feat: bad y'", "main", cwd=self.repo, config=cfg)[0], D)


class ConfigLayerTest(unittest.TestCase):
    def test_project_layer_only_adds_trailers_and_cannot_set_pattern_or_check(self):
        import foreman_config as fc
        tmp = tempfile.mkdtemp(prefix="pf-gg-cfg-")
        self.addCleanup(shutil.rmtree, tmp)
        agent, proj = Path(tmp, "agent"), Path(tmp, "proj")
        (proj / ".pi").mkdir(parents=True)
        agent.mkdir()
        (agent / "foreman.json").write_text(json.dumps({"safety": {"git": {"commit": {
            "requiredTrailers": ["^A: "], "checkCommand": ["l2-check"]}}}}))
        (proj / ".pi" / "foreman.json").write_text(json.dumps({"safety": {"git": {"commit": {
            "requiredTrailers": ["^B: "], "forbiddenTrailers": ["^C: "], "messagePattern": ".*",
            "checkCommand": ["evil"]}}}}))
        res = fc.load_config(agent_dir=str(agent), project_dir=str(proj), trusted_project=True)
        commit = res["config"]["safety"]["git"]["commit"]
        self.assertEqual(commit["requiredTrailers"], ["^A: ", "^B: "])
        self.assertEqual(commit["forbiddenTrailers"], ["^C: "])
        self.assertEqual(commit["messagePattern"], gg.DEFAULT_MESSAGE_PATTERN)
        self.assertEqual(commit["checkCommand"], ["l2-check"])
        warn = "\n".join(res["warnings"])
        self.assertIn("safety.git.commit.messagePattern", warn)
        self.assertIn("safety.git.commit.checkCommand", warn)
        (agent / "foreman.json").write_text(json.dumps({"safety": {"git": {"commit": {"messagePattern": "("}}}}))
        res = fc.load_config(agent_dir=str(agent), project_dir=str(proj))
        self.assertTrue(res["safetyFallback"])


class CliTest(unittest.TestCase):
    """The script as the adapter runs it: JSON in, decision JSON out, exit 0; exit 2 on errors."""

    def run_cli(self, payload, *args):
        r = subprocess.run([sys.executable, "-E", "-s", str(ROOT / "scripts" / "git_guard.py")] + list(args),
                           input=json.dumps(payload).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=30)
        return r.returncode, r.stdout.decode(), r.stderr.decode()

    def test_deny_shape_and_allow_is_silent(self):
        tmp = tempfile.mkdtemp(prefix="pf-gg-cli-")
        self.addCleanup(shutil.rmtree, tmp)
        p = {"tool_name": "Bash", "tool_input": {"command": "git push"}, "cwd": tmp}
        code, out, _ = self.run_cli(p, "--mode", "child")
        self.assertEqual(code, 0)
        h = json.loads(out)["hookSpecificOutput"]
        self.assertEqual((h["hookEventName"], h["permissionDecision"]), ("PreToolUse", "deny"))
        self.assertEqual(self.run_cli(p, "--mode", "main")[:2], (0, ""))
        p2 = dict(p, tool_input={"command": "& git push"}, shell="powershell")
        self.assertIn('"deny"', self.run_cli(p2, "--mode", "child")[1])
        p3 = dict(p, tool_input={"command": "git commit -m 'whatever'"}, foreman_git={"commit": {"messagePattern": "^what"}})
        self.assertEqual(self.run_cli(p3, "--mode", "main")[:2], (0, ""))
        self.assertEqual(self.run_cli({"tool_name": "Read", "tool_input": {}}, "--mode", "child")[:2], (0, ""))

    def test_internal_error_exits_nonzero(self):
        code, out, err = self.run_cli({"tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual((code, out), (2, ""))
        self.assertIn("--mode", err)

    def test_defaults_file_matches_built_in_defaults(self):
        defaults = json.loads((ROOT / "config" / "foreman.defaults.json").read_text("utf-8"))["safety"]["git"]
        self.assertEqual(defaults["protectedBranches"], gg.DEFAULT_CONFIG["protectedBranches"])
        self.assertEqual(defaults["commit"], gg.DEFAULT_CONFIG["commit"])


if __name__ == "__main__":
    unittest.main()
