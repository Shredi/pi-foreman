#!/usr/bin/env python3
"""Precondition-checked file and worktree operations (design section 5). Stdlib only, 3.9+.

CLI: one JSON request on stdin, one JSON answer on stdout, exit 0.

    request  {"op": "worktree_remove" | "move" | "copy", "args": {...}, "cwd": "<dir>",
              "config": {"copyMaxBytes": ..., "worktreeDisposable": [...], "baseBranch": ...}}
    answer   {"ok": true, "action": "<what was done>", ...}
          or {"ok": false, "precondition": "<name>", "message": "precondition failed: <name> (<detail>)"}
          or {"ok": false, "error": "<name>", "message": "..."}   (the action itself failed)

`config` is the `safety.ops` object (a whole config with `safety.ops` inside is accepted too).
Every precondition is checked in this process, right before the action; nothing is cached
between calls. When a precondition fails, nothing is changed.

Workspace root = the git top level of `cwd`. Paths in `args` are relative to `cwd` or absolute.

Documented limits:
- A directory (or an untracked symlink) is moved with check-then-`os.rename`. The standard
  library has no RENAME_NOREPLACE, so another process could create the destination between
  the check and the rename (on POSIX a rename onto an empty directory then succeeds). Files use
  `os.link` + unlink (atomic no-overwrite) and tracked paths use `git mv` (refuses an existing
  destination), so the window exists only for directories and symlinks.
- Path checks resolve symlinks once; a symlink swapped in after the check but before the action
  is not detected (same race as above). Files are opened with O_NOFOLLOW where available.
- `git worktree remove` would also delete ignored files; that is why ignored files block the
  removal unless they sit under a `worktreeDisposable` path component.
"""
from __future__ import annotations

import atexit
import fnmatch
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile

DEFAULT_COPY_MAX_BYTES = 100 * 1024 * 1024
DEFAULT_DISPOSABLE = ["node_modules/", "target/", "dist/", "build/", "__pycache__/", ".venv/"]
GIT_TIMEOUT = 60
CASE_INSENSITIVE = sys.platform in ("win32", "darwin")
_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class Precondition(Exception):
    def __init__(self, name, detail=""):
        Exception.__init__(self, name)
        self.name = name
        self.detail = detail


class ActionError(Exception):
    def __init__(self, name, detail):
        Exception.__init__(self, name)
        self.name = name
        self.detail = detail


# ------------------------------------------------------------------ helpers

def _git_env():
    env = dict(os.environ)
    env.update({"GIT_LITERAL_PATHSPECS": "1", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C",
                "GIT_CONFIG_NOSYSTEM": "1"})
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(k, None)
    return env


_EMPTY_HOOKS = []


def _empty_hooks_dir():
    """An empty directory of our own for core.hooksPath, removed (os.rmdir: only if empty) at exit."""
    if not _EMPTY_HOOKS:
        d = tempfile.mkdtemp(prefix="pf-nohooks-")
        _EMPTY_HOOKS.append(d)
        atexit.register(lambda: os.path.isdir(d) and os.rmdir(d))
    return _EMPTY_HOOKS[0]


def git_hardening():
    """`-c` options for every git call (security review cycle 2, T1).

    A child can plant config or hooks in the shared repo; these git calls run with the
    foreman's credentials. core.fsmonitor=false: `git status` would run a planted fsmonitor
    program. protocol.ext.allow=never: no `ext::` transport from a planted url.insteadOf.
    core.hooksPath=<empty dir>: safe_ops needs no hooks; `git mv` and `git worktree remove` run
    none, but `git branch -d` updates a ref and so runs a reference-transaction hook. With
    GIT_CONFIG_NOSYSTEM=1 (env) the system config is not read either.
    """
    return ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never",
            "-c", "core.hooksPath=" + _empty_hooks_dir()]


def git(args, cwd, check=False):
    exe = shutil.which("git")
    if not exe:
        raise Precondition("git_missing", "git is not on PATH")
    r = subprocess.run([exe] + git_hardening() + list(args), cwd=cwd, env=_git_env(), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_TIMEOUT)
    out = r.stdout.decode("utf-8", "surrogateescape")
    if check and r.returncode != 0:
        raise ActionError("git_failed", "git %s: %s" % (args[0], r.stderr.decode("utf-8", "replace").strip()))
    return r.returncode, out, r.stderr.decode("utf-8", "replace")


