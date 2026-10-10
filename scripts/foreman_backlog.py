#!/usr/bin/env python3
"""Retro backlog: findings that survive sessions and age out (stdlib, 3.9+).

    python scripts/foreman_backlog.py [--agent-dir D] [--cwd DIR] [--json] <command> ...
        list   [--workspace KEY | --all] [--min-count N] [--kind K] [--status S]
        show   <id> [--workspace KEY]
        expire [--now ISO]
        mark   <id> planned|done|open [--workspace KEY]
        move   <id> --to repo|central [--workspace KEY]
        brief  [--workspace KEY] [--min-count 2] [--out PATH]

A store is a markdown file: a `# Retro backlog: <key>` header, then one fenced block per entry
(info string `retro-entry`) of `key: value` lines: id (sha1 of kind + "\\n" + candidate, 12 hex),
kind, candidate, workspace (the key, never a path), first_seen, last_seen (UTC, Z), count,
sessions ([ids], the last 20), evidence (counts, family names, basenames), status
(open|planned|done|expired). Unknown keys are kept.

Where a finding goes:
- central: `<retro.backlogDir or agentDir/pi-foreman/state/retro/backlog>/<key>.md`; a `/` in
  the key makes subdirectories (`bench/<task>.md`);
- repo: `<workspace root>/.workflow/retro-backlog.md` when the root matches a retro.repoBacklog
  entry (absolute path or glob);
- global: `<central dir>/global.md` for kind harness-bug, always.
The key is retro.workspaceKey, else `<basename>-<sha1(workspace root)[:8]>`.

Writes are atomic (temp file in the same directory, os.replace) under `<store>.lock`, created
with O_CREAT|O_EXCL; a lock older than 60 s is broken. The script never starts a session:
`brief` only writes a file.
"""
from __future__ import annotations

import argparse
import datetime
import fnmatch
import hashlib
import json
import os
import re
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import foreman_config as fc  # noqa: E402
import safe_ops  # noqa: E402

KINDS = ("agent", "routing", "skill", "rule", "permission", "prompt", "harness-bug", "review-model")
STATUSES = ("open", "planned", "done", "expired")
FIELDS = ("id", "kind", "candidate", "workspace", "first_seen", "last_seen", "count", "sessions", "evidence", "status")
MAX_SESSIONS = 20
MAX_TEXT = 200
PURGE_DAYS = 90
DEFAULT_EXPIRE_DAYS = 14
LOCK_TIMEOUT = 5.0
LOCK_STALE = 60.0
REPO_STORE = (".workflow", "retro-backlog.md")
GLOBAL = "global"
FENCE = "```"
ROLES = ("explorer", "builder", "reviewer", "senior-reviewer", "finalizer", "foreman", "planner")


class LockTimeout(RuntimeError):
    pass


# ------------------------------------------------------------------ small helpers

