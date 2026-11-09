"""Nested submodule fixture, built by hand the way an outside tool would (never by pi-foreman); twin of extensions/core-adapter/test/_submodules.ts."""
from __future__ import annotations

import os
import subprocess
from types import SimpleNamespace


def git(cwd, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    r = subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "protocol.file.allow=always"] + list(args),
                       cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    return r.stdout.decode().strip()


def build_rig(base):
    """base: fresh empty dir (real path). Superproject at base/super, linked tree at base/super.worktrees/round with a linked submodule
    worktree (libs/a), a plain submodule checkout (b), a stray clone holding a linked worktree of b, a foreign clone and a forged gitfile."""
    base = str(base)
    j = os.path.join
    src, sup, tree = j(base, "src"), j(base, "super"), j(base, "super.worktrees", "round")
    for n in ("a", "b"):
        os.makedirs(j(src, n))
        git(j(src, n), "init", "-q", "-b", "main")
        with open(j(src, n, "f"), "w") as fh:
            fh.write(n + "\n")
        git(j(src, n), "add", "f")
        git(j(src, n), "commit", "-q", "-m", "init")
    os.makedirs(sup)
    git(sup, "init", "-q", "-b", "main")
    with open(j(sup, "r"), "w") as fh:
        fh.write("r\n")
    git(sup, "add", "r")
    git(sup, "commit", "-q", "-m", "init")
    os.makedirs(j(sup, "libs"))
    git(sup, "clone", "-q", j(src, "a"), "libs/a")
    git(sup, "clone", "-q", j(src, "b"), "b")
    mods = ""
    for p, n in (("libs/a", "a"), ("b", "b")):
        git(sup, "update-index", "--add", "--cacheinfo", "160000,%s,%s" % (git(j(sup, p), "rev-parse", "HEAD"), p))
        mods += '[submodule "%s"]\n\tpath = %s\n\turl = %s\n' % (p, p, j(src, n))
        git(sup, "config", "submodule.%s.url" % p, j(src, n))
    with open(j(sup, ".gitmodules"), "w") as fh:
        fh.write(mods)
    git(sup, "add", ".gitmodules")
    git(sup, "commit", "-q", "-m", "submodules")
    git(sup, "submodule", "absorbgitdirs")
    git(sup, "worktree", "add", "-q", "-b", "round", tree)
    linked = j(tree, "libs", "a")
    git(j(sup, "libs", "a"), "worktree", "add", "-q", "-b", "round", linked)
    plain = j(tree, "b")
    admin_tree = git(tree, "rev-parse", "--absolute-git-dir")
    os.makedirs(j(admin_tree, "modules"), exist_ok=True)
    git(tree, "clone", "-q", "--separate-git-dir", j(admin_tree, "modules", "b"), j(src, "b"), "b")
    admin_plain = j(admin_tree, "modules", "b")  # `git submodule` writes core.worktree; a plain clone does not
    git(tree, "config", "--file", j(admin_plain, "config"), "core.worktree", os.path.relpath(plain, admin_plain))
    stray = j(tree, "stray")
    inner = j(stray, "inner")
    git(j(sup, "b"), "worktree", "add", "-q", "-b", "stray", inner)
    git(stray, "init", "-q")
    foreign = j(linked, "vendor", "foreign")
    os.makedirs(foreign)
    git(foreign, "init", "-q")
    forged = j(tree, "forged")
    os.makedirs(forged)
    admin_b = j(sup, ".git", "modules", "b")
    with open(j(forged, ".git"), "w") as fh:
        fh.write("gitdir: %s\n" % admin_b)
    return SimpleNamespace(superproject=sup, tree=tree, linked_sub=linked, plain_sub=plain, stray_inner=inner, foreign=foreign, forged=forged)