def norm(p):
    """Comparable form of an absolute path (case folded where the file system usually is)."""
    p = os.path.normcase(os.path.abspath(p))
    return p.lower() if CASE_INSENSITIVE else p


def is_inside(root, p, allow_equal=False):
    r, q = norm(root), norm(p)
    if r == q:
        return allow_equal
    try:
        return os.path.commonpath([r, q]) == r
    except ValueError:  # different drives on Windows
        return False


def is_link(p):
    """Symlink or (Windows) junction / other reparse point."""
    if os.path.islink(p):
        return True
    isj = getattr(os.path, "isjunction", None)
    if isj is not None and isj(p):
        return True
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return bool(getattr(st, "st_file_attributes", 0) & _REPARSE)


def has_git_component(p):
    for part in re.split(r"[\\/]+", p):
        if (part.lower() if CASE_INSENSITIVE else part) == ".git":
            return True
    return False


def workspace_root(cwd):
    if not cwd or not os.path.isdir(cwd):
        raise Precondition("bad_request", "cwd is not a directory")
    code, out, _ = git(["rev-parse", "--show-toplevel"], cwd)
    if code != 0 or not out.strip():
        raise Precondition("not_a_git_repo", "cwd is not inside a git work tree")
    return os.path.realpath(out.strip())


def resolve_arg(cwd, value, what):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise Precondition("bad_request", "%s must be a non-empty path" % what)
    full = os.path.join(cwd, value)
    parent, name = os.path.split(full.rstrip("\\/") if full.rstrip("\\/") else full)
    if name in ("", ".", ".."):
        raise Precondition("bad_request", "%s must name a file or directory" % what)
    return full, parent, name


class Paths(object):
    """Checked source and destination for move/copy (the shared path rules)."""

    def __init__(self, req):
        cwd = req.get("cwd")
        args = req.get("args") if isinstance(req.get("args"), dict) else {}
        self.root = workspace_root(cwd)
        src_full, src_parent, src_name = resolve_arg(cwd, args.get("src"), "src")
        dst_full, dst_parent, dst_name = resolve_arg(cwd, args.get("dst"), "dst")
        if has_git_component(args["src"]) or has_git_component(args["dst"]):
            raise Precondition("inside_git_dir", "neither path may be inside .git")
        if not os.path.lexists(src_full):
            raise Precondition("src_missing", "%s does not exist" % args.get("src"))
        # The source location (parent resolved, the entry itself not followed) and, for a link,
        # its target must both be inside the workspace.
        self.src = os.path.join(os.path.realpath(src_parent), src_name)
        src_real = os.path.realpath(src_full)
        if not os.path.isdir(dst_parent):
            raise Precondition("dst_parent_missing", "the destination's parent directory does not exist")
        self.dst = os.path.join(os.path.realpath(dst_parent), dst_name)
        for p in (self.src, src_real):
            if not is_inside(self.root, p):
                raise Precondition("outside_workspace", "src resolves outside the workspace root")
        if not is_inside(self.root, self.dst):
            raise Precondition("outside_workspace", "dst resolves outside the workspace root")
        for p in (self.src, src_real, self.dst):
            if has_git_component(os.path.relpath(p, self.root)):
                raise Precondition("inside_git_dir", "neither path may be inside .git")
        if os.path.lexists(self.dst):
            raise Precondition("dst_exists", "%s already exists" % args.get("dst"))
        self.rel_src = os.path.relpath(self.src, self.root)
        self.rel_dst = os.path.relpath(self.dst, self.root)


def tracked(root, rel):
    code, out, _ = git(["ls-files", "-z", "--", rel], root)
    return code == 0 and out.strip("\0") != ""


def clean(root, rel):
    code, out, _ = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", rel], root)
    return code == 0 and out.strip("\0") == ""