def utc(now=None):
    """An aware UTC datetime from None (now), a datetime (naive = UTC) or an ISO string."""
    if now is None:
        return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    if isinstance(now, str):
        now = datetime.datetime.fromisoformat(now.strip().replace("Z", "+00:00"))
    if now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    return now.astimezone(datetime.timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(val):
    try:
        return utc(val) if val else None
    except ValueError:
        return None


def one_line(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()[:MAX_TEXT]


def scrub(text):
    """One line; a token with a path separator is reduced to its basename."""
    return one_line(re.sub(r"[^\s]*[/\\][^\s]*", lambda m: re.split(r"[/\\]", m.group(0).rstrip("/\\"))[-1] or "-",
                           str(text or "")))


def entry_id(kind, candidate):
    return hashlib.sha1((kind + "\n" + candidate).encode("utf-8")).hexdigest()[:12]


def retro_cfg(cfg):
    r = (cfg or {}).get("retro") if isinstance(cfg, dict) else None
    return r if isinstance(r, dict) else {}


# ------------------------------------------------------------------ keys and locations

def sanitize_key(key):
    """`/`-separated segments of [A-Za-z0-9._-]; other characters become `-`. ValueError on `..`."""
    segs = [re.sub(r"[^A-Za-z0-9._-]", "-", s) for s in str(key or "").replace("\\", "/").split("/") if s]
    if not segs:
        raise ValueError("empty backlog key")
    if any(s in (".", "..") for s in segs):
        raise ValueError("backlog key may not contain '.' or '..' segments: %r" % key)
    return "/".join(segs)


def derive_key(workspace_root):
    real = os.path.realpath(os.path.abspath(str(workspace_root)))
    base = os.path.basename(real.rstrip("/\\")) or "root"
    return sanitize_key("%s-%s" % (base, hashlib.sha1(safe_ops.norm(real).encode("utf-8")).hexdigest()[:8]))


def workspace_key(workspace_root, cfg=None, key=None):
    k = key or retro_cfg(cfg).get("workspaceKey")
    return sanitize_key(k) if isinstance(k, str) and k.strip() else derive_key(workspace_root)


def central_dir(cfg=None, agent_dir=None):
    d = retro_cfg(cfg).get("backlogDir")
    if isinstance(d, str) and d.strip():
        return os.path.abspath(os.path.expanduser(d))
    return os.path.join(str(fc.resolve_agent_dir(agent_dir)), "pi-foreman", "state", "retro", "backlog")


def _slash(p):
    return p.replace("\\", "/")


def repo_backlog_entry(workspace_root, cfg=None):
    """The retro.repoBacklog entry {path, commit} matching the workspace root, else None."""
    ws = {_slash(safe_ops.norm(str(workspace_root))), _slash(safe_ops.norm(os.path.realpath(str(workspace_root))))}
    for e in retro_cfg(cfg).get("repoBacklog") or []:
        raw = e.get("path") if isinstance(e, dict) else None
        if not isinstance(raw, str) or not raw.strip():
            continue
        pat = os.path.expanduser(raw.strip())
        if any(c in pat for c in "*?["):
            p = _slash(safe_ops.norm(pat)).rstrip("/")
            if any(fnmatch.fnmatchcase(w, p) for w in ws):
                return e
        elif ws & {_slash(safe_ops.norm(pat)), _slash(safe_ops.norm(os.path.realpath(pat)))}:
            return e
    return None


def repo_store(workspace_root):
    return os.path.join(os.path.abspath(str(workspace_root)), *REPO_STORE)


def store_path_for(kind, *, workspace_root, key=None, cfg=None, agent_dir=None):
    """(store path, origin) for a finding of `kind`; origin is central, repo or global."""
    cdir = central_dir(cfg, agent_dir)
    if kind == "harness-bug":
        return os.path.join(cdir, GLOBAL + ".md"), "global"
    if repo_backlog_entry(workspace_root, cfg) is not None:
        return repo_store(workspace_root), "repo"
    k = workspace_key(workspace_root, cfg, key)
    path = os.path.join(cdir, *k.split("/")) + ".md"
    if not safe_ops.is_inside(cdir, path):
        raise ValueError("backlog key escapes the backlog directory: %r" % k)
    return path, "central"


# ------------------------------------------------------------------ store file

def _parse_sessions(val):
    return [s.strip() for s in val.strip().strip("[]").split(",") if s.strip()]


def parse(text):
    """Entries of a store text; tolerant (missing fields defaulted, unknown keys kept)."""
    entries, cur = [], None
    for line in text.splitlines():
        s = line.strip()
        if cur is None:
            if s.startswith(FENCE) and s.lstrip("`").strip() == "retro-entry":
                cur = {}
            continue
        if s.startswith(FENCE):
            entries.append(_normal(cur))
            cur = None
            continue
        k, sep, v = line.partition(":")
        if sep and k.strip():
            cur[k.strip()] = v.strip()
    if cur:
        entries.append(_normal(cur))
    return [e for e in entries if e.get("id")]


def _normal(raw):
    e = dict(raw)
    try:
        e["count"] = max(1, int(str(e.get("count", "1")).strip()))
    except ValueError:
        e["count"] = 1
    e["sessions"] = _parse_sessions(e.get("sessions", "")) if isinstance(e.get("sessions", ""), str) else []
    if e.get("status") not in STATUSES:
        e["status"] = "open"
    if not e.get("id") and e.get("kind") and e.get("candidate"):
        e["id"] = entry_id(e["kind"], e["candidate"])
    return e


def render(entries, key):
    out = ["# Retro backlog: %s" % key, ""]
    for e in entries:
        out.append(FENCE + "retro-entry")
        for k in list(FIELDS) + [k for k in e if k not in FIELDS and not k.startswith("_")]:
            v = e.get(k)
            if k == "sessions":
                v = "[%s]" % ", ".join(v or [])
            elif v is None:
                continue
            out.append("%s: %s" % (k, one_line(v)))
        out.append(FENCE)
        out.append("")
    return "\n".join(out)


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return parse(fh.read())
    except FileNotFoundError:
        return []


def save(path, entries, key=None):
    """Atomic write: a temp file in the same directory, then os.replace."""
    d = os.path.dirname(os.path.abspath(path))
    os.makedirs(d, exist_ok=True)
    if key is None:
        key = os.path.splitext(os.path.basename(path))[0]
    fd, tmp = tempfile.mkstemp(dir=d, prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(render(entries, key))
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


class locked:
    """Context manager holding `<path>.lock` (O_CREAT|O_EXCL); waits LOCK_TIMEOUT, breaks a stale lock."""

    def __init__(self, path):
        self.lock = path + ".lock"

    def __enter__(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.lock)), exist_ok=True)
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fd = os.open(self.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                os.write(fd, str(os.getpid()).encode("ascii"))
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.lock) > LOCK_STALE:
                        os.unlink(self.lock)
                        continue
                except OSError:
                    pass
            if time.monotonic() >= deadline:
                raise LockTimeout("backlog store is locked: %s" % os.path.basename(self.lock))
            time.sleep(0.05)

    def __exit__(self, *exc):
        try:
            os.unlink(self.lock)
        except OSError:
            pass


# ------------------------------------------------------------------ record

def _session_id(session):
    s = re.sub(r"[^A-Za-z0-9._-]", "", str(session or ""))
    return s[:64]


def record(candidates, *, workspace_root, key=None, session, cfg, agent_dir, now=None):
    """File findings; candidate = {kind, candidate, evidence}. Returns [(id, created|bumped|seen)]:
    `seen` = the same session already counted it (last_seen and evidence still refreshed).
    A candidate with an unknown kind or an empty text is skipped."""
    ts = iso(utc(now))
    ws_key = workspace_key(workspace_root, cfg, key)
    sid = _session_id(session)
    groups = {}
    for c in candidates or []:
        kind = (c or {}).get("kind")
        text = scrub((c or {}).get("candidate"))  # path tokens -> basenames, before the id hash
        if kind not in KINDS or not text:
            continue
        path, origin = store_path_for(kind, workspace_root=workspace_root, key=key, cfg=cfg, agent_dir=agent_dir)
        groups.setdefault(path, (origin, []))[1].append((kind, text, scrub(c.get("evidence"))))
    results = []
    for path, (origin, items) in groups.items():
        with locked(path):
            entries = load(path)
            by_id = {e["id"]: e for e in entries}
            for kind, text, evidence in items:
                eid = entry_id(kind, text)
                e = by_id.get(eid)
                if e is None:
                    e = {"id": eid, "kind": kind, "candidate": text, "workspace": ws_key, "first_seen": ts,
                         "last_seen": ts, "count": 1, "sessions": [sid] if sid else [], "evidence": evidence,
                         "status": "open"}
                    entries.append(e)
                    by_id[eid] = e
                    results.append((eid, "created"))
                    continue
                e["last_seen"] = ts
                e["evidence"] = evidence or e.get("evidence", "")
                if e.get("status") == "expired":
                    e["status"] = "open"
                if sid and sid in e["sessions"]:
                    results.append((eid, "seen"))
                    continue
                e["count"] = int(e.get("count", 1)) + 1
                if sid:
                    e["sessions"] = (e["sessions"] + [sid])[-MAX_SESSIONS:]
                results.append((eid, "bumped"))
            save(path, entries, GLOBAL if origin == "global" else ws_key)
    return results


# ------------------------------------------------------------------ CLI pieces

def context(args):
    cwd = os.path.abspath(args.cwd)
    res = fc.load_config(args.agent_dir, cwd)
    cfg = res["config"]
    root = str(fc.workspace_root(cwd))
    return {"cfg": cfg, "agent_dir": args.agent_dir, "cwd": cwd, "root": root, "key": workspace_key(root, cfg),
            "dir": central_dir(cfg, args.agent_dir)}


def central_files(cdir):
    out = []
    for base, dirs, files in os.walk(cdir):
        dirs.sort()
        for f in sorted(files):
            if f.endswith(".md"):
                p = os.path.join(base, f)
                out.append((p, "global" if os.path.normcase(p) == os.path.normcase(os.path.join(cdir, GLOBAL + ".md"))
                            else "central"))
    return out


def workspace_stores(ctx, key=None):
    """Stores of one workspace: its central file, its repo store (current workspace only), global."""
    key = sanitize_key(key) if key else ctx["key"]
    stores = [(os.path.join(ctx["dir"], *key.split("/")) + ".md", "central")]
    if key == ctx["key"]:
        stores.append((repo_store(ctx["root"]), "repo"))
    stores.append((os.path.join(ctx["dir"], GLOBAL + ".md"), "global"))
    return stores


def all_stores(ctx):
    stores = central_files(ctx["dir"]) + [(repo_store(ctx["root"]), "repo")]
    for e in retro_cfg(ctx["cfg"]).get("repoBacklog") or []:
        p = e.get("path") if isinstance(e, dict) else None
        if isinstance(p, str) and p.strip() and not any(c in p for c in "*?["):
            stores.append((repo_store(os.path.expanduser(p.strip())), "repo"))
    seen, out = set(), []
    for p, o in stores:
        n = safe_ops.norm(p)
        if n not in seen and os.path.isfile(p):
            seen.add(n)
            out.append((p, o))
    return out


def gather(stores):
    out = []
    for path, origin in stores:
        for e in load(path):
            e["_origin"], e["_store"] = origin, path
            out.append(e)
    return out


class Ambiguous(Exception):
    pass


def find(ctx, eid, key=None):
    """Entry by id: the workspace's stores first, else any store if exactly one holds the id."""
    hits = [e for e in gather(workspace_stores(ctx, key)) if e["id"] == eid]
    if hits:
        return hits[0]
    hits = [e for e in gather(all_stores(ctx)) if e["id"] == eid]
    if len(hits) > 1:
        raise Ambiguous(sorted({e.get("workspace") or "?" for e in hits}))
    return hits[0] if hits else None


def resolve(ctx, args):
    try:
        e = find(ctx, args.id, getattr(args, "workspace", None))
    except Ambiguous as a:
        print("backlog id %s exists in several workspaces (%s); pass --workspace KEY" % (args.id, ", ".join(a.args[0])),
              file=sys.stderr)
        return None, 2
    if e is None:
        print("no backlog entry %s" % args.id, file=sys.stderr)
        return None, 1
    return e, 0


def public(e):
    d = {k: v for k, v in e.items() if not k.startswith("_")}
    d["origin"] = e.get("_origin")
    return d


def line_of(e, with_ws=False):
    return "%s %-7s %-11s x%-3d %-7s last %s%s  %s" % (
        e["id"], e.get("_origin", ""), e.get("kind", "?"), e["count"], e["status"], (e.get("last_seen") or "?")[:10],
        ("  [%s]" % e.get("workspace", "?")) if with_ws else "", e.get("candidate", ""))


def cmd_list(ctx, args):
    stores = all_stores(ctx) if args.all else workspace_stores(ctx, args.workspace)
    statuses = STATUSES if args.status == "all" else ((args.status,) if args.status else ("open", "planned"))
    rows = [e for e in gather(stores) if e["status"] in statuses and e["count"] >= args.min_count
            and (not args.kind or e.get("kind") == args.kind)]
    rows.sort(key=lambda e: e.get("last_seen") or "", reverse=True)
    rows.sort(key=lambda e: -e["count"])
    if args.json:
        print(json.dumps([public(e) for e in rows], indent=2))
    elif not rows:
        print("no backlog entries")
    else:
        for e in rows:
            print(line_of(e, args.all or bool(args.workspace)))
    return 0


def cmd_show(ctx, args):
    e, rc = resolve(ctx, args)
    if e is None:
        return rc
    if args.json:
        print(json.dumps(public(e), indent=2))
    else:
        for k, v in public(e).items():
            print("%s: %s" % (k, "[%s]" % ", ".join(v) if k == "sessions" else v))
    return 0


def _age_days(e, now, *fields):
    times = [t for t in (parse_time(e.get(f)) for f in fields) if t]
    return (now - max(times)).total_seconds() / 86400.0 if times else 0.0


def cmd_expire(ctx, args):
    now = utc(args.now)
    days = retro_cfg(ctx["cfg"]).get("expireDays")
    days = days if isinstance(days, int) and not isinstance(days, bool) and days > 0 else DEFAULT_EXPIRE_DAYS
    total = {"expired": 0, "removed": 0}
    for path, origin in all_stores(ctx):
        with locked(path):
            entries, keep, changed = load(path), [], False
            for e in entries:
                age = _age_days(e, now, "last_seen", "marked")
                if e["status"] in ("done", "expired") and age > PURGE_DAYS:
                    total["removed"] += 1
                    changed = True
                    continue
                if e["status"] in ("open", "planned") and age > days:
                    e["status"] = "expired"
                    total["expired"] += 1
                    changed = True
                keep.append(e)
            if changed:
                save(path, keep, _store_key(path, entries))
    if args.json:
        print(json.dumps(total))
    else:
        print("expired %d, removed %d" % (total["expired"], total["removed"]))
    return 0


def _store_key(path, entries):
    try:
        with open(path, encoding="utf-8") as fh:
            m = re.match(r"# Retro backlog: (.+)", fh.readline().strip())
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    return entries[0].get("workspace") if entries else None


def cmd_mark(ctx, args):
    e, rc = resolve(ctx, args)
    if e is None:
        return rc
    path = e["_store"]
    with locked(path):
        entries = load(path)
        for x in entries:
            if x["id"] == args.id:
                x["status"] = args.status
                x["marked"] = iso(utc())
        save(path, entries, _store_key(path, entries))
    print("%s -> %s" % (args.id, args.status))
    return 0


def _merge(into, e):
    into["count"] = int(into["count"]) + int(e["count"])
    into["sessions"] = (into["sessions"] + [s for s in e["sessions"] if s not in into["sessions"]])[-MAX_SESSIONS:]
    into["first_seen"] = min(filter(None, (into.get("first_seen"), e.get("first_seen"))), default=None)
    if (e.get("last_seen") or "") > (into.get("last_seen") or ""):
        into["last_seen"], into["evidence"] = e["last_seen"], e.get("evidence", "")


def cmd_move(ctx, args):
    e, rc = resolve(ctx, args)
    if e is None:
        return rc
    if args.to == "repo":
        target, tkey = repo_store(ctx["root"]), ctx["key"]
    else:
        tkey = sanitize_key(e.get("workspace") or ctx["key"])
        target = os.path.join(ctx["dir"], *tkey.split("/")) + ".md"
    src = e["_store"]
    if safe_ops.norm(src) == safe_ops.norm(target):
        print("%s is already in the %s store" % (args.id, args.to))
        return 0
    first, second = sorted([src, target])
    with locked(first), locked(second):
        s_entries = load(src)
        moving = [x for x in s_entries if x["id"] == args.id]
        t_entries = load(target)
        have = {x["id"]: x for x in t_entries}
        for x in moving:
            if x["id"] in have:
                _merge(have[x["id"]], x)
            else:
                t_entries.append(x)
        save(target, t_entries, tkey)
        save(src, [x for x in s_entries if x["id"] != args.id], _store_key(src, s_entries))
    print("%s moved to the %s store" % (args.id, args.to))
    listed = repo_backlog_entry(ctx["root"], ctx["cfg"]) is not None
    if args.to == "repo" and not listed:
        print("note: this workspace is not in retro.repoBacklog; future sightings go to the central store")
    elif args.to == "central" and listed:
        print("note: this workspace is in retro.repoBacklog; future sightings go to the repo store")
    return 0


def tokens(text):
    low = (text or "").lower()
    toks = {r for r in ROLES if re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(r), low)}
    toks.update(q.strip() for pair in re.findall(r"`([^`]+)`|\"([^\"]+)\"", low) for q in pair if q.strip())
    return toks


