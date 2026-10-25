#!/usr/bin/env python3
"""Session close: ownership manifest, CLOSE report, cleanup and handovers (stdlib, 3.13+).

    foreman close [--session S] [--cwd D] [--state D] [--dry-run] [--result PATH] [--json]
                  [--trusted-project]
    foreman close record --kind worktree|scratch|handoff --path P [--branch B] [--base B]
                  [--owner O] [--class private|round|durable] [--session S] [--state D]
    foreman close --take PATH | --drop PATH [--session S] [--state D]
    foreman close merged --ws D --ref REF [--base B]    (prints {"merged": true|false}; needs no session)

Session S defaults to CLAUDE_CODE_SESSION_ID; the state dir to PI_FOREMAN_STATE_DIR, else
`<agentDir>/pi-foreman/state` (foreman_config.resolve_agent_dir). This module is the single writer
of `<state>/sessions/<S>/manifest.json` and `close.json` (docs/close.md):

    manifest  {v:1, session, entries:[{path, kind, class, owner, branch?, base?, ts, removed?}], dropped:[path]}

Entries are additive and deduplicated by realpath; writes hold `<file>.lock` (O_CREAT|O_EXCL, as
foreman_backlog) and go through a temp file plus os.replace (retried on Windows). A directory
`<state>/scratch/<S>/` is an implicit private scratch entry; handoff entries are durable (kept).
An entry this session removed is marked `removed: <ts>` (never deleted from the manifest), so every
later report of the session lists it under `removed` again and never as a handover.

Report (text and close.json `lines`): `CLOSE: ready|open`, then `uncommitted:`, `unmerged:`,
`open item:`, `pending child:`, `removed:` / `would remove:`, `kept:`, `handover: <path> — <reason>`,
`child handover: <path> — <reason> (from <sid>)`. Open when anything uncommitted, unmerged, open,
pending or an untaken child handover remains; this session's own handovers block only when it has
no parent. Cleanup runs when close.autoClean is on and not --dry-run; only manifest paths are ever
touched. Exit 0 ready, 3 open, 2 usage or config error (record, take, drop: 0 ok).
"""
from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman_backlog as fb  # noqa: E402
import foreman_config as fc  # noqa: E402
import foreman_sync as fsync  # noqa: E402
import safe_ops  # noqa: E402

STATE_ENV = "PI_FOREMAN_STATE_DIR"
SESSION_ENV = "CLAUDE_CODE_SESSION_ID"
KINDS = ("worktree", "scratch", "handoff")
CLASSES = ("private", "round", "durable")
LIVE_REGISTRY = ("pending", "open", "closing")
OPEN_ITEM_RE = re.compile(r"^\s*[-*] \[ \](?:\s.*)?$")  # core ledger_guard_stop.OPEN_ITEM_RE
MAX_LINES = 40
SEP = " — "


class Usage(Exception):
    pass


# ------------------------------------------------------------------ paths and io

def safe_sid(sid):
    """The core's session-id filter (alphanumerics, `-`, `_`), as in marker.ts."""
    return "".join(c for c in (sid or "") if c.isascii() and (c.isalnum() or c in "-_"))


def default_state():
    env = os.environ.get(STATE_ENV, "").strip()
    return env if env else str(fc.resolve_agent_dir() / "pi-foreman" / "state")


def session_dir(state, sid):
    return os.path.join(state, "sessions", safe_sid(sid))


def manifest_path(state, sid):
    return os.path.join(session_dir(state, sid), "manifest.json")


def close_path(state, sid):
    return os.path.join(session_dir(state, sid), "close.json")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_json(path, data):
    """Atomic write: temp file in the same directory, then os.replace (Windows retry)."""
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=1)
            fh.write("\n")
        for attempt in range(10):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows: a reader holds the target open
                if attempt == 9:
                    raise
                time.sleep(0.05)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def key(path):
    return safe_ops.norm(os.path.realpath(path))


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ manifest

