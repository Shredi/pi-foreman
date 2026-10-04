"""scripts/safe_ops.py: every precondition fails once, every op succeeds once.

All repositories and files live in temp dirs this test creates (tempfile.mkdtemp) and removes
with shutil.rmtree on that exact path. Git runs with an empty global config.

Windows: tests that need a symlink skip when os.symlink raises OSError (no Developer Mode or
SeCreateSymbolicLinkPrivilege on the runner); everything else, hard links and case-insensitive
`.GIT` included, runs there too.
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import safe_ops  # noqa: E402

_ENV_KEYS = ("GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
             "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL")


def _rm_readonly(func, path, _exc):
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _symlinks_supported():
    d = tempfile.mkdtemp(prefix="pf-safeops-probe-")
    try:
        os.symlink(d, os.path.join(d, "l"), target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        return False
    finally:
        shutil.rmtree(d, onerror=_rm_readonly)


SYMLINKS = _symlinks_supported()
NO_SYMLINK = "os.symlink raises OSError here (Windows without symlink privilege)"


class SafeOpsCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = {k: os.environ.get(k) for k in _ENV_KEYS}
        cls._cfgdir = tempfile.mkdtemp(prefix="pf-safeops-cfg-")
        cfg = os.path.join(cls._cfgdir, "gitconfig")
        Path(cfg).write_text("[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n", "utf-8")
        os.environ.update({"GIT_CONFIG_GLOBAL": cfg, "GIT_CONFIG_NOSYSTEM": "1",
                           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"})

    @classmethod
    def tearDownClass(cls):
        for k, v in cls._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(cls._cfgdir, onerror=_rm_readonly)

    def setUp(self):
        tmp = tempfile.mkdtemp(prefix="pf-safeops-")
        self.addCleanup(shutil.rmtree, tmp, onerror=_rm_readonly)
        self.tmp = os.path.realpath(tmp)
        self.repo = os.path.join(self.tmp, "repo")
        os.mkdir(self.repo)
        self.git("init", "-q")
        self.write("tracked.txt", "one\n")
        self.write(".gitignore", "*.log\nnode_modules/\n")
        self.git("add", "tracked.txt", ".gitignore")
        self.git("commit", "-q", "-m", "init")

    def git(self, *args, cwd=None):
        r = subprocess.run(["git"] + list(args), cwd=cwd or self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        return r.stdout.decode()

    def write(self, rel, text, base=None):
        p = os.path.join(base or self.repo, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        Path(p).write_text(text, "utf-8")
        return p

    def op(self, op, cwd=None, config=None, **args):
        return safe_ops.handle({"op": op, "args": args, "cwd": cwd or self.repo, "config": config or {}})

    def failed(self, res, name):
        self.assertFalse(res["ok"], res)
        self.assertEqual(res.get("precondition"), name, res)
        self.assertTrue(res["message"].startswith("precondition failed: " + name), res)


class MoveTest(SafeOpsCase):
    def test_untracked_file_moves_with_link_and_unlink(self):
        self.write("a.txt", "x")
        res = self.op("move", src="a.txt", dst="b.txt")
        self.assertEqual(res["action"], "rename_file", res)
        self.assertFalse(os.path.exists(os.path.join(self.repo, "a.txt")))
        self.assertEqual(Path(self.repo, "b.txt").read_text("utf-8"), "x")

    def test_tracked_file_uses_git_mv(self):
        res = self.op("move", src="tracked.txt", dst="moved.txt")
        self.assertEqual(res["action"], "git_mv", res)
        self.assertIn("R  tracked.txt -> moved.txt", self.git("status", "--porcelain"))

    def test_untracked_directory_renames(self):
        self.write("d/x.txt", "x")
        res = self.op("move", src="d", dst="e")
        self.assertEqual(res["action"], "rename_dir", res)
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "e", "x.txt")))

    def test_dst_exists(self):
        self.write("a.txt", "x")
        self.write("b.txt", "keep")
        self.failed(self.op("move", src="a.txt", dst="b.txt"), "dst_exists")
        self.assertEqual(Path(self.repo, "b.txt").read_text("utf-8"), "keep")
        self.assertTrue(os.path.exists(os.path.join(self.repo, "a.txt")))

    def test_dirty_tracked_src(self):
        self.write("tracked.txt", "changed\n")
        self.failed(self.op("move", src="tracked.txt", dst="moved.txt"), "src_dirty")
        self.assertTrue(os.path.exists(os.path.join(self.repo, "tracked.txt")))

    def test_dotdot_traversal(self):
        self.write("a.txt", "x")
        self.failed(self.op("move", src="a.txt", dst="../outside.txt"), "outside_workspace")
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "outside.txt")))
        self.write("other.txt", "o", base=self.tmp)
        self.failed(self.op("move", src="../repo/../other.txt", dst="b.txt"), "outside_workspace")
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "other.txt")))

    def test_git_dir_target(self):
        self.write("a.txt", "x")
        self.failed(self.op("move", src="a.txt", dst=".git/a.txt"), "inside_git_dir")
        self.failed(self.op("move", src=".git/HEAD", dst="head.txt"), "inside_git_dir")
        if safe_ops.CASE_INSENSITIVE:
            self.failed(self.op("move", src="a.txt", dst=".GIT\\a.txt" if os.name == "nt" else ".GIT/a.txt"), "inside_git_dir")

    def test_src_missing(self):
        self.failed(self.op("move", src="nope.txt", dst="b.txt"), "src_missing")

    @unittest.skipUnless(SYMLINKS, NO_SYMLINK)
    def test_symlink_escape(self):
        outside = os.path.join(self.tmp, "outside")
        os.mkdir(outside)
        self.write("secret.txt", "s", base=outside)
        os.symlink(os.path.join(outside, "secret.txt"), os.path.join(self.repo, "link.txt"))
        os.symlink(outside, os.path.join(self.repo, "out"), target_is_directory=True)
        self.failed(self.op("move", src="link.txt", dst="b.txt"), "outside_workspace")
        self.write("a.txt", "x")
        self.failed(self.op("move", src="a.txt", dst="out/a.txt"), "outside_workspace")
        self.assertFalse(os.path.exists(os.path.join(outside, "a.txt")))

    def test_cli_round_trip(self):
        self.write("a.txt", "x")
        req = {"op": "move", "args": {"src": "a.txt", "dst": "a.txt"}, "cwd": self.repo, "config": {}}
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "safe_ops.py")], input=json.dumps(req).encode(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        out = json.loads(r.stdout.decode())
        self.assertEqual((out["ok"], out["precondition"]), (False, "dst_exists"))


class CopyTest(SafeOpsCase):
    def test_file_copy_keeps_metadata(self):
        src = self.write("a.txt", "data")
        os.utime(src, (1_000_000_000, 1_000_000_000))
        res = self.op("copy", src="a.txt", dst="b.txt")
        self.assertEqual((res["action"], res["bytes"]), ("copy_file", 4), res)
        self.assertEqual(int(os.stat(os.path.join(self.repo, "b.txt")).st_mtime), 1_000_000_000)

    def test_directory_copy(self):
        self.write("d/x.txt", "x")
        self.write("d/sub/y.txt", "y")
        res = self.op("copy", src="d", dst="e")
        self.assertEqual((res["action"], res["files"]), ("copy_dir", 2), res)
        self.assertEqual(Path(self.repo, "e", "sub", "y.txt").read_text("utf-8"), "y")
        self.assertTrue(os.path.isfile(os.path.join(self.repo, "d", "x.txt")))

    def test_dst_exists(self):
        self.write("a.txt", "x")
        self.write("b.txt", "keep")
        self.failed(self.op("copy", src="a.txt", dst="b.txt"), "dst_exists")
        self.assertEqual(Path(self.repo, "b.txt").read_text("utf-8"), "keep")

    def test_size_cap(self):
        self.write("d/x.txt", "x" * 10)
        self.write("d/y.txt", "y" * 10)
        self.failed(self.op("copy", config={"copyMaxBytes": 15}, src="d", dst="e"), "size_cap")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "e")))
        self.failed(self.op("copy", config={"copyMaxBytes": 5}, src="d/x.txt", dst="z.txt"), "size_cap")

    def test_dotdot_and_git_dir(self):
        self.write("a.txt", "x")
        self.failed(self.op("copy", src="a.txt", dst="../b.txt"), "outside_workspace")
        self.failed(self.op("copy", src="a.txt", dst=".git/b.txt"), "inside_git_dir")

    @unittest.skipUnless(SYMLINKS, NO_SYMLINK)
    def test_symlink_inside_directory(self):
        self.write("d/x.txt", "x")
        os.symlink(os.path.join(self.repo, "tracked.txt"), os.path.join(self.repo, "d", "l.txt"))
        self.failed(self.op("copy", src="d", dst="e"), "src_symlink")
        self.assertFalse(os.path.exists(os.path.join(self.repo, "e")))


class WorktreeRemoveTest(SafeOpsCase):
    def add_worktree(self, name="wt", branch="feat", detach=False):
        path = os.path.join(self.tmp, name)
        if detach:
            self.git("worktree", "add", "-q", "--detach", path)
        else:
            self.git("worktree", "add", "-q", "-b", branch, path)
        return path

    def branches(self):
        return self.git("branch", "--format=%(refname:short)").split()

    def test_merged_worktree_removed_and_branch_deleted(self):
        wt = self.add_worktree()
        os.makedirs(os.path.join(wt, "node_modules", "pkg"))
        self.write("node_modules/pkg/index.js", "x", base=wt)  # ignored but disposable
        res = self.op("worktree_remove", path=wt)
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["branch"], res["branchDeleted"]), ("feat", True))
        self.assertFalse(os.path.exists(wt))
        self.assertNotIn("feat", self.branches())

    def test_detached_worktree_deletes_no_branch(self):
        wt = self.add_worktree(detach=True)
        res = self.op("worktree_remove", path=wt)
        self.assertTrue(res["ok"], res)
        self.assertIsNone(res["branch"])
        self.assertEqual(self.branches(), ["main"])

    def test_main_worktree_refused(self):
        self.add_worktree()
        self.failed(self.op("worktree_remove", path=self.repo), "main_worktree")

    def test_not_a_worktree(self):
        os.mkdir(os.path.join(self.repo, "plain"))
        self.failed(self.op("worktree_remove", path="plain"), "not_linked_worktree")

    def test_untracked_file_blocks(self):
        wt = self.add_worktree()
        self.write("new.txt", "x", base=wt)
        self.failed(self.op("worktree_remove", path=wt), "worktree_dirty")
        self.assertTrue(os.path.isdir(wt))

    def test_ignored_non_disposable_file_blocks(self):
        wt = self.add_worktree()
        self.write("results.log", "only copy", base=wt)
        self.failed(self.op("worktree_remove", path=wt), "ignored_files")
        self.assertTrue(os.path.isfile(os.path.join(wt, "results.log")))
        res = self.op("worktree_remove", config={"worktreeDisposable": ["*.log"]}, path=wt)
        self.assertTrue(res["ok"], res)

    def test_unmerged_head_blocks(self):
        wt = self.add_worktree()
        self.write("f.txt", "x", base=wt)
        self.git("add", "f.txt", cwd=wt)
        self.git("commit", "-q", "-m", "work", cwd=wt)
        self.failed(self.op("worktree_remove", path=wt), "not_merged")
        self.assertIn("feat", self.branches())

    def test_head_in_pushed_upstream_passes(self):
        remote = os.path.join(self.tmp, "remote.git")
        self.git("init", "-q", "--bare", remote)
        self.git("remote", "add", "origin", remote)
        wt = self.add_worktree()
        self.write("f.txt", "x", base=wt)
        self.git("add", "f.txt", cwd=wt)
        self.git("commit", "-q", "-m", "work", cwd=wt)
        self.git("push", "-q", "-u", "origin", "feat", cwd=wt)
        res = self.op("worktree_remove", path=wt)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["branchDeleted"], res)

    def test_stash_referencing_branch_blocks(self):
        wt = self.add_worktree()
        self.write("tracked.txt", "changed\n", base=wt)
        self.git("stash", "push", "-q", "-m", "pf-safeops-test", cwd=wt)
        self.failed(self.op("worktree_remove", path=wt), "stash_references_branch")
        self.assertTrue(os.path.isdir(wt))

    def test_unknown_base_branch(self):
        wt = self.add_worktree()
        self.failed(self.op("worktree_remove", config={"baseBranch": "no-such-branch"}, path=wt), "base_branch_unknown")


class OpsConfigTest(unittest.TestCase):
    """safety.ops in the project layer: copyMaxBytes may only go down; the loosening keys are ignored."""

    def test_project_layer(self):
        import foreman_config as fc
        tmp = tempfile.mkdtemp(prefix="pf-safeops-cfg-")
        self.addCleanup(shutil.rmtree, tmp, onerror=_rm_readonly)
        agent, proj = os.path.join(tmp, "agent"), os.path.join(tmp, "proj")
        os.makedirs(agent)
        os.makedirs(os.path.join(proj, ".pi"))

        def load(ops):
            Path(proj, ".pi", "foreman.json").write_text(json.dumps({"safety": {"ops": ops}}), "utf-8")
            res = fc.load_config(agent_dir=agent, project_dir=proj, trusted_project=True)
            return res["config"]["safety"]["ops"], "\n".join(res["warnings"])

        ops, _ = load({"copyMaxBytes": 1024})
        self.assertEqual(ops["copyMaxBytes"], 1024)
        ops, warn = load({"copyMaxBytes": 10 ** 12, "worktreeDisposable": ["*"], "baseBranch": "dev"})
        self.assertEqual(ops, {"copyMaxBytes": 104857600, "baseBranch": None,
                               "worktreeDisposable": safe_ops.DEFAULT_DISPOSABLE})
        for key in ("copyMaxBytes", "worktreeDisposable", "baseBranch"):
            self.assertIn("safety.ops." + key, warn)


if __name__ == "__main__":
    unittest.main()