def clusters(entries):
    """Entries of one kind in groups that share a role or family token, biggest count first."""
    parent = list(range(len(entries)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    toks = [tokens(e.get("candidate")) for e in entries]
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            if toks[i] & toks[j]:
                parent[root(i)] = root(j)
    groups = {}
    for i, e in enumerate(entries):
        groups.setdefault(root(i), []).append(e)
    out = [sorted(g, key=lambda e: -e["count"]) for g in groups.values()]
    out.sort(key=lambda g: (-max(e["count"] for e in g), g[0]["id"]))
    return out


def cmd_brief(ctx, args):
    now = utc()
    rows = [e for e in gather(workspace_stores(ctx, args.workspace)) if e["status"] == "open" and e["count"] >= args.min_count]
    out = args.out or os.path.join(ctx["cwd"], ".workflow", "scratch", "brief-lessons-%s.md" % now.strftime("%Y-%m-%d"))
    key = sanitize_key(args.workspace) if args.workspace else ctx["key"]
    L = ["# Lessons brief: %s" % key, "",
         "Written by `foreman backlog brief` on %s. It only writes this file and never starts a session:" % iso(now),
         "open a session yourself and hand it this brief.", "",
         "Open backlog findings seen at least %d time(s): %d." % (args.min_count, len(rows)), ""]
    for kind in KINDS:
        of_kind = [e for e in rows if e.get("kind") == kind]
        if not of_kind:
            continue
        L += ["## %s" % kind, ""]
        for group in clusters(of_kind):
            if len(group) > 1:
                shared = sorted(set.intersection(*[tokens(e.get("candidate")) for e in group[:2]])) or ["related"]
                L.append("Complementary (%s):" % ", ".join(shared))
            for e in group:
                L.append("- `%s` %s (count %d, first %s, last %s, %s)" % (
                    e["id"], e.get("candidate", ""), e["count"], (e.get("first_seen") or "?")[:10],
                    (e.get("last_seen") or "?")[:10], e.get("_origin")))
                if e.get("evidence"):
                    L.append("  evidence: %s" % e["evidence"])
            L.append("")
    L += ["## Instructions", "",
          "1. Plan first: read every finding above and write a plan before changing anything.",
          "2. Group complementary findings and fix each group with one change.",
          "3. Implement in the harness repository or in a user-level skill directory; where the output lives is"
          " this session's decision.",
          "4. Run `foreman backlog mark <id> done --workspace %s` for every finished entry." % key, ""]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(L))
    if args.json:
        print(json.dumps({"out": out, "entries": len(rows)}))
    else:
        print("brief written: %s (%d entries)" % (out, len(rows)))
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="foreman backlog", description=__doc__.split("\n")[0])
    p.add_argument("--agent-dir")
    p.add_argument("--cwd", default=os.getcwd())
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("list")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--workspace")
    g.add_argument("--all", action="store_true")
    s.add_argument("--min-count", type=int, default=1)
    s.add_argument("--kind", choices=KINDS)
    s.add_argument("--status", choices=STATUSES + ("all",))
    s = sub.add_parser("show")
    s.add_argument("id")
    s.add_argument("--workspace")
    s = sub.add_parser("expire")
    s.add_argument("--now")
    s = sub.add_parser("mark")
    s.add_argument("id")
    s.add_argument("--workspace")
    s.add_argument("status", choices=("planned", "done", "open"))
    s = sub.add_parser("move")
    s.add_argument("id")
    s.add_argument("--workspace")
    s.add_argument("--to", choices=("repo", "central"), required=True)
    s = sub.add_parser("brief")
    s.add_argument("--workspace")
    s.add_argument("--min-count", type=int, default=2)
    s.add_argument("--out")
    for s in sub.choices.values():
        s.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
    return p


def main(argv=None):
    p = build_parser()
    try:
        args = p.parse_args(argv)
    except SystemExit as exc:
        return 2 if exc.code else 0
    if not args.cmd:
        p.print_usage(sys.stderr)
        return 2
    try:
        ctx = context(args)
        return {"list": cmd_list, "show": cmd_show, "expire": cmd_expire, "mark": cmd_mark, "move": cmd_move,
                "brief": cmd_brief}[args.cmd](ctx, args)
    except (fc.ConfigError, ValueError) as exc:
        print("foreman backlog: %s" % exc, file=sys.stderr)
        return 2
    except LockTimeout as exc:
        print("foreman backlog: %s" % exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