def load_manifest(state, sid):
    m = read_json(manifest_path(state, sid))
    if not isinstance(m, dict):
        m = {}
    entries = [e for e in m.get("entries") or [] if isinstance(e, dict) and isinstance(e.get("path"), str)]
    dropped = [p for p in m.get("dropped") or [] if isinstance(p, str)]
    return {"v": 1, "session": sid, "entries": entries, "dropped": dropped}


def record(state, sid, kind, path, cls=None, owner=None, branch=None, base=None):
    """Append one entry (deduplicated by realpath); returns the stored entry."""
    if kind not in KINDS:
        raise Usage("--kind must be one of %s" % "|".join(KINDS))
    if not isinstance(path, str) or not path.strip() or "\0" in path:
        raise Usage("--path must be a non-empty path")
    cls = "durable" if kind == "handoff" else (cls or "private")
    if cls not in CLASSES:
        raise Usage("--class must be one of %s" % "|".join(CLASSES))
    full = os.path.abspath(os.path.expanduser(path))
    mp = manifest_path(state, sid)
    with fb.locked(mp):
        m = load_manifest(state, sid)
        k = key(full)
        for e in m["entries"]:
            if key(e["path"]) == k:
                for name, val in (("branch", branch), ("base", base)):
                    if val and not e.get(name):
                        e[name] = val
                write_json(mp, m)
                return e
        e = {"path": full, "kind": kind, "class": cls, "owner": owner or sid, "ts": now()}
        if branch:
            e["branch"] = branch
        if base:
            e["base"] = base
        m["entries"].append(e)
        write_json(mp, m)
        return e


def take(state, sid, path):
    """Parent takes a child's handover: it becomes this session's manifest entry."""
    full = os.path.abspath(os.path.expanduser(path))
    found = next((h for h in child_handovers(state, sid, me_ids(state, sid), None, None) if key(h["path"]) == key(full)), None)
    kind = (found or {}).get("kind")
    if kind not in KINDS:
        kind = "worktree" if os.path.isfile(os.path.join(full, ".git")) else "scratch"
    e = record(state, sid, kind, full, branch=(found or {}).get("branch"))
    mp = manifest_path(state, sid)
    with fb.locked(mp):
        m = load_manifest(state, sid)
        m["dropped"] = [p for p in m["dropped"] if key(p) != key(full)]
        write_json(mp, m)
    return e


def drop(state, sid, path):
    """Parent decides nobody keeps a child's handover: never listed again, nothing removed."""
    full = os.path.abspath(os.path.expanduser(path))
    mp = manifest_path(state, sid)
    with fb.locked(mp):
        m = load_manifest(state, sid)
        if all(key(p) != key(full) for p in m["dropped"]):
            m["dropped"].append(full)
        write_json(mp, m)


# ------------------------------------------------------------------ sources

def live_files(state):
    out = []
    for p in sorted(glob.glob(os.path.join(state, "live", "*.json"))):
        d = read_json(p)
        if isinstance(d, dict):
            d.setdefault("sessionId", os.path.basename(p)[:-5])
            out.append(d)
    return out


def my_live(state, sid):
    for d in live_files(state):
        if d.get("sessionId") in (sid, safe_sid(sid)):
            return d
    return {}


def me_ids(state, sid):
    ids = {sid, safe_sid(sid)}
    ic = my_live(state, sid).get("intercomId")
    if isinstance(ic, str) and ic:
        ids.add(ic)
    return ids


def parent_of(live):
    for val in (live.get("parentIntercom"), os.environ.get("PI_FOREMAN_PARENT_INTERCOM"),
                os.environ.get("PI_SUBAGENT_PARENT_SESSION")):
        if isinstance(val, str) and val.strip():
            return val.strip()
    return None


def in_use_by(state, sid, path):
    """Session id of a live, non-done session other than `sid` whose cwd is inside `path`."""
    for d in live_files(state):
        if d.get("sessionId") in (sid, safe_sid(sid)) or d.get("state") == "done":
            continue
        cwd = d.get("cwd")
        if isinstance(cwd, str) and cwd and safe_ops.is_inside(os.path.realpath(path), os.path.realpath(cwd), True):
            return str(d.get("sessionId"))
    return None