def ops_config(cfg):
    if not isinstance(cfg, dict):
        cfg = {}
    if isinstance(cfg.get("safety"), dict) and isinstance(cfg["safety"].get("ops"), dict):
        cfg = cfg["safety"]["ops"]
    cap = cfg.get("copyMaxBytes")
    if not isinstance(cap, int) or isinstance(cap, bool) or cap < 0:
        cap = DEFAULT_COPY_MAX_BYTES
    disp = cfg.get("worktreeDisposable")
    if not isinstance(disp, list) or not all(isinstance(x, str) for x in disp):
        disp = list(DEFAULT_DISPOSABLE)
    base = cfg.get("baseBranch")
    if not isinstance(base, str) or not base.strip():
        base = None
    return {"copyMaxBytes": cap, "worktreeDisposable": disp, "baseBranch": base}


# --------------------------------------------------------------------- move

def op_move(req):
    p = Paths(req)
    if tracked(p.root, p.rel_src):
        if not clean(p.root, p.rel_src):
            raise Precondition("src_dirty", "the tracked source has uncommitted changes")
        git(["mv", "--", p.rel_src, p.rel_dst], p.root, check=True)  # no -f: refuses an existing dst
        return {"action": "git_mv", "src": p.rel_src, "dst": p.rel_dst}
    if os.path.isfile(p.src) and not is_link(p.src):
        try:
            os.link(p.src, p.dst)  # fails if dst exists: atomic no-overwrite
        except FileExistsError:
            raise Precondition("dst_exists", "the destination appeared before the move")
        except (OSError, NotImplementedError):
            try:
                _exclusive_copy_file(p.src, p.dst)  # hard links unsupported here
            except FileExistsError:
                raise Precondition("dst_exists", "the destination appeared before the move")
        os.unlink(p.src)
        return {"action": "rename_file", "src": p.rel_src, "dst": p.rel_dst}
    # Directory or untracked symlink: check-then-rename (documented TOCTOU limit, see module doc).
    if os.path.lexists(p.dst):
        raise Precondition("dst_exists", "the destination appeared before the move")
    os.rename(p.src, p.dst)
    return {"action": "rename_dir" if os.path.isdir(p.dst) and not is_link(p.dst) else "rename_link",
            "src": p.rel_src, "dst": p.rel_dst}


# --------------------------------------------------------------------- copy

