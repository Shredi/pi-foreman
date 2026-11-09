#!/usr/bin/env python3
"""Worktree housekeeping (stdlib, 3.13+).

    foreman worktree sweep [--cwd D] [--dry-run] [--session S] [--state D]

`sweep` walks every linked worktree of the repository at --cwd (default: the current dir) and
removes each one that passes the session-close preconditions, whether or not a manifest lists it:
safe_ops.check_worktree (clean including ignored files outside safety.ops.worktreeDisposable,
merged into the base branch or contained in its pushed upstream, not locked, no stash) plus no
live non-done session other than S (default CLAUDE_CODE_SESSION_ID) with its cwd inside, and never the
worktree that contains --cwd itself (`in_use_by_caller`). Removal is
`git worktree remove` (never --force) and `git branch -d` (never -D). Each worktree is listed as
`removed:` (`would remove:` with --dry-run) or `skipped: <path> — <reason>`. A worktree outside
close.worktreeDir (`<repo>` = the main worktree's name, relative to the main worktree) and outside
`<repo>/.claude/worktrees` and pi-subagents' default root `../worktrees/<repo>` also gets an `off-convention:` line
(information only).
Exit 0 done, 2 usage, config error or not a git repository.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman_close as fcl  # noqa: E402
import foreman_config as fc  # noqa: E402
import safe_ops  # noqa: E402

SEP = " — "
DEFAULT_DIR = "../<repo>.worktrees"


_UNSET = object()


def main_checkout(path):
    """Main checkout (real path) of the repository holding path, None outside a repository. From the common git dir: its core.worktree when
    set (a submodule), else the parent of a `.git` dir, else (separate or bare git dir) `git worktree list` item 0."""
    dirs = safe_ops.git_dirs_above(path)
    if not dirs:
        return None
    top, _gd, common = dirs
    cw = safe_ops.config_value(os.path.join(common, "config"), "core", "worktree")
    if cw:
        return os.path.realpath(os.path.join(common, cw))
    if os.path.basename(common) == ".git":
        return os.path.dirname(common)
    try:
        return os.path.realpath(safe_ops.worktrees(top)[0]["worktree"])
    except (safe_ops.Precondition, IndexError, KeyError, OSError, subprocess.SubprocessError):
        return None


def _glob_re(pattern):
    parts = pattern.replace("\\", "/").split("*")
    esc = [re.escape(p).replace(r"\?", ".").replace("/", r"[\\/]") for p in parts]
    return re.compile("^" + ".*".join(esc) + "$", re.S | (re.I if safe_ops.CASE_INSENSITIVE else 0))


def _protected(main_dir, home, agent_dir, tmp_root, extra):
    first = [main_dir, home, agent_dir, tmp_root, os.path.abspath(os.sep)] + ([] if os.name == "nt" else ["/tmp", "/private/tmp"]) + [e for e in extra if e]
    return list(dict.fromkeys(p for r in first for p in (os.path.abspath(r), os.path.realpath(r))))


def _blocks(spelled, real, template, prot):
    star = lambda t: t.replace("<repo>", "*").rstrip("/\\") + "/*"
    pats = [star(template)]
    i = template.find("<repo>")
    fixed = (template if i < 0 else template[:max(0, max(template[:i].rfind("/"), template[:i].rfind("\\")) + 1)]).rstrip("/\\")
    real_fixed = os.path.realpath(fixed or template)
    if real_fixed != fixed:
        pats.append(star(template.replace(fixed, real_fixed, 1)))
    res = [_glob_re(p) for p in dict.fromkeys(pats)]
    for p in prot:
        if safe_ops.is_inside(spelled, p, True) or safe_ops.is_inside(real, p, True) or any(r.match(p) or r.match(p.replace("\\", "/")) for r in res):
            return p
    segs = re.split(r"[\\/]", template)
    k = next((n for n, s in enumerate(segs) if "<repo>" in s), -1)
    if k >= 0 and segs[k] == "<repo>":
        prefix = os.sep.join(segs[:k]) or os.sep
        for p in prot:
            if safe_ops.is_inside(prefix, p, True):
                return p
    return None


def resolve_worktree_root(main_dir, raw=None, home=None, agent_dir=None, tmp_root=None, superproject=_UNSET, extra_protected=()):
    """close.worktreeDir for the repo whose main checkout is main_dir (the Python subset of worktreeroot.ts `resolveWorktreeRoot`: no Pi
    install / package / npm roots). Relative values resolve against main_dir, `~` against home; absolute and `~` values need `<repo>`.
    A refused value returns the default root with `error` ({code, message}) and `requested`."""
    home = home or os.path.expanduser("~")
    agent_dir = agent_dir or os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home, ".pi", "agent")
    tmp_root = tmp_root or tempfile.gettempdir()
    repo = re.sub(r"\.git$", "", os.path.basename(main_dir.rstrip("/\\")))
    value = raw.strip() if isinstance(raw, str) and raw.strip() else DEFAULT_DIR

    def template_of(v):
        if v == "~" or v.startswith(("~/", "~\\")):
            v = os.path.join(home, v[1:].lstrip("/\\"))
        return os.path.normpath(os.path.join(main_dir, v))

    default_t = template_of(DEFAULT_DIR)

    def mk(t):
        spelled = t.replace("<repo>", repo)
        return {"spelled": spelled, "real": os.path.realpath(spelled), "repo": repo, "custom": t != default_t, "template": t}

    def refuse(code, msg, asked):
        return dict(mk(default_t), custom=False, error={"code": code, "message": msg}, requested=asked["spelled"])

    tilde = value == "~" or value.startswith(("~/", "~\\"))
    absolute = tilde or os.path.isabs(value)
    asked = mk(template_of(value))
    if absolute and "<repo>" not in value:
        return refuse("no_repo_placeholder", "close.worktreeDir `%s` is an absolute path without `<repo>`; add `<repo>` so each repo gets its own folder" % value, asked)
    if not absolute:
        sup = superproject
        if sup is _UNSET:
            code, out, _e = safe_ops.git(["rev-parse", "--show-superproject-working-tree"], main_dir)
            sup = out.splitlines()[0] if code == 0 and out.strip() else None
        if sup and (safe_ops.is_inside(sup, asked["spelled"], True) or safe_ops.is_inside(sup, asked["real"], True)):
            return refuse("root_inside_superproject", "close.worktreeDir `%s` puts the worktrees of the submodule %s inside its superproject (%s); use an absolute root such as `~/worktrees/<repo>`" % (value, repo, sup), asked)
    if asked["template"] != default_t:
        bad = _blocks(asked["spelled"], asked["real"], asked["template"], _protected(main_dir, home, agent_dir, tmp_root, extra_protected))
        if bad:
            return refuse("root_blocks_protected", "close.worktreeDir `%s` would cover %s, which children must keep reaching; choose a root that holds only worktrees" % (value, bad), asked)
    return asked


def root_collision(main_dir, root):
    """Message when another repo's worktree sits directly in `root` (a child with a `.git` file whose main checkout is not main_dir), else None."""
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return None
    mine = os.path.realpath(main_dir)
    for name in names:
        wt = os.path.join(root, name)
        if not os.path.isfile(os.path.join(wt, ".git")):
            continue
        other = main_checkout(wt)
        if other and other != mine:
            return "worktree root `%s` already holds worktrees of `%s`; rename one checkout or use a relative `close.worktreeDir`" % (root, other)
    return None


