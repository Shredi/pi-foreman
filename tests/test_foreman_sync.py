"""scripts/foreman_sync.py against temp git repos with a local bare remote (no network)."""
from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import foreman_sync as fs  # noqa: E402

SESSION = "sess1234abcd"


def g(cwd, *args):
    r = subprocess.run(["git"] + list(args), cwd=str(cwd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


def ident(repo):
    g(repo, "config", "user.name", "Test")
    g(repo, "config", "user.email", "test@example.invalid")


class SyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="sync_test_"))
        env = mock.patch.dict(os.environ, {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
        env.start()
        self.addCleanup(env.stop)
        self.bare = self.tmp / "remote.git"
        # Test seam (module attribute, honoured only under unittest): the suite's local bare remote.
        seam = mock.patch.object(fs, "TEST_LOCAL_REMOTES", (str(self.bare),))
        seam.start()
        self.addCleanup(seam.stop)
        g(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        seed = self.tmp / "seed"
        g(self.tmp, "clone", "-q", str(self.bare), str(seed))
        ident(seed)
        (seed / "README").write_text("x\n")
        g(seed, "add", "README")
        g(seed, "commit", "-q", "-m", "init")
        g(seed, "push", "-q", "origin", "HEAD:refs/heads/main")
        self.seed = seed
        self.work = self.tmp / "work"
        g(self.tmp, "clone", "-q", str(self.bare), str(self.work))
        ident(self.work)
        self.agent = self.tmp / "agent"
        self.state = self.agent / "pi-foreman" / "state"
        self.state.mkdir(parents=True)
        self.config(branch="main")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def config(self, branch, paths=("notes/*",)):
        cfg = {"sync": {"repos": [{"path": str(self.work), "branch": branch, "paths": list(paths)}], "runRetro": False}}
        (self.agent / "foreman.json").write_text(json.dumps(cfg))

    def run_sync(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = fs.main(["--cwd", str(self.work), "--state", str(self.state), "--session", SESSION, "--json"] + list(extra))
        return code, json.loads(out.getvalue())["repos"][0]

    def write(self, rel, text):
        p = self.work / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def remote_head(self, branch="main"):
        return g(self.bare, "rev-parse", branch)

    def test_ff_pull_commit_push(self):
        (self.seed / "new.txt").write_text("from elsewhere\n")
        g(self.seed, "add", "new.txt")
        g(self.seed, "commit", "-q", "-m", "other machine")
        g(self.seed, "push", "-q", "origin", "HEAD:refs/heads/main")
        self.write("notes/a.md", "note\n")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (0, "pushed"), rep)
        self.assertTrue((self.work / "new.txt").exists())
        self.assertEqual(self.remote_head(), g(self.work, "rev-parse", "HEAD"))
        self.assertEqual(g(self.bare, "log", "-1", "--format=%s"), "chore(sync): %s %s" % (fs.datetime.date.today().isoformat(), SESSION[:8]))

    def test_diverged_skipped(self):
        (self.seed / "new.txt").write_text("a\n")
        g(self.seed, "add", "new.txt")
        g(self.seed, "commit", "-q", "-m", "remote side")
        g(self.seed, "push", "-q", "origin", "HEAD:refs/heads/main")
        self.write("local.txt", "b\n")
        g(self.work, "add", "local.txt")
        g(self.work, "commit", "-q", "-m", "local side")
        before = self.remote_head()
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "skipped"))
        self.assertIn("pull --ff-only failed", rep["detail"])
        self.assertEqual(self.remote_head(), before)

    def test_only_glob_matched_files_committed(self):
        self.write("notes/a.md", "note\n")
        self.write("src/x.py", "print(1)\n")
        self.write("staged.txt", "s\n")
        g(self.work, "add", "staged.txt")
        code, rep = self.run_sync()
        self.assertEqual(code, 0, rep)
        self.assertEqual(g(self.work, "show", "--name-only", "--format=", "HEAD").split(), ["notes/a.md"])
        status = g(self.work, "status", "--porcelain")
        self.assertIn("?? src/", status)
        self.assertIn("A  staged.txt", status)

    def test_secret_name_refuses_repo(self):
        self.write("notes/a.md", "fine\n")
        self.write("notes/api-token.md", "VALUE-NOT-PRINTED\n")
        head = g(self.work, "rev-parse", "HEAD")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertEqual([s["file"] for s in rep["secrets"]], ["notes/api-token.md"])
        self.assertEqual(g(self.work, "rev-parse", "HEAD"), head)
        self.assertNotIn("VALUE-NOT-PRINTED", json.dumps(rep))

    def test_secret_content_refuses_repo(self):
        self.write("notes/a.md", "-----BEGIN RSA PRIVATE KEY-----\nKEYBODYNOTPRINTED\n")
        self.write("notes/b.md", "tok ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2" + "\n")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertEqual(sorted(s["rule"] for s in rep["secrets"]), ["content: private key header", "content: token prefix"])
        self.assertNotIn("KEYBODY", json.dumps(rep))
        self.assertNotIn("A1b2C3", json.dumps(rep))

    def test_risky_repo_config_refused(self):
        outside = self.tmp / "outside.cfg"
        outside.write_text("[user]\n\tname = X\n")
        na = "not allowlisted: "
        cases = [("filter.x.clean", "touch pwned", na + "filter.<x>.clean"), ("diff.x.textconv", "cat", na + "diff.<x>.textconv"),
                 ("diff.x.command", "x", na + "diff.<x>.command"), ("core.attributesFile", "x", na + "core.attributesfile"),
                 ("submodule.recurse", "true", na + "submodule.recurse"), ("remote.origin.vcs", "x", na + "remote.<x>.vcs"),
                 ("core.sshCommand", "ssh -o X=y", na + "core.sshcommand"), ("core.hooksPath", "hooks", na + "core.hookspath"),
                 ("credential.helper", "store", na + "credential.helper"), ("gpg.ssh.program", "x", na + "gpg.<x>.program"),
                 ("commit.gpgSign", "true", "commit.gpgsign (not false)"), ("core.fsmonitor", "x", "core.fsmonitor (not false)"),
                 ("url.https://user:pw@example.invalid/.insteadOf", str(self.bare), na + "url.<x>.insteadof"),
                 ("remote.origin.pushurl", str(self.tmp / "evil.git"), na + "remote.<x>.pushurl"),
                 ("remote.origin.uploadpack", "x", na + "remote.<x>.uploadpack"), ("http.proxy", "x", na + "http.proxy"),
                 ("http.sslVerify", "false", na + "http.sslverify"), ("maintenance.auto", "true", na + "maintenance.auto"),
                 ("protocol.file.allow", "always", na + "protocol.<x>.allow"),
                 ("remote.evil.url", "ext::sh -c touch% pwned", "remote.<x>.url (not https/ssh/git or scp-like)"),
                 ("branch.main.remote", str(self.tmp / "evil.git"), "branch.<x>.remote (not a configured remote)"),
                 ("include.path", str(outside), "include.path/includeIf.*.path (outside the git dir)")]
        self.write("notes/a.md", "note\n")
        before = self.remote_head()
        for key, val, label in cases:
            with self.subTest(key=key):
                g(self.work, "config", key, val)
                code, rep = self.run_sync()
                g(self.work, "config", "--unset", key)
                self.assertEqual((code, rep["status"]), (1, "refused"), rep)
                self.assertIn(label, rep["detail"])
                self.assertNotIn("pw@", json.dumps(rep))
                self.assertEqual(rep["files"], [])
        self.assertEqual(self.remote_head(), before)
        g(self.work, "config", "commit.gpgSign", "false")
        self.assertEqual(self.run_sync()[1]["status"], "pushed")

    def spy_git(self):
        calls, real = [], fs.git
        def spy(args, cwd, stdin=None):
            calls.append(args[0])
            return real(args, cwd, stdin)
        patch = mock.patch.object(fs, "git", spy)
        patch.start()
        self.addCleanup(patch.stop)
        return calls

    def test_rereview_vectors_refused_before_git_writes(self):
        self.write("notes/a.md", "note\n")
        head, before = g(self.work, "rev-parse", "HEAD"), self.remote_head()
        hook_marker, alt_marker = self.tmp / "HOOKMARK", self.tmp / "MARKER"
        g(self.work, "config", "hook.x.event", "pre-commit")
        g(self.work, "config", "hook.x.command", "touch '%s'" % hook_marker)
        calls = self.spy_git()
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"), rep)
        self.assertIn("not allowlisted: hook.<x>.command", rep["detail"])
        self.assertNotIn(str(hook_marker), json.dumps(rep))
        g(self.work, "config", "--remove-section", "hook.x")
        alternates = self.work / ".git" / "objects" / "info" / "alternates"
        alternates.parent.mkdir(parents=True, exist_ok=True)
        alternates.write_text(str(self.bare / "objects") + "\n")
        g(self.work, "config", "core.alternateRefsCommand", "touch '%s'" % alt_marker)
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"), rep)
        self.assertIn("not allowlisted: core.alternaterefscommand", rep["detail"])
        self.assertIn("objects/info/alternates present", rep["detail"])
        g(self.work, "config", "--unset", "core.alternateRefsCommand")
        code, rep = self.run_sync()
        self.assertEqual(rep["detail"], "repo config sets code-running or redirecting keys: objects/info/alternates present")
        self.assertFalse(set(calls) & {"pull", "fetch", "add", "commit", "push"}, calls)
        self.assertFalse(hook_marker.exists() or alt_marker.exists())
        self.assertEqual((g(self.work, "rev-parse", "HEAD"), self.remote_head()), (head, before))

    def hooked_bare(self, path, marker):
        g(self.tmp, "init", "-q", "--bare", str(path))
        hook = path / "hooks" / "pre-receive"
        hook.write_text("#!/bin/sh\ntouch '%s'\n" % marker)
        hook.chmod(0o755)

    def test_local_remote_url_refused_b1(self):
        evil, marker = self.tmp / "evil.git", self.tmp / "PUSHMARK"
        self.hooked_bare(evil, marker)
        self.write("notes/a.md", "note\n")
        head, before = g(self.work, "rev-parse", "HEAD"), self.remote_head()
        calls = self.spy_git()
        for url in (str(evil), "file://" + str(evil), "../evil.git", "ext::sh -c x", "fd::3", "git-remote-x::" + str(evil)):
            with self.subTest(url=url):
                g(self.work, "config", "remote.origin.url", url)
                code, rep = self.run_sync()
                self.assertEqual((code, rep["status"]), (1, "refused"), rep)
                self.assertIn("remote.<x>.url (not https/ssh/git or scp-like)", rep["detail"])
        g(self.work, "config", "remote.origin.url", str(self.bare))
        with mock.patch.object(fs, "TEST_LOCAL_REMOTES", ()):
            self.assertIn("remote.<x>.url (not", self.run_sync()[1]["detail"])
        self.assertFalse(set(calls) & {"pull", "fetch", "add", "commit", "push"}, calls)
        self.assertFalse(marker.exists())
        self.assertEqual((g(self.work, "rev-parse", "HEAD"), self.remote_head()), (head, before))
        for url in ("https://example.invalid/o/r.git", "ssh://git@example.invalid/o/r", "ssh://example.invalid:22/r",
                    "git://example.invalid/r", "git@example.invalid:o/r.git", "example.invalid:o/r"):
            self.assertTrue(fs.url_ok(url), url)
        g(self.work, "remote", "remove", "origin")
        self.hooked_bare(self.work / "origin", marker)
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "skipped"), rep)
        self.assertIn("remote origin has no configured url, not pushed", rep["detail"])
        self.assertFalse(marker.exists())

    def test_path_remote_name_and_file_transport_refused_b1(self):
        evil, marker = self.tmp / "evil.git", self.tmp / "PUSHMARK"
        self.hooked_bare(evil, marker)
        self.write("notes/a.md", "note\n")
        branch = g(self.work, "rev-parse", "--abbrev-ref", "HEAD")
        g(self.work, "config", "remote.%s.url" % evil, "https://example.invalid/r.git")
        g(self.work, "config", "branch.%s.remote" % branch, str(evil))
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"), rep)
        self.assertFalse(marker.exists())
        for name in (str(evil), "a/b", "a\\b", ".", "..", "-x"):
            self.assertFalse(fs.name_ok(name), name)
        g(self.work, "config", "branch.%s.remote" % branch, "origin")
        g(self.work, "config", "--remove-section", "remote.%s" % evil)
        # A raced or missed url check: git itself refuses the local transport outside the test seam.
        g(self.work, "config", "remote.origin.url", str(evil))
        with mock.patch.object(fs, "TEST_LOCAL_REMOTES", ()), mock.patch.object(fs, "url_ok", lambda v: True):
            code, rep = self.run_sync()
        self.assertEqual(code, 1, rep)
        self.assertFalse(marker.exists())

    def test_gitlink_refused_and_status_ignores_submodules_b2(self):
        sub, marker = self.work / "sub", self.tmp / "SUBMARK"
        g(self.tmp, "init", "-q", str(sub))
        ident(sub)
        (sub / "f.txt").write_text("x\n")
        g(sub, "add", "f.txt")
        g(sub, "commit", "-q", "-m", "s")
        g(sub, "config", "filter.ev.clean", "sh -c 'touch \"%s\"; cat'" % marker)
        (sub / ".git" / "info").mkdir(exist_ok=True)
        (sub / ".git" / "info" / "attributes").write_text("* filter=ev\n")
        os.utime(sub / "f.txt", (946684800, 946684800))
        g(self.work, "add", "sub")
        self.write("notes/a.md", "note\n")
        head = g(self.work, "rev-parse", "HEAD")
        for extra in (("--dry-run",), ()):
            with self.subTest(extra=extra):
                code, rep = self.run_sync(*extra)
                self.assertEqual((code, rep["status"]), (1, "refused"), rep)
                self.assertIn("gitlink (submodule) in the index", rep["detail"])
        self.assertIn("notes/a.md", fs.status_paths(str(self.work)))
        self.assertFalse(marker.exists())
        self.assertEqual(g(self.work, "rev-parse", "HEAD"), head)

    def test_config_rechecked_before_commit_and_push_m1(self):
        marker, real = self.tmp / "HOOKMARK", fs.git
        self.write("notes/a.md", "note\n")
        head, before = g(self.work, "rev-parse", "HEAD"), self.remote_head()
        for after, label in (("pull", "before commit: "), ("commit", "committed, before push: ")):
            calls = []
            def planting(args, cwd, stdin=None, after=after):
                calls.append(args[0])
                res = real(args, cwd, stdin)
                if args[0] == after:
                    g(self.work, "config", "hook.x.event", "pre-commit")
                    g(self.work, "config", "hook.x.command", "touch '%s'" % marker)
                return res
            with self.subTest(after=after), mock.patch.object(fs, "git", planting):
                code, rep = self.run_sync()
                self.assertEqual((code, rep["status"]), (1, "refused"), rep)
                self.assertTrue(rep["detail"].startswith(label + "repo config sets"), rep["detail"])
                self.assertIn(after, calls)
                self.assertNotIn("push", calls)
            g(self.work, "config", "--remove-section", "hook.x")
            if after == "pull":
                self.assertNotIn("commit", calls)
                self.assertEqual(g(self.work, "rev-parse", "HEAD"), head)
        self.assertFalse(marker.exists())
        self.assertEqual(self.remote_head(), before)

    def test_allowlisted_repo_syncs(self):
        for key, val in (("core.autocrlf", "false"), ("pull.rebase", "true"), ("push.default", "simple"),
                         ("color.ui", "auto"), ("branch.main.pushRemote", "origin"), ("core.fsmonitor", "false")):
            g(self.work, "config", key, val)
        self.assertEqual(g(self.work, "config", "branch.main.remote"), "origin")
        self.write("notes/a.md", "note\n")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (0, "pushed"), rep)
        self.assertEqual(self.remote_head(), g(self.work, "rev-parse", "HEAD"))

    def test_risky_worktree_config_refused(self):
        g(self.work, "config", "extensions.worktreeConfig", "true")
        g(self.work, "config", "--worktree", "core.askPass", "x")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertIn("not allowlisted: core.askpass", rep["detail"])

    def test_secret_scan_whole_file_bytes_and_names(self):
        pad = b"\0" * (3 * 1024 * 1024 - 10)
        (self.work / "notes").mkdir()
        (self.work / "notes" / "a.bin").write_bytes(pad + b"-----BEGIN PGP PRIVATE KEY BLOCK-----\nX\n")
        (self.work / "notes" / "b.md").write_bytes(b"x npm_" + b"A1b2C3d4E5f6G7h8I9j0" + b"\n")
        (self.work / "notes" / ".npmrc").write_text("x\n")
        (self.work / "notes" / "c.md").write_bytes(b"x ghr_" + b"A1b2C3d4E5f6G7h8I9j0" + b"\n")
        (self.work / "notes" / "d.md").write_bytes(b"x AIza" + b"SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4o5p6q" + b"\n")
        for name in ("k.jks", "k.pfx", "id_ecdsa.pub"):
            (self.work / "notes" / name).write_text("x\n")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertEqual({s["file"]: s["rule"] for s in rep["secrets"]},
                         {"notes/a.bin": "content: private key header", "notes/b.md": "content: token prefix",
                          "notes/.npmrc": "name matches .npmrc", "notes/c.md": "content: token prefix",
                          "notes/d.md": "content: token prefix", "notes/k.jks": "name matches *.jks",
                          "notes/k.pfx": "name matches *.pfx", "notes/id_ecdsa.pub": "name matches id_ecdsa*"})

    def test_too_large_and_links_refused(self):
        (self.work / "notes").mkdir()
        with open(self.work / "notes" / "big.bin", "wb") as fh:
            fh.truncate(fs.SCAN_MAX + 1)
        self.write("outside.txt", "x\n")
        os.link(self.work / "outside.txt", self.work / "notes" / "hard.md")
        rules = {"notes/big.bin": "too large to scan (> 20 MiB)", "notes/hard.md": "hard link (not committed)"}
        try:
            os.symlink(str(self.tmp), str(self.work / "notes" / "sym"))
            rules["notes/sym"] = "symlink (not committed)"
        except (OSError, NotImplementedError):
            pass
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertEqual({s["file"]: s["rule"] for s in rep["secrets"]}, rules)

    def test_output_redacted(self):
        line = fs.first_line("fatal: unable to access 'https://user:pw@example.invalid/r.git/' glpat-" + "A1b2C3d4E5f6G7h8I9j0")
        self.assertEqual(line, "fatal: unable to access 'https://***@example.invalid/r.git/' ***")

    def test_unlisted_branch_not_pushed_session_branch_pushed(self):
        g(self.work, "switch", "-q", "-c", "feature")
        self.write("notes/a.md", "note\n")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (1, "refused"))
        self.assertIn("not pushed (branch not owner-listed or session-created)", rep["detail"])
        self.assertEqual(g(self.bare, "branch", "--list", "feature"), "")
        (self.state / "created-branches.json").write_text(json.dumps([{"workspace": str(self.work), "branch": "feature", "session": "other"}]))
        self.assertEqual(self.run_sync()[1]["status"], "refused")
        (self.state / "created-branches.json").write_text(json.dumps([{"workspace": str(self.work), "branch": "feature", "session": SESSION}]))
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"]), (0, "pushed"), rep)
        self.assertEqual(self.remote_head("feature"), g(self.work, "rev-parse", "HEAD"))

    def test_detached_head_refused(self):
        g(self.work, "switch", "-q", "--detach", "HEAD")
        code, rep = self.run_sync()
        self.assertEqual((code, rep["status"], rep["detail"]), (1, "refused", "detached HEAD"))

    def test_dry_run_changes_nothing(self):
        (self.seed / "new.txt").write_text("remote\n")
        g(self.seed, "add", "new.txt")
        g(self.seed, "commit", "-q", "-m", "remote")
        g(self.seed, "push", "-q", "origin", "HEAD:refs/heads/main")
        self.write("notes/a.md", "note\n")
        before = (g(self.work, "rev-parse", "HEAD"), g(self.work, "status", "--porcelain"), self.remote_head())
        code, rep = self.run_sync("--dry-run")
        self.assertEqual((code, rep["status"]), (0, "dry-run"))
        self.assertEqual(rep["files"], ["notes/a.md"])
        self.assertEqual((g(self.work, "rev-parse", "HEAD"), g(self.work, "status", "--porcelain"), self.remote_head()), before)

    def test_banned_argv_shapes_absent(self):
        src = (SCRIPTS / "foreman_sync.py").read_text()
        for shape in (r"""["']--hard["']""", r"""["']--force""", r"""["']reset["']""", r"""["']rebase["']""", r"""["']--no-verify["']"""):
            self.assertIsNone(re.search(shape, src), shape)
        argv = [n.value for lst in ast.walk(ast.parse(src)) if isinstance(lst, ast.List)
                for n in lst.elts if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        self.assertIn("push", argv)
        for bad in ("clean", "stash", "checkout", "-f", "-a", "-A", "-u", ".", "--all"):
            self.assertNotIn(bad, argv)
        self.assertFalse([a for a in argv if a.startswith("+")])


if __name__ == "__main__":
    unittest.main()