def _open_src(path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    return os.fdopen(os.open(path, flags), "rb")


def _exclusive_copy_file(src, dst, budget=None):
    """open(dst, 'xb') copy; returns the bytes copied. Removes dst again if the copy fails."""
    copied = 0
    with _open_src(src) as fin:
        fout = open(dst, "xb")
        try:
            with fout:
                while True:
                    chunk = fin.read(1024 * 1024)
                    if not chunk:
                        break
                    copied += len(chunk)
                    if budget is not None and copied > budget:
                        raise ActionError("size_cap", "the source grew past copyMaxBytes during the copy")
                    fout.write(chunk)
            shutil.copystat(src, dst, follow_symlinks=False)
        except BaseException:
            try:
                os.unlink(dst)
            except OSError:
                pass
            raise
    return copied


def _scan(top, cap):
    """[(rel, is_dir)] below `top`; raises on links, special files, or size over cap."""
    entries, total, stack = [], 0, [""]
    while stack:
        rel = stack.pop()
        with os.scandir(os.path.join(top, rel)) as it:
            for e in sorted(it, key=lambda x: x.name):
                r = os.path.join(rel, e.name)
                full = os.path.join(top, r)
                if is_link(full):
                    raise Precondition("src_symlink", "the source contains a symlink or junction: %s" % r)
                st = os.lstat(full)
                if stat.S_ISDIR(st.st_mode):
                    entries.append((r, True))
                    stack.append(r)
                elif stat.S_ISREG(st.st_mode):
                    total += st.st_size
                    if total > cap:
                        raise Precondition("size_cap", "the source is larger than copyMaxBytes (%d)" % cap)
                    entries.append((r, False))
                else:
                    raise Precondition("src_not_regular", "the source contains a special file: %s" % r)
    return entries, total


def op_copy(req):
    p = Paths(req)
    cap = ops_config(req.get("config"))["copyMaxBytes"]
    if is_link(p.src):
        raise Precondition("src_symlink", "the source is a symlink or junction")
    st = os.lstat(p.src)
    if stat.S_ISREG(st.st_mode):
        if st.st_size > cap:
            raise Precondition("size_cap", "the source is larger than copyMaxBytes (%d)" % cap)
        try:
            n = _exclusive_copy_file(p.src, p.dst, budget=cap)
        except FileExistsError:
            raise Precondition("dst_exists", "the destination appeared before the copy")
        return {"action": "copy_file", "src": p.rel_src, "dst": p.rel_dst, "bytes": n}
    if not stat.S_ISDIR(st.st_mode):
        raise Precondition("src_not_regular", "the source is neither a regular file nor a directory")
    entries, _ = _scan(p.src, cap)
    try:
        os.mkdir(p.dst)  # fails if it exists
    except FileExistsError:
        raise Precondition("dst_exists", "the destination appeared before the copy")
    created = [(p.dst, True)]
    budget = cap
    try:
        for rel, is_dir in entries:
            target = os.path.join(p.dst, rel)
            if is_dir:
                os.mkdir(target)
            else:
                budget -= _exclusive_copy_file(os.path.join(p.src, rel), target, budget=budget)
            created.append((target, is_dir))
        for rel, is_dir in reversed(entries):  # deepest first, so directory mtimes stick
            if is_dir:
                shutil.copystat(os.path.join(p.src, rel), os.path.join(p.dst, rel), follow_symlinks=False)
        shutil.copystat(p.src, p.dst, follow_symlinks=False)
    except BaseException as exc:
        # Roll back exactly what this call created (all exclusive creates, so ours alone).
        for path, is_dir in reversed(created):
            try:
                os.rmdir(path) if is_dir else os.unlink(path)
            except OSError:
                pass
        if isinstance(exc, (Precondition, ActionError)):
            raise
        raise ActionError("copy_failed", "%s (partial copy rolled back)" % exc)
    return {"action": "copy_dir", "src": p.rel_src, "dst": p.rel_dst, "files": sum(1 for _, d in entries if not d)}


# ---------------------------------------------------------- worktree remove

def worktrees(cwd):
    code, out, err = git(["worktree", "list", "--porcelain", "-z"], cwd)
    if code != 0:
        raise Precondition("not_a_git_repo", "git worktree list failed: %s" % err.strip())
    items, cur = [], {}
    for field in out.split("\0"):
        if not field:
            if cur:
                items.append(cur)
                cur = {}
            continue
        key, _, val = field.partition(" ")
        cur[key] = val if val else True
    if cur:
        items.append(cur)
    return items


def disposable(path, patterns):
    """True when a component of the git-relative `path` matches a disposable pattern."""
    is_dir = path.endswith("/")
    parts = [x for x in path.split("/") if x]
    for pat in patterns:
        dir_only = pat.endswith("/")
        name = pat.strip("/")
        if not name:
            continue
        # Directory patterns match any component that is a directory (all but the last, or the
        # last when git reported a collapsed directory).
        candidates = parts if (not dir_only or is_dir) else parts[:-1]
        for c in candidates:
            if fnmatch.fnmatchcase(c.lower() if CASE_INSENSITIVE else c, name.lower() if CASE_INSENSITIVE else name):
                return True
    return False


def resolve_base(cwd, configured):
    if configured:
        code, out, _ = git(["rev-parse", "--verify", "--quiet", configured + "^{commit}"], cwd)
        if code == 0:
            return configured, out.strip()
        raise Precondition("base_branch_unknown", "safety.ops.baseBranch %r does not resolve" % configured)
    code, out, _ = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd)
    cands = [out.strip()] if code == 0 and out.strip() else []
    cands += ["refs/heads/main", "refs/heads/master"]
    for ref in cands:
        code, sha, _ = git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"], cwd)
        if code == 0:
            return ref, sha.strip()
    raise Precondition("base_branch_unknown", "no origin HEAD, main or master; set safety.ops.baseBranch")


