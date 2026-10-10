#!/usr/bin/env python3
"""Worktree housekeeping (stdlib, 3.9+).

    foreman worktree sweep [--cwd D] [--dry-run] [--session S] [--state D]

`sweep` walks every linked worktree of the repository at --cwd (default: the current dir) and
removes each one that passes the session-close preconditions, whether or not a manifest lists it:
safe_ops.check_worktree (clean including ignored files outside safety.ops.worktreeDisposable,
merged into the base branch or contained in its pushed upstream, not locked, no stash) plus no
live non-done session other than S (default CLAUDE_CODE_SESSION_ID) with its cwd inside. Removal is
`git worktree remove` (never --force) and `git branch -d` (never -D). Each worktree is listed as
`removed:` (`would remove:` with --dry-run) or `skipped: <path> — <reason>`. A worktree outside
close.worktreeDir (`<repo>` = the main worktree's name, relative to the main worktree) and outside
`<repo>/.claude/worktrees` also gets an `off-convention:` line (information only).
Exit 0 done, 2 usage, config error or not a git repository.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman_close as fcl  # noqa: E402
import foreman_config as fc  # noqa: E402
import safe_ops  # noqa: E402

SEP = " — "
DEFAULT_DIR = "../<repo>.worktrees"


def convention_dirs(main_dir, cfg):
    raw = (cfg.get("close") or {}).get("worktreeDir")
    raw = raw if isinstance(raw, str) and raw.strip() else DEFAULT_DIR
    raw = os.path.expanduser(raw.replace("<repo>", os.path.basename(main_dir)))
    return [os.path.realpath(os.path.join(main_dir, raw)), os.path.realpath(os.path.join(main_dir, ".claude", "worktrees"))]


def sweep(cwd, cfg, state, sid, dry_run=False):
    """Lines of the sweep report; raises safe_ops.Precondition when cwd is not a git repo."""
    safe_ops.workspace_root(cwd)
    items = safe_ops.worktrees(cwd)
    main_dir = os.path.realpath(items[0]["worktree"])
    conv = convention_dirs(main_dir, cfg)
    ops_cfg = safe_ops.ops_config(cfg)
    lines = []
    for w in items[1:]:
        path = w.get("worktree")
        if not isinstance(path, str):
            continue
        path = os.path.normpath(path)  # git prints `/` on Windows too
        real = os.path.realpath(path)
        if not any(safe_ops.is_inside(d, real) for d in conv):
            lines.append("off-convention: %s" % path)
        reason, chk = None, None
        user = fcl.in_use_by(state, sid, real)
        if user:
            reason = "in_use (session %s)" % user
        elif not os.path.isdir(real):
            reason = "missing"
        else:
            try:
                chk = safe_ops.check_worktree(real, real, ops_cfg)
            except safe_ops.Precondition as exc:
                reason = exc.name
            except (safe_ops.ActionError, subprocess.SubprocessError, OSError) as exc:
                reason = "check_failed (%s)" % str(exc)[:80]
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