def convention_dirs(main_dir, cfg):
    raw = (cfg.get("close") or {}).get("worktreeDir")
    root = resolve_worktree_root(main_dir, raw)
    # third root: pi-subagents' managed worktrees, `{dirname(repo)}/worktrees/<project>/pi-worktree-<run>-<n>`
    return [root["real"], os.path.realpath(os.path.join(main_dir, ".claude", "worktrees")),
            os.path.realpath(os.path.join(main_dir, "..", "worktrees", os.path.basename(main_dir)))]


def sweep(cwd, cfg, state, sid, dry_run=False):
    """Lines of the sweep report; raises safe_ops.Precondition when cwd is not a git repo."""
    safe_ops.workspace_root(cwd)
    items = safe_ops.worktrees(cwd)
    main_dir = main_checkout(cwd) or os.path.realpath(items[0]["worktree"])
    conv = convention_dirs(main_dir, cfg)
    ops_cfg = safe_ops.ops_config(cfg)
    caller = os.path.realpath(cwd)
    lines = []
    def nested_in(tree):
        # checkouts living inside another worktree of this listing (or holding gitlinks): pi-foreman never removes those here
        try:
            gl = safe_ops.list_gitlinks(tree)
        except safe_ops.Precondition:
            gl = []
        return [g for g in gl if os.path.lexists(os.path.join(tree, g, ".git"))]

    listed = [os.path.realpath(os.path.normpath(w["worktree"])) for w in items[1:] if isinstance(w.get("worktree"), str)]
    for w in items[1:]:
        path = w.get("worktree")
        if not isinstance(path, str):
            continue
        path = os.path.normpath(path)  # git prints `/` on Windows too
        real = os.path.realpath(path)
        if any(o != real and safe_ops.is_inside(o, real) for o in listed):
            lines.append("skipped: %s%s%s" % (path, SEP, "nested_worktree"))
            continue
        above = safe_ops.git_dirs_above(os.path.dirname(real))
        if above and above[0] != os.path.realpath(main_dir):
            # another checkout (a submodule's superproject, a worktree of some other tool) holds this one: it is not ours to remove
            lines.append("skipped: %s%s%s" % (path, SEP, "nested_worktree"))
            continue
        if not any(safe_ops.is_inside(d, real) for d in conv):
            lines.append("off-convention: %s" % path)
        reason, chk = None, None
        user = fcl.in_use_by(state, sid, real)
        if user:
            reason = "in_use (session %s)" % user
        elif safe_ops.is_inside(real, caller, True):
            reason = "in_use_by_caller"
        elif not os.path.isdir(real):
            reason = "missing"
        else:
            try:
                chk = safe_ops.check_worktree(real, real, ops_cfg)
            except safe_ops.Precondition as exc:
                reason = exc.name
            except (safe_ops.ActionError, subprocess.SubprocessError, OSError) as exc:
                reason = "check_failed (%s)" % str(exc)[:80]
        if reason is None:
            nested = nested_in(real)
            if nested:
                reason = "nested_checkouts (%s)" % ", ".join(nested[:3])
                chk = None
        if reason is None and dry_run:
            lines.append("would remove: %s" % path)
            continue
        if reason is None:
            try:
                safe_ops.remove_worktree(chk)
                lines.append("removed: %s" % path)
                continue
            except (safe_ops.ActionError, subprocess.SubprocessError, OSError) as exc:
                reason = "remove_failed (%s)" % str(exc)[:80]
        lines.append("skipped: %s%s%s" % (path, SEP, reason))
    return lines or ["no linked worktrees"]


def main(argv=None):
    p = argparse.ArgumentParser(prog="foreman worktree")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("sweep")
    s.add_argument("--cwd")
    s.add_argument("--dry-run", action="store_true")
    s.add_argument("--session")
    s.add_argument("--state")
    try:
        a = p.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    if a.cmd != "sweep":
        p.print_usage(sys.stderr)
        return 2
    cwd = os.path.abspath(a.cwd or os.getcwd())
    state = os.path.abspath(os.path.expanduser(a.state or fcl.default_state()))
    sid = (a.session or os.environ.get(fcl.SESSION_ENV, "")).strip()
    try:
        res = fc.load_config(os.path.dirname(os.path.dirname(state)), cwd)
    except fc.ConfigError as exc:
        print("foreman worktree: %s" % exc, file=sys.stderr)
        return 2
    if res["errors"]:
        print("foreman worktree: config errors: %s" % "; ".join(res["errors"]), file=sys.stderr)
        return 2
    try:
        lines = sweep(cwd, res["config"], state, sid, a.dry_run)
    except safe_ops.Precondition as exc:
        print("foreman worktree: %s (%s)" % (exc.name, exc.detail), file=sys.stderr)
        return 2
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
