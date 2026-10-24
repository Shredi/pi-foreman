#!/usr/bin/env python3
"""pi-subagents worktree setup hook (stdlib, 3.13+).

pi-subagents links the main checkout's node_modules into every managed worktree BEFORE it runs the
post-create hook, so a builder that runs `npm ci` there rewrites the main checkout. This hook turns
that link into a real directory when the repository has a lockfile:

    foreman-worktree-setup [WORKTREE]

pi-subagents runs the hook with the worktree as cwd and a JSON object on stdin
(`worktreePath`, `repoRoot`, ...); WORKTREE overrides both. When `node_modules` in the worktree is a
symlink or junction and `package-lock.json` or `npm-shrinkwrap.json` exists there, the link is removed
and the link target is copied with `shutil.copytree(symlinks=True)` (no hard links), or `npm ci` runs
when the target has no node_modules. Without a lockfile the link stays. Always exits 0 and prints `{}`
on stdout (an empty stdout fails the worktree creation); one status line goes to stderr.
"""
from __future__ import annotations

import json
import os
import select
import shutil
import stat
import subprocess
import sys

LOCKFILES = ("package-lock.json", "npm-shrinkwrap.json")
NPM_TIMEOUT = 540


def is_link(path):
    """Symlink, or a Windows junction (islink is false for those on older Pythons)."""
    if os.path.islink(path):
        return True
    isj = getattr(os.path, "isjunction", None)
    return bool(isj and isj(path))


def _available(fd):
    """Bytes can be read from `fd` now, without waiting. POSIX: select with a zero timeout (a pipe that is
    open but empty is not ready). Windows: select does not take pipes, so only a regular file counts."""
    if os.name == "nt":
        return stat.S_ISREG(os.fstat(fd).st_mode)
    try:
        return bool(select.select([fd], [], [], 0)[0])
    except (OSError, ValueError):
        return False


def read_input():
    """The JSON object pi-subagents writes on stdin, read only when data is ready: an open pipe with
    nothing written (a caller that keeps stdin open) or a tty yields {} at once instead of blocking."""
    if sys.stdin is None:
        return {}
    try:
        if sys.stdin.isatty():
            return {}
        fd = sys.stdin.fileno()
        chunks = []
        while _available(fd):
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        data = json.loads(b"".join(chunks).decode("utf-8") or "{}")
    except (ValueError, OSError, AttributeError):
        return {}
    return data if isinstance(data, dict) else {}


def materialise(worktree, repo_root=None):
    """Replace a symlinked node_modules by a real directory. Returns the status line."""
    nm = os.path.join(worktree, "node_modules")
    if not is_link(nm):
        return "node_modules is not a link in %s: nothing to do" % worktree
    if not any(os.path.isfile(os.path.join(worktree, name)) for name in LOCKFILES):
        return "no lockfile in %s: node_modules link kept" % worktree
    target = os.path.realpath(nm)
    if not os.path.isdir(target) and repo_root:
        target = os.path.join(repo_root, "node_modules")
    if os.path.isdir(target):
        # copy beside the link first and rename into place: a failed copy leaves the link, never a partial directory
        tmp = nm + ".foreman-tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            shutil.copytree(target, tmp, symlinks=True)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        if os.path.islink(nm):
            os.unlink(nm)
        else:
            os.rmdir(nm)  # junction
        os.rename(tmp, nm)
        return "node_modules copied from %s into %s" % (target, worktree)
    if os.path.islink(nm):
        os.unlink(nm)
    else:
        os.rmdir(nm)  # junction
    npm = shutil.which("npm")
    if not npm:
        return "node_modules link removed in %s but the target has none and npm is missing" % worktree
    done = subprocess.run([npm, "ci"], cwd=worktree, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=NPM_TIMEOUT)
    return "npm ci in %s exited %d" % (worktree, done.returncode)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        info = read_input()
        worktree = argv[0] if argv else (info.get("worktreePath") or os.getcwd())
        line = materialise(os.path.abspath(worktree), info.get("repoRoot") if isinstance(info.get("repoRoot"), str) else None)
    except Exception as exc:  # never fail a worktree creation
        line = "failed: %s" % exc
    print("foreman-worktree-setup: %s" % line, file=sys.stderr)
    print("{}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