def repo_roots(cwd, cfg):
    roots = []
    cands = [cwd] + [os.path.expanduser(r["path"]) for r in (cfg.get("sync") or {}).get("repos") or []
                     if isinstance(r, dict) and isinstance(r.get("path"), str) and r["path"].strip()]
    for c in cands:
        if not os.path.isdir(c):
            continue
        code, top, _ = fsync.git(["rev-parse", "--show-toplevel"], c)
        if code == 0 and top.strip():
            r = os.path.realpath(top.strip())
            if all(key(r) != key(x) for x in roots):
                roots.append(r)
    return roots


def uncommitted(roots):
    out = []
    for r in roots:
        try:
            paths = fsync.status_paths(r)
        except RuntimeError:
            continue
        if paths:
            out.append({"repo": r, "paths": paths})
    return out


def merged_into_base(ws, ref, base_cfg):
    """True when `ref` is in the base branch (no upstream clause)."""
    try:
        base_ref, _ = safe_ops.resolve_base(ws, base_cfg)
    except safe_ops.Precondition:
        return False
    return bool(base_ref) and fsync.git(["merge-base", "--is-ancestor", ref, base_ref], ws)[0] == 0


def merged_into(ws, ref, base_cfg):
    """True when `ref` is in the base branch or in its pushed upstream."""
    if merged_into_base(ws, ref, base_cfg):
        return True
    code, up, _ = fsync.git(["rev-parse", "--verify", "--quiet", "--symbolic-full-name", ref + "@{upstream}"], ws)
    return code == 0 and bool(up.strip()) and fsync.git(["merge-base", "--is-ancestor", ref, up.strip()], ws)[0] == 0


def unmerged(state, sid, base_cfg):
    out, seen = [], set()
    for r in fsync.read_created(state):
        ws, br = r.get("workspace"), r.get("branch")
        if r.get("session") != sid or not isinstance(ws, str) or not isinstance(br, str) or not os.path.isdir(ws):
            continue
        if (key(ws), br) in seen:
            continue
        seen.add((key(ws), br))
        if fsync.git(["rev-parse", "--verify", "--quiet", "refs/heads/" + br], ws)[0] != 0:
            continue  # deleted: nothing left to merge
        if not merged_into(ws, br, base_cfg):
            out.append({"branch": br, "workspace": ws})
    return out


def bound_ledger(state, sid):
    name = "fable-orch-model-%s.json" % safe_sid(sid)
    for d in (state, tempfile.gettempdir()):
        m = read_json(os.path.join(d, name))
        if isinstance(m, dict) and isinstance(m.get("ledger"), str) and os.path.isfile(m["ledger"]):
            return m["ledger"]
    return None


