#!/usr/bin/env python3
"""Radar: a read-only tree of the running pi-foreman sessions and their subagent runs (stdlib, 3.9+).

    python scripts/foreman_radar.py [--once] [--agent-dir D] [--interval SECONDS] [--since HOURS] [--no-color]

Shows top sessions, the sessions they opened and every session's subagent runs, with state, last-event
age and the tokens and cost of each subtree. Display only, no control actions; works without Herdr.
Sources (all under <agent dir>/pi-foreman/, all optional, missing or corrupt files are skipped):
  state/live/<sessionId>.json   presence file written by the extension (see docs/sessions.md)
  state/sessions.json           registry of sessions opened with `foreman session open`
  handoffs/*/{parent,child}     handoff dirs
  state/usage/<sessionId>.jsonl usage lines; state/trace-<sessionId>.jsonl mtime = extra last-event signal

No curses (absent on Windows): the screen is redrawn with ANSI codes every --interval seconds.
`q` or Ctrl-C quits. Without a TTY on stdout, or with --once, one plain snapshot is printed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from foreman_session import agent_dir  # noqa: E402

LOST_AFTER = 90.0
STARTING_WINDOW = 120.0
GLYPHS = {"working": "●", "blocked": "◐", "starting": "◌", "idle": "○", "lost": "×"}
COLORS = {"working": "32", "blocked": "33", "starting": "36", "idle": "90", "lost": "31"}
ACTIVE = ("working", "blocked", "starting")


def leaf(path):
    """Last component of a path written on any platform (both separators)."""
    return re.split(r"[\\/]+", str(path or "").rstrip("\\/"))[-1]


def base_name(path, platform=None):
    """Display name of a directory; never the full path (so no home dir in output)."""
    import ntpath
    import posixpath
    mod = ntpath if (platform or sys.platform) == "win32" else posixpath
    return mod.basename(str(path).rstrip("\\/")) or str(path)


def parse_ts(value):
    if not isinstance(value, str) or not value:
        return None
    s = value.strip()
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(s).timestamp()  # naive = local time
    except ValueError:
        return None


def num(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def read_json(path):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def read_line(path):
    try:
        return Path(path).read_text("utf-8").strip().splitlines()[0].strip()
    except (OSError, IndexError, ValueError):
        return ""


def mtime(path):
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return None


class UsageCache:
    """Per usage file: byte offset and running totals, so a refresh reads only appended lines."""

    def __init__(self):
        self.files = {}

    def read(self, path):
        key = str(path)
        st = self.files.get(key)
        try:
            size = Path(path).stat().st_size
        except OSError:
            self.files.pop(key, None)
            return None
        if st is None or size < st["offset"]:
            st = {"offset": 0, "tot": [0, 0, 0.0], "runs": {}}
            self.files[key] = st
        if size > st["offset"]:
            try:
                with open(path, "rb") as f:
                    f.seek(st["offset"])
                    chunk = f.read(size - st["offset"])
            except OSError:
                return st
            end = chunk.rfind(b"\n") + 1
            for raw in chunk[:end].splitlines():
                try:
                    row = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                cost = row.get("cost")
                cost = num(cost.get("total")) if isinstance(cost, dict) else 0
                tin = num(row.get("input")) + num(row.get("cacheRead")) + num(row.get("cacheWrite"))
                tout = num(row.get("output"))
                for tot in (st["tot"], st["runs"].setdefault(str(row.get("launchId")), [0, 0, 0.0])):
                    tot[0] += tin
                    tot[1] += tout
                    tot[2] += cost
            st["offset"] += end
        return st


def load(adir, cache=None):
    """Read every source into plain data. No clock, no printing."""
    base = Path(adir) / "pi-foreman"
    cache = cache if cache is not None else UsageCache()
    live, usage, trace = [], {}, {}
    try:
        names = sorted(os.listdir(base / "state" / "live"))
    except OSError:
        names = []
    for name in names:
        if not name.endswith(".json"):
            continue
        d = read_json(base / "state" / "live" / name)
        if not isinstance(d, dict):
            continue
        sid = d.get("sessionId") if isinstance(d.get("sessionId"), str) and d.get("sessionId") else name[:-5]
        d["sessionId"] = sid
        live.append(d)
        u = cache.read(base / "state" / "usage" / (sid + ".jsonl"))
        if u:
            usage[sid] = u
        trace[sid] = mtime(base / "state" / ("trace-" + sid + ".jsonl"))
    reg = read_json(base / "state" / "sessions.json")
    reg = [s for s in (reg.get("sessions") if isinstance(reg, dict) else None) or [] if isinstance(s, dict)]
    handoffs = {}
    try:
        dirs = sorted(os.listdir(base / "handoffs"))
    except OSError:
        dirs = []
    for dn in dirs:
        p = base / "handoffs" / dn
        if not p.is_dir():
            continue
        handoffs[dn] = {"parent": read_line(p / "parent"), "child": read_line(p / "child"), "mtime": mtime(p),
                        "has": [f for f in ("result.md", "plan.md", "brief.md") if (p / f).exists()]}
    return {"live": live, "registry": reg, "handoffs": handoffs, "usage": usage, "trace": trace}


def new_node(kind, key, name):
    return {"kind": kind, "key": key, "name": name, "glyph": "idle", "state": "", "last": None, "started": None,
            "own": [0, 0, 0.0], "children": [], "tot": [0, 0, 0.0], "parent": None}


def live_glyph(d, now):
    state = d.get("state")
    hb = parse_ts(d.get("heartbeatAt"))
    if state != "done" and (hb is None or now - hb > LOST_AFTER):
        return "lost", "lost"
    if state == "blocked":
        return "blocked", "blocked"
    if state == "working":
        return "working", "working"
    return "idle", "done" if state == "done" else "idle"


def reg_glyph(status, opened, now):
    young = opened is not None and now - opened < STARTING_WINDOW
    if status == "pending":
        return "starting", "pending"
    if status == "open":
        return ("starting", "starting") if young else ("lost", "lost")
    if status == "failed":
        return "lost", "failed"
    return "idle", status if status in ("closing", "closed") else "idle"


def build(data, now):
    """Join live files, registry entries and handoff dirs into session nodes; return the list of roots."""
    nodes, by_sid = {}, {}
    handoff_by_leaf = data["handoffs"]
    for d in data["live"]:
        sid = d["sessionId"]
        key = d.get("intercomId") if isinstance(d.get("intercomId"), str) and d.get("intercomId") else "sid:" + sid
        n = nodes.get(key) or new_node("session", key, "")
        n["name"] = (d.get("label") if isinstance(d.get("label"), str) and d.get("label") else "") or n["name"] or sid[:8]
        n["glyph"], n["state"] = live_glyph(d, now)
        times = [parse_ts(d.get("lastEventAt")), data["trace"].get(sid)]
        times = [t for t in times if t is not None]
        n["last"] = max(times) if times else parse_ts(d.get("heartbeatAt"))
        n["started"] = parse_ts(d.get("startedAt"))
        n["parent"] = d.get("parentIntercom") if isinstance(d.get("parentIntercom"), str) and d.get("parentIntercom") else n["parent"]
        ho = handoff_by_leaf.get(leaf(d.get("handoff")))
        if ho and not n["parent"] and ho["parent"]:
            n["parent"] = ho["parent"]
        u = data["usage"].get(sid)
        runs = [r for r in (d.get("runs") or []) if isinstance(r, dict)]
        for r in runs:
            rn = new_node("run", "run:%s:%s" % (sid, r.get("launchId")), "")
            role = r.get("role") if isinstance(r.get("role"), str) and r.get("role") else "run"
            rn["name"] = role + ("/" + r["rung"] if isinstance(r.get("rung"), str) and r["rung"] else "")
            rs = r.get("state")
            rn["state"] = rs if isinstance(rs, str) else ""
            rn["glyph"] = "blocked" if rs == "ask" else "working" if rs == "working" else "idle"
            if rn["glyph"] != "idle" and n["glyph"] == "lost":
                rn["glyph"] = "lost"
            rn["last"] = n["last"]
            ru = (u or {}).get("runs", {}).get(str(r.get("launchId")))
            rn["own"] = list(ru) if ru else [num(r.get("tokensIn")), num(r.get("tokensOut")), num(r.get("cost"))]
            rn["tot"] = list(rn["own"])
            n["children"].append(rn)
        n["own"] = list(u["tot"]) if u else [sum(c["own"][0] for c in n["children"]),
                                              sum(c["own"][1] for c in n["children"]),
                                              sum(c["own"][2] for c in n["children"])]
        nodes[key] = n
        by_sid[sid] = n
    for e in data["registry"]:
        key = e.get("child") if isinstance(e.get("child"), str) and e.get("child") else None
        if not key:
            continue
        n = nodes.get(key)
        opened = parse_ts(e.get("opened"))
        if n is None:
            n = new_node("session", key, e.get("label") if isinstance(e.get("label"), str) and e.get("label") else key)
            n["glyph"], n["state"] = reg_glyph(e.get("status"), opened, now)
            last = e.get("last")
            n["last"] = parse_ts(last.get("at")) if isinstance(last, dict) else None
            n["last"] = n["last"] or opened
            n["started"] = opened
            nodes[key] = n
        if isinstance(e.get("parent"), str) and e["parent"] and not n["parent"]:
            n["parent"] = e["parent"]
        if n["started"] is None:
            n["started"] = opened
        ho = handoff_by_leaf.get(leaf(e.get("handoff")))
        if ho and not n["parent"] and ho["parent"]:
            n["parent"] = ho["parent"]
    reg_keys = {k for k in nodes}
    for dn, ho in handoff_by_leaf.items():
        key = ho["child"]
        if not key or key in reg_keys:
            continue
        n = new_node("session", key, key)
        m = re.match(r"(\d{8})-(\d{6})", dn)
        opened = None
        if m:
            try:
                opened = time.mktime(time.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S"))
            except (ValueError, OverflowError):
                opened = None
        opened = opened or ho["mtime"]
        n["glyph"], n["state"] = reg_glyph("open", opened, now)
        n["last"], n["started"], n["parent"] = opened, opened, ho["parent"] or None
        nodes[key] = n
    roots, seen = [], set()
    for n in nodes.values():
        p = nodes.get(n["parent"]) if n["parent"] else None
        if p is not None and p is not n:
            p["children"].append(n)
        else:
            roots.append(n)

    def mark(n):
        seen.add(id(n))
        for c in n["children"]:
            if c["kind"] == "session":
                mark(c)

    for r in roots:
        mark(r)
    for n in nodes.values():  # sessions only in a parent cycle: break it here
        if id(n) not in seen:
            p = nodes.get(n["parent"])
            if p is not None:
                p["children"] = [c for c in p["children"] if c is not n]
            roots.append(n)
            mark(n)
    return roots


def rank(n):
    return 0 if n["glyph"] in ACTIVE else 1 if n["glyph"] == "idle" else 2


def finish(n, now, since_h):
    """Sum subtrees, sort children, prune finished or lost nodes older than since_h. True = keep."""
    kids = [c for c in n["children"] if c["kind"] == "run" or finish(c, now, since_h)]
    runs = [c for c in kids if c["kind"] == "run"]
    subs = sorted([c for c in kids if c["kind"] == "session"],
                  key=lambda c: (rank(c), c["started"] if c["started"] is not None else float("inf")))
    n["children"] = runs + subs
    n["tot"] = [n["own"][0], n["own"][1], n["own"][2]]
    for c in subs:
        for i in range(3):
            n["tot"][i] += c["tot"][i]
    if n["glyph"] in ACTIVE or subs:
        return True
    return n["last"] is None or now - n["last"] <= since_h * 3600


def snapshot(adir, now, since_h=24.0, cache=None):
    roots = build(load(adir, cache), now)
    roots = [r for r in roots if finish(r, now, since_h)]
    roots.sort(key=lambda c: (rank(c), c["started"] if c["started"] is not None else float("inf")))
    return roots


def fmt_age(secs):
    if secs is None:
        return "-"
    secs = max(0, int(secs))
    if secs < 60:
        return "%ds" % secs
    if secs < 3600:
        return "%dm" % (secs // 60)
    if secs < 86400:
        return "%dh" % (secs // 3600)
    return "%dd" % (secs // 86400)


def fmt_tok(n):
    n = int(n)
    if n < 1000:
        return str(n)
    if n < 1000000:
        return "%.1fk" % (n / 1000.0)
    return "%.1fM" % (n / 1000000.0)


def rows(roots):
    out = []

    def walk(n, prefix, branch, last):
        out.append((prefix + branch, n))
        child_prefix = prefix + ("" if not branch else "   " if last else "│  ")
        for i, c in enumerate(n["children"]):
            walk(c, child_prefix, "└─ " if i == len(n["children"]) - 1 else "├─ ",
                 i == len(n["children"]) - 1)

    for r in roots:
        walk(r, "", "", True)
    return out


def render(roots, now, agent_name, color=False):
    """Pure: tree -> list of text lines (no clock reads)."""
    table = rows(roots)
    counts = dict.fromkeys(GLYPHS, 0)
    for _, n in table:
        counts[n["glyph"]] += 1

    def paint(glyph, text):
        return "\x1b[%sm%s\x1b[0m" % (COLORS[glyph], text) if color else text

    stamp = time.strftime("%H:%M:%S", time.localtime(now))
    head = "pi-foreman radar  %s  %s  " % (stamp, agent_name) + "  ".join(
        paint(g, "%s %d" % (GLYPHS[g], counts[g])) for g in GLYPHS)
    if not table:
        return [head, "", "no sessions"]
    width = max(len(p) + 2 + len(n["name"]) for p, n in table)
    lines = [head, ""]
    for prefix, n in table:
        pad = " " * (width + 2 - len(prefix) - 2 - len(n["name"]))
        glyph_left = prefix + paint(n["glyph"], GLYPHS[n["glyph"]]) + " " + n["name"]
        tin, tout, cost = n["tot"]
        usage = "↑%s ↓%s $%.2f" % (fmt_tok(tin), fmt_tok(tout), cost) if (tin or tout or cost) else ""
        age = fmt_age(now - n["last"]) if n["last"] is not None else "-"
        lines.append(("%s%s  %-9s %4s  %s" % (glyph_left, pad, n["state"], age, usage)).rstrip())
    return lines


def wait_key(seconds, state):
    """Wait up to `seconds`; True when q was pressed."""
    if sys.platform == "win32":
        import msvcrt
        end = time.time() + seconds
        while time.time() < end:
            if msvcrt.kbhit():
                if msvcrt.getwch().lower() == "q":
                    return True
            else:
                time.sleep(0.1)
        return False
    if not state.get("tty"):
        time.sleep(seconds)
        return False
    import select
    ready, _, _ = select.select([sys.stdin], [], [], seconds)
    return bool(ready) and sys.stdin.read(1).lower() == "q"


def loop(adir, interval, since_h, color):
    if sys.platform == "win32":
        os.system("")  # enable VT escape processing in the console
    state = {"tty": False}
    old = None
    if sys.platform != "win32" and sys.stdin.isatty():
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        tty.setcbreak(fd)
        state["tty"] = True
    cache = UsageCache()
    name = base_name(adir)
    try:
        while True:
            now = time.time()
            lines = render(snapshot(adir, now, since_h, cache), now, name, color)
            sys.stdout.write("\x1b[H\x1b[2J" + "\n".join(lines) + "\n\nq quits\n")
            sys.stdout.flush()
            if wait_key(interval, state):
                break
    except KeyboardInterrupt:
        pass
    finally:
        if old is not None:
            import termios
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="foreman radar", description="Tree of running pi-foreman sessions (display only).")
    ap.add_argument("--once", action="store_true", help="print one plain snapshot and exit")
    ap.add_argument("--agent-dir")
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--since", type=float, default=24.0, help="hours; hide finished or lost sessions older than this")
    ap.add_argument("--no-color", action="store_true")
    a = ap.parse_args(argv)
    for stream in (sys.stdout,):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    adir = agent_dir(a.agent_dir)
    if a.once or not sys.stdout.isatty():
        now = time.time()
        print("\n".join(render(snapshot(adir, now, a.since), now, base_name(adir))))
        return 0
    color = not a.no_color and not os.environ.get("NO_COLOR")
    return loop(adir, max(0.5, a.interval), a.since, color)


if __name__ == "__main__":
    sys.exit(main())