def op_worktree_remove(req):
    cwd = req.get("cwd")
    args = req.get("args") if isinstance(req.get("args"), dict) else {}
    cfg = ops_config(req.get("config"))
    workspace_root(cwd)
    raw = args.get("path")
    if not isinstance(raw, str) or not raw.strip() or "\0" in raw:
        raise Precondition("bad_request", "path must be a non-empty path")
    target = os.path.realpath(os.path.join(cwd, raw))
    items = worktrees(cwd)
    if not items:
        raise Precondition("not_linked_worktree", "no worktrees listed")
    main = items[0]
    if norm(os.path.realpath(main.get("worktree", ""))) == norm(target):
        raise Precondition("main_worktree", "the main worktree is never removed")
    wt = next((w for w in items[1:] if isinstance(w.get("worktree"), str)
               and norm(os.path.realpath(w["worktree"])) == norm(target)), None)
    if wt is None or not os.path.isdir(target):
        raise Precondition("not_linked_worktree", "the path is not a linked worktree of this repository")
    if wt.get("locked"):
        raise Precondition("worktree_locked", "the worktree is locked")
    main_dir = os.path.realpath(main["worktree"])

    code, out, _ = git(["status", "--porcelain", "-z", "--untracked-files=all"], target)
    if code != 0 or out.strip("\0"):
        raise Precondition("worktree_dirty", "git status is not empty (changes or untracked files)")
    code, out, _ = git(["status", "--porcelain", "-z", "--ignored=traditional", "--untracked-files=normal"], target)
    if code != 0:
        raise Precondition("worktree_dirty", "git status --ignored failed")
    for rec in out.split("\0"):
        if rec.startswith("!! ") and not disposable(rec[3:], cfg["worktreeDisposable"]):
            raise Precondition("ignored_files", "ignored file outside safety.ops.worktreeDisposable: %s" % rec[3:])

    code, head, _ = git(["rev-parse", "--verify", "HEAD"], target)
    if code != 0:
        raise Precondition("not_merged", "the worktree has no HEAD commit")
    head = head.strip()
    branch_ref = wt.get("branch") if isinstance(wt.get("branch"), str) else None
    branch = branch_ref[len("refs/heads/"):] if branch_ref and branch_ref.startswith("refs/heads/") else None

    base_ref, _ = resolve_base(main_dir, cfg["baseBranch"])
    merged = git(["merge-base", "--is-ancestor", head, base_ref], main_dir)[0] == 0
    if not merged and branch:
        code, up, _ = git(["rev-parse", "--verify", "--quiet", "--symbolic-full-name", branch + "@{upstream}"], main_dir)
        if code == 0 and up.strip():
            merged = git(["merge-base", "--is-ancestor", head, up.strip()], main_dir)[0] == 0
    if not merged:
        raise Precondition("not_merged", "HEAD is neither merged into %s nor contained in its pushed upstream" % base_ref)

    code, out, _ = git(["stash", "list", "-z", "--format=%H %P%x09%gs"], main_dir)
    if code == 0:
        for rec in out.split("\0"):
            if not rec.strip():
                continue
            shas, _, subject = rec.partition("\t")
            parents = shas.split()[1:]
            names = re.match(r"^(?:WIP on|On) (.+?):", subject)
            if (branch and names and names.group(1) == branch) or (parents and parents[0] == head):
                raise Precondition("stash_references_branch", "a stash entry references this worktree's branch")

    git(["worktree", "remove", target], main_dir, check=True)  # never --force
    result = {"action": "worktree_remove", "path": target, "branch": branch, "branchDeleted": False}
    if branch:
        code, _, err = git(["branch", "-d", branch], main_dir)  # never -D
        result["branchDeleted"] = code == 0
        if code != 0:
            result["branchMessage"] = err.strip()
    return result


OPS = {"move": op_move, "copy": op_copy, "worktree_remove": op_worktree_remove}


def handle(req):
    if not isinstance(req, dict) or req.get("op") not in OPS:
        return {"ok": False, "precondition": "bad_request", "message": "precondition failed: bad_request (unknown op)"}
    try:
        out = OPS[req["op"]](req)
        out["ok"] = True
        return out
    except Precondition as exc:
        msg = "precondition failed: %s" % exc.name
        return {"ok": False, "precondition": exc.name, "message": msg + (" (%s)" % exc.detail if exc.detail else "")}
    except ActionError as exc:
        return {"ok": False, "error": exc.name, "message": "%s: %s" % (exc.name, exc.detail)}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout", "message": "git did not answer within %d s" % GIT_TIMEOUT}
    except OSError as exc:
        return {"ok": False, "error": "os_error", "message": str(exc)}


def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except ValueError:
        req = None
    sys.stdout.write(json.dumps(handle(req)) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