def open_items(ledger):
    """Open `- [ ]` items outside ``` fences (deferred items are `[~]` and never match)."""
    if not ledger:
        return []
    try:
        with open(ledger, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return []
    out, fenced = [], False
    for ln in lines:
        if ln.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced and OPEN_ITEM_RE.match(ln):
            out.append(re.sub(r"^\s*[-*] \[ \]\s*", "", ln)[:120])
    return out


def pending_children(state, sid, ids):
    out, seen = [], set()
    lives = live_files(state)
    done = {d.get("intercomId") for d in lives if d.get("state") == "done"}
    for d in lives:
        if d.get("parentIntercom") in ids and d.get("state") != "done" and d.get("sessionId") not in ids:
            out.append({"id": str(d.get("intercomId") or d.get("sessionId")), "state": str(d.get("state"))})
            seen.add(d.get("intercomId"))
    reg = read_json(os.path.join(state, "sessions.json"))
    for s in (reg.get("sessions") if isinstance(reg, dict) else None) or []:
        if not isinstance(s, dict) or s.get("parent") not in ids or s.get("status") not in LIVE_REGISTRY:
            continue
        if s.get("child") in seen or s.get("child") in done:
            continue
        seen.add(s.get("child"))
        out.append({"id": str(s.get("label") or s.get("child")), "state": str(s.get("status"))})
    return out


def child_handovers(state, sid, ids, manifest, dropped):
    """Handovers in other sessions' close.json whose parent is this session, not taken nor dropped."""
    taken = {key(e["path"]) for e in (manifest or [])} | {key(p) for p in (dropped or [])}
    out = []
    for p in sorted(glob.glob(os.path.join(state, "sessions", "*", "close.json"))):
        d = read_json(p)
        if not isinstance(d, dict) or d.get("parent") not in ids or d.get("session") in ids:
            continue
        for h in d.get("handovers") or []:
            if not isinstance(h, dict) or not isinstance(h.get("path"), str):
                continue
            if not os.path.lexists(h["path"]) or key(h["path"]) in taken:
                continue
            out.append(dict(h, **{"from": str(d.get("session"))}))
    return out


# ------------------------------------------------------------------ cleanup

def scratch_guard(path, state):
    """None when `path` may be removed as scratch, else the reason. Never follows a symlink."""
    if safe_ops.is_link(path):
        return "symlink"
    real = os.path.realpath(path)
    if not os.path.isdir(real):
        return "not_a_directory"  # files directly in .workflow/scratch/ (plan, result, ledger) are durable
    parts = [x.lower() if safe_ops.CASE_INSENSITIVE else x for x in re.split(r"[\\/]+", real) if x]
    for i in range(len(parts) - 2):
        if parts[i] == ".workflow" and parts[i + 1] == "scratch":
            return None
    if safe_ops.is_inside(os.path.join(os.path.realpath(state), "scratch"), real):
        return None
    return "outside_scratch"


def remove_scratch(path):
    real = os.path.realpath(path)
    trash = shutil.which("trash")
    if trash:
        r = subprocess.run([trash, real], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=60)
        if r.returncode != 0:
            raise OSError("trash failed: %s" % r.stderr.decode("utf-8", "replace").strip()[:120])
    else:
        shutil.rmtree(real)


def check_entry(e, state, sid, ops_cfg):
    """(None, worktree check) when the entry may go, else (reason, None)."""
    path = e["path"]
    user = in_use_by(state, sid, path)
    if user:
        return "in_use (session %s)" % user, None
    if e["kind"] == "scratch":
        return scratch_guard(path, state), None
    if not os.path.isdir(path):
        return "not_linked_worktree", None
    try:
        return None, safe_ops.check_worktree(path, path, ops_cfg)
    except safe_ops.Precondition as exc:
        return exc.name, None
    except (safe_ops.ActionError, subprocess.SubprocessError, OSError) as exc:
        return "check_failed (%s)" % str(exc)[:80], None


def cleanup(entries, state, sid, ops_cfg, auto_clean, dry_run):
    res = {"removed": [], "wouldRemove": [], "kept": [], "handovers": []}
    for e in entries:
        path = e["path"]
        if e["kind"] == "handoff":
            res["kept"].append(path)
            continue
        if not os.path.lexists(path):
            if e.get("removed"):
                res["removed"].append(path)  # removed earlier in this session (mark_removed)
            continue
        if not auto_clean:
            res["handovers"].append({"path": path, "reason": "autoClean off", "kind": e["kind"], "branch": e.get("branch")})
            continue
        reason, chk = check_entry(e, state, sid, ops_cfg)
        if reason is None and dry_run:
            res["wouldRemove"].append(path)
            continue
        if reason is None:
            try:
                if e["kind"] == "scratch":
                    reason = scratch_guard(path, state)  # re-check right before the removal
                    if reason is None:
                        remove_scratch(path)
                else:
                    safe_ops.remove_worktree(chk)
            except (safe_ops.ActionError, subprocess.SubprocessError, OSError) as exc:
                reason = "remove_failed (%s)" % str(exc)[:80]
        if reason is None:
            res["removed"].append(path)
        else:
            res["handovers"].append({"path": path, "reason": reason, "kind": e["kind"], "branch": e.get("branch")})
    return res


def mark_removed(state, sid, paths):
    """Mark removed entries `removed: <ts>` in the manifest (idempotent; the implicit scratch is added)."""
    if not paths:
        return
    mp = manifest_path(state, sid)
    with fb.locked(mp):
        m = load_manifest(state, sid)
        changed = False
        for p in paths:
            e = next((x for x in m["entries"] if key(x["path"]) == key(p)), None)
            if e is None:
                e = {"path": p, "kind": "scratch", "class": "private", "owner": sid, "ts": now()}
                m["entries"].append(e)
            if not e.get("removed"):
                e["removed"] = now()
                changed = True
        if changed:
            write_json(mp, m)


# ------------------------------------------------------------------ report

def entries_of(state, sid, m):
    entries = list(m["entries"])
    implicit = os.path.join(state, "scratch", safe_sid(sid))
    if os.path.isdir(implicit) and all(key(e["path"]) != key(implicit) for e in entries):
        entries.append({"path": implicit, "kind": "scratch", "class": "private", "owner": sid})
    dropped = {key(p) for p in m["dropped"]}
    return [e for e in entries if e.get("kind") in KINDS and key(e["path"]) not in dropped]


def build(state, sid, cwd, cfg, clean=True, dry_run=False):
    """The close report as a dict (close.json shape). `clean` False = report only (no removal)."""
    ops_cfg = safe_ops.ops_config(cfg)
    auto = (cfg.get("close") or {}).get("autoClean", True) is not False
    live = my_live(state, sid)
    ids = me_ids(state, sid)
    parent = parent_of(live)
    m = load_manifest(state, sid)
    rep = {"v": 1, "session": sid, "parent": parent, "ts": now(), "dryRun": bool(dry_run or not clean),
           "uncommitted": uncommitted(repo_roots(cwd, cfg)),
           "unmerged": unmerged(state, sid, ops_cfg["baseBranch"]),
           "openItems": open_items(bound_ledger(state, sid)),
           "pendingChildren": pending_children(state, sid, ids)}
    rep.update(cleanup(entries_of(state, sid, m), state, sid, ops_cfg, auto, dry_run or not clean))
    mark_removed(state, sid, rep["removed"])
    rep["childHandovers"] = child_handovers(state, sid, ids, m["entries"], m["dropped"])
    blocking = (rep["uncommitted"] or rep["unmerged"] or rep["openItems"] or rep["pendingChildren"]
                or rep["childHandovers"] or (rep["handovers"] and not parent))
    rep["ready"] = not blocking
    rep["lines"] = render_lines(rep)
    return rep


def render_lines(rep):
    lines = ["CLOSE: %s" % ("ready" if rep["ready"] else "open")]
    for u in rep["uncommitted"]:
        shown = ", ".join(u["paths"][:3]) + (" +%d more" % (len(u["paths"]) - 3) if len(u["paths"]) > 3 else "")
        lines.append("uncommitted: %s (%s)" % (u["repo"], shown))
    lines += ["unmerged: %s (%s)" % (u["branch"], u["workspace"]) for u in rep["unmerged"]]
    lines += ["open item: %s" % t for t in rep["openItems"]]
    lines += ["pending child: %s (%s)" % (c["id"], c["state"]) for c in rep["pendingChildren"]]
    lines += ["removed: %s" % p for p in rep["removed"]]
    lines += ["would remove: %s" % p for p in rep["wouldRemove"]]
    lines += ["kept: %s" % p for p in rep["kept"]]
    lines += ["handover: %s%s%s" % (h["path"], SEP, h["reason"]) for h in rep["handovers"]]
    lines += ["child handover: %s%s%s (from %s)" % (h["path"], SEP, h.get("reason"), h["from"])
              for h in rep["childHandovers"]]
    return lines


def capped(lines, limit, where):
    if len(lines) <= limit:
        return list(lines)
    return lines[:limit - 1] + ["... (%d more lines, see %s)" % (len(lines) - limit + 1, where)]


def run(state, sid, cwd, cfg, clean=True, dry_run=False, result=None):
    """Build the report; write close.json unless dry_run; append `## Close` to `result`."""
    rep = build(state, sid, cwd, cfg, clean=clean, dry_run=dry_run)
    if not dry_run:
        write_json(close_path(state, sid), rep)
    if result:
        with open(result, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("\n## Close\n\n" + "\n".join(rep["lines"]) + "\n")
    return rep


# ------------------------------------------------------------------ cli

def common(p):
    p.add_argument("--session")
    p.add_argument("--state")


def parse(argv):
    if argv and argv[0] == "merged":
        p = argparse.ArgumentParser(prog="foreman close merged")
        p.add_argument("--ws", required=True)
        p.add_argument("--ref", required=True)
        p.add_argument("--base")
        a = p.parse_args(argv[1:])
        a.cmd = "merged"
        return a
    if argv and argv[0] == "record":
        p = argparse.ArgumentParser(prog="foreman close record")
        p.add_argument("--kind", required=True, choices=KINDS)
        p.add_argument("--path", required=True)
        p.add_argument("--branch")
        p.add_argument("--base")
        p.add_argument("--owner")
        p.add_argument("--class", dest="cls", choices=CLASSES)
        common(p)
        a = p.parse_args(argv[1:])
        a.cmd = "record"
        return a
    p = argparse.ArgumentParser(prog="foreman close")
    common(p)
    p.add_argument("--cwd")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--result")
    p.add_argument("--json", action="store_true")
    p.add_argument("--trusted-project", action="store_true")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--take", metavar="PATH")
    g.add_argument("--drop", metavar="PATH")
    a = p.parse_args(argv)
    a.cmd = "take" if a.take else "drop" if a.drop else "report"
    return a


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        a = parse(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    if a.cmd == "merged":  # before the session check, unlike record
        if not os.path.isdir(a.ws) or not a.ref.startswith("refs/"):
            print("foreman close merged: --ws must be a directory and --ref a full ref", file=sys.stderr)
            return 2
        print(json.dumps({"merged": merged_into_base(os.path.abspath(a.ws), a.ref, a.base or None)}))
        return 0
    sid = (a.session or os.environ.get(SESSION_ENV, "")).strip()
    if not safe_sid(sid):
        print("foreman close: no session (pass --session or set %s)" % SESSION_ENV, file=sys.stderr)
        return 2
    state = os.path.abspath(os.path.expanduser(a.state or default_state()))
    try:
        if a.cmd == "record":
            record(state, sid, a.kind, a.path, a.cls, a.owner, a.branch, a.base)
            return 0
        if a.cmd == "take":
            take(state, sid, a.take)
            print("taken: %s" % os.path.abspath(a.take))
            return 0
        if a.cmd == "drop":
            drop(state, sid, a.drop)
            print("dropped: %s" % os.path.abspath(a.drop))
            return 0
    except Usage as exc:
        print("foreman close: %s" % exc, file=sys.stderr)
        return 2
    except fb.LockTimeout as exc:
        print("foreman close: %s" % exc, file=sys.stderr)
        return 1
    cwd = os.path.abspath(a.cwd or os.getcwd())
    agent_dir = os.path.dirname(os.path.dirname(state))
    try:
        res = fc.load_config(agent_dir, cwd, a.trusted_project)
    except fc.ConfigError as exc:
        print("foreman close: %s" % exc, file=sys.stderr)
        return 2
    if res["errors"]:
        print("foreman close: config errors: %s" % "; ".join(res["errors"]), file=sys.stderr)
        return 2
    rep = run(state, sid, cwd, res["config"], clean=True, dry_run=a.dry_run, result=a.result)
    if a.json:
        print(json.dumps(rep, separators=(",", ":")))
    else:
        print("\n".join(capped(rep["lines"], MAX_LINES, close_path(state, sid))))
    return 0 if rep["ready"] else 3


if __name__ == "__main__":
    sys.exit(main())
