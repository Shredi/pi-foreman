#!/usr/bin/env python3
"""pi-subagents worktree setup hook (stdlib, 3.9+).

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
import shutil
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


def read_input():
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except (ValueError, OSError):
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
    if os.path.islink(nm):
        os.unlink(nm)
    else:
        os.rmdir(nm)  # junction
    if os.path.isdir(target):
        shutil.copytree(target, nm, symlinks=True)
        return "node_modules copied from %s into %s" % (target, worktree)
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
