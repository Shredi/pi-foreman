#!/usr/bin/env python3
"""Radar: a read-only tree of the running pi-foreman sessions and their subagent runs (stdlib, 3.9+).

    python scripts/foreman_radar.py [--once] [--agent-dir D] [--interval SECONDS] [--since HOURS] [--done-ttl MINUTES] [--no-color]

Shows top sessions, the sessions they opened and every session's subagent runs, with state, last-event
age and the tokens and cost of each subtree. Display only, no control actions; works without Herdr.
Sources (all under <agent dir>/pi-foreman/, all optional, missing or corrupt files are skipped):
  state/live/<sessionId>.json   presence file written by the extension (see docs/sessions.md)
  state/sessions.json           registry of sessions opened with `foreman session open`
  handoffs/*/{parent,child}     handoff dirs
  state/usage/<sessionId>.jsonl usage lines; state/trace-<sessionId>.jsonl mtime = extra last-event signal

No curses (absent on Windows): the screen is redrawn with ANSI codes every --interval seconds.
`q` or Ctrl-C quits, r refreshes, c toggles cost, up/down select, enter shows the session path. Without a TTY on stdout, or with --once, one plain snapshot is printed.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from foreman_session import agent_dir  # noqa: E402

LOST_AFTER = 90.0
STALE_AFTER = 900.0
DONE_TTL_MINUTES = 30.0
STARTING_WINDOW = 120.0
SYMBOLS_PATH = Path(__file__).resolve().parent.parent / "config" / "symbols.json"
SYM_ORDER = ("working", "waiting", "asking", "blocked", "done", "lost")
SYM_COLORS = {"working": "32", "waiting": "90", "asking": "33", "blocked": "33", "done": "90", "lost": "31"}
FALLBACK_SYMBOLS = {"working": "⏳", "waiting": "⏸", "asking": "?", "blocked": "✋", "done": "✓", "lost": "✗"}
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


def config_done_ttl(adir):
    """radar.doneTtlMinutes of the merged config (user/organisation layers); the default on any failure."""
    try:
        import foreman_config
        v = (foreman_config.load_config(agent_dir=str(adir))["config"].get("radar") or {}).get("doneTtlMinutes")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
            return float(v)
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        pass
    return DONE_TTL_MINUTES


def config_symbols(adir):
    """ui.symbols of the merged config: "nerd" or "unicode" (default, also for any unknown value or failure)."""
    try:
        import foreman_config
        v = (foreman_config.load_config(agent_dir=str(adir))["config"].get("ui") or {}).get("symbols")
        if v == "nerd":
            return "nerd"
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        pass
    return "unicode"


def load_symbols(name="unicode"):
    """State-symbol table of one set from config/symbols.json; the built-in unicode set when unreadable."""
    d = read_json(SYMBOLS_PATH)
    table = d.get(name) if isinstance(d, dict) and isinstance(d.get(name), dict) else None
    if table is None:
        table = d.get("unicode") if isinstance(d, dict) and isinstance(d.get("unicode"), dict) else {}
    return {k: table[k] if isinstance(table.get(k), str) else FALLBACK_SYMBOLS[k] for k in SYM_ORDER}


def sym_key(n):
    """Symbol key of a node (working, waiting, asking, blocked, done, lost)."""
    st = n["state"]
    if st == "stale":
        return "waiting"
    if n["glyph"] == "lost":
        return "lost"
    if st in ("working", "starting", "pending"):
        return "working"
    if st == "ask":
        return "asking"
    if st in ("done", "closed"):
        return "done"
    if st == "failed":
        return "lost"
    return "blocked" if st == "blocked" else "waiting"


def cell_width(text):
    """Terminal cells of a string: wide and fullwidth characters count 2, combining marks 0."""
    w = 0
    for ch in str(text):
        if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def prune_done(path, d, now, ttl_min):
    """Delete one presence file whose state is done and whose last activity is older than the TTL."""
    if d.get("state") != "done":
        return False
    times = [t for t in (parse_ts(d.get("heartbeatAt")), parse_ts(d.get("lastEventAt"))) if t is not None]
    last = max(times) if times else mtime(path)
    if last is None or now - last <= ttl_min * 60:
        return False
    try:
        os.remove(path)
    except OSError:
        return False
    return True


def load(adir, cache=None, now=None, done_ttl=None):
    """Read every source into plain data. No clock, no printing; with now and done_ttl (minutes) it also deletes
    the presence files of sessions that finished longer ago than the TTL."""
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
        if now is not None and done_ttl is not None and prune_done(base / "state" / "live" / name, d, now, done_ttl):
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
            "own": [0, 0, 0.0], "children": [], "tot": [0, 0, 0.0], "parent": None, "path": "",
            "role": None, "rung": None, "pane": None, "pid": None, "cwd": None, "blockedSince": None}


def live_glyph(d, now):
    state = d.get("state")
    hb = parse_ts(d.get("heartbeatAt"))
    if state != "done" and (hb is None or now - hb > LOST_AFTER):
        return "lost", "stale" if hb is None or now - hb > STALE_AFTER else "lost"
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
        cwd_name = base_name(d["cwd"]) + " " if isinstance(d.get("cwd"), str) and d.get("cwd") else ""
        n["name"] = (d.get("label") if isinstance(d.get("label"), str) and d.get("label") else "") or n["name"] or cwd_name + sid[:8]
        n["glyph"], n["state"] = live_glyph(d, now)
        times = [parse_ts(d.get("lastEventAt")), data["trace"].get(sid)]
        times = [t for t in times if t is not None]
        n["last"] = max(times) if times else parse_ts(d.get("heartbeatAt"))
        n["started"] = parse_ts(d.get("startedAt"))
        n["path"] = next((d[k] for k in ("sessionFile", "cwd", "handoff") if isinstance(d.get(k), str) and d[k]), "")
        n["pane"] = d["paneId"] if isinstance(d.get("paneId"), str) and d["paneId"] else None
        n["pid"] = d["pid"] if isinstance(d.get("pid"), int) and not isinstance(d.get("pid"), bool) else None
        n["cwd"] = d["cwd"] if isinstance(d.get("cwd"), str) and d["cwd"] else None
        n["blockedSince"] = parse_ts(d.get("blockedSince"))
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
            rn["role"] = role
            rn["rung"] = r["rung"] if isinstance(r.get("rung"), str) and r["rung"] else None
            rn["glyph"] = "blocked" if rs == "ask" else "working" if rs == "working" else "idle"
            if rn["glyph"] != "idle" and n["glyph"] == "lost":
                rn["glyph"] = "lost"
            rn["last"], rn["path"] = n["last"], n["path"]
            ru = (u or {}).get("runs", {}).get(str(r.get("launchId")))
            rn["own"] = list(ru) if ru else [num(r.get("tokensIn")), num(r.get("tokensOut")), num(r.get("cost"))]
            rn["tot"] = list(rn["own"])
            n["children"].append(rn)
        pres = [d.get("tokensIn"), d.get("tokensOut"), d.get("cost")]
        if any(isinstance(x, (int, float)) and not isinstance(x, bool) for x in pres):
            n["own"] = [num(x) for x in pres]
        else:
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
            n["path"] = e["handoff"] if isinstance(e.get("handoff"), str) else ""
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
        n["path"] = str(base / "handoffs" / dn)
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


def finish(n, now, since_h, done_ttl=None):
    """Sum subtrees, sort children, prune finished or lost nodes older than since_h and done nodes older than
    done_ttl minutes (a done node with a shown descendant stays). True = keep."""
    kids = [c for c in n["children"] if c["kind"] == "run" or finish(c, now, since_h, done_ttl)]
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
    if done_ttl is not None and n["state"] == "done" and n["last"] is not None and now - n["last"] > done_ttl * 60:
        return False
    return n["last"] is None or now - n["last"] <= since_h * 3600


def snapshot(adir, now, since_h=24.0, cache=None, done_ttl=None):
    roots = build(load(adir, cache, now, done_ttl), now)
    roots = [r for r in roots if finish(r, now, since_h, done_ttl)]
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


FOOTER = (("q", "quit"), ("r", "refresh"), ("c", "cost on/off"), ("↑↓", "select"), ("enter", "show session path"))
AMBER_AFTER, RED_AFTER = 300, 900


def sgr(codes, text, color):
    return "\x1b[%sm%s\x1b[0m" % (codes, text) if color and codes else text


def render_footer(color=False):
    """Pure: the key legend line. Keys bold, descriptions and separators dim."""
    sep = sgr("2", " · ", color)
    return sep.join(sgr("1", k, color) + sgr("2", " " + d, color) for k, d in FOOTER)


def decode_key(seq):
    """Pure: a raw key sequence (POSIX escape codes or Windows msvcrt prefix + code) -> action name or None."""
    if not seq:
        return None
    if seq in ("q", "Q", "\x03"):
        return "quit"
    if seq in ("r", "R"):
        return "refresh"
    if seq in ("c", "C"):
        return "cost"
    if seq in ("\x1b[A", "\x1bOA", "\xe0H", "\x00H"):
        return "up"
    if seq in ("\x1b[B", "\x1bOB", "\xe0P", "\x00P"):
        return "down"
    if seq in ("\r", "\n", "\r\n"):
        return "enter"
    return None


def node_path(n):
    return n.get("path") or "no path"


def render(roots, now, width=80, color=False, show_cost=True, selected=None, symbols=None):
    """Pure: tree -> list of text lines (no clock reads). `selected` = row index shown as an inverted band."""
    table = rows(roots)
    symbols = symbols or load_symbols()
    counts = dict.fromkeys(SYM_ORDER, 0)
    for _, n in table:
        counts[sym_key(n)] += 1
    stamp = time.strftime("%H:%M:%S", time.localtime(now))
    left_plain = "pi-foreman radar" + " " * 22 + "  ".join("%s %d" % (symbols[g], counts[g]) for g in SYM_ORDER)
    left = sgr("1", "pi-foreman radar", color) + " " * 22 + "  ".join(
        sgr(SYM_COLORS[g] if counts[g] else "2", "%s %d" % (symbols[g], counts[g]), color) for g in SYM_ORDER)
    head = left + " " * max(2, width - cell_width(left_plain) - len(stamp)) + sgr("2", stamp, color)
    nsess = sum(1 for _, n in table if n["kind"] == "session")
    tin = sum(r["tot"][0] for r in roots)
    tout = sum(r["tot"][1] for r in roots)
    tcost = sum(r["tot"][2] for r in roots)
    d = lambda t: sgr("2", t, color)  # noqa: E731
    parts = ["%d session%s" % (nsess, "" if nsess == 1 else "s"), "%d tree%s" % (len(roots), "" if len(roots) == 1 else "s"),
             "↑%s ↓%s" % (fmt_tok(tin), fmt_tok(tout))]
    line2 = d(" · ".join(parts))
    if show_cost:
        line2 += d(" · ") + sgr("34", "$%.2f" % tcost, color)
    ages = [now - n["last"] for _, n in table if n["glyph"] == "blocked" and n["last"] is not None]
    if ages:
        line2 += d(" · oldest block ") + sgr("33", fmt_age(max(ages)), color)
    if not table:
        return [head, line2, "", "no sessions"]
    gw = max(cell_width(symbols[sym_key(n)]) for _, n in table)
    pw = max(cell_width(p) + 2 + cell_width(n["name"]) for p, n in table)
    lines = [head, line2, ""]
    for i, (prefix, n) in enumerate(table):
        lost = n["glyph"] == "lost"
        pad = " " * (pw - cell_width(prefix) - 2 - cell_width(n["name"]))
        name = n["name"]
        m = re.search(r"[0-9a-f]{8}$", name)
        name_c = name if lost or not m or m.start() == 0 else name[:m.start()] + d(m.group(0))
        if lost:
            name_c = d(name)
        sym = symbols[sym_key(n)]
        glyph_c = sgr(COLORS[n["glyph"]], sym, color) + " " * (gw - cell_width(sym))
        sc = COLORS[n["glyph"]] if n["glyph"] in ("working", "blocked") else "2"
        state_c = sgr(sc, "%-9s" % n["state"], color)
        if lost:
            state_c = d("%-9s" % n["state"])
        a = n["last"]
        age = fmt_age(now - a) if a is not None else "-"
        ac = "2"
        if n["glyph"] == "blocked" and a is not None:
            ac = "31" if now - a > RED_AFTER else "33" if now - a > AMBER_AFTER else "2"
        age_c = sgr(ac, "%4s" % age, color)
        if lost:
            age_c = d("%4s" % age)
        tin, tout, cost = n["tot"]
        if tin or tout or cost:
            tok = d("↑%s ↓%s" % (fmt_tok(tin), fmt_tok(tout)))
            usage = tok + (" " + sgr("34", "$%.2f" % cost, color) if show_cost else "")
        else:
            usage = ""
        row = "%s%s %s%s  %s %s" % (d(prefix), glyph_c, name_c, pad, state_c, age_c)
        row = (row + "  " + usage) if usage else row
        if not color:
            row = row.rstrip()
        if color and i == selected:
            vis = cell_width(prefix) + gw + 1 + cell_width(name) + len(pad) + 2 + 9 + 1 + 4 + (2 + cell_width(re.sub(r"\x1b\[[0-9;]*m", "", usage)) if usage else 0)
            row = "\x1b[7m" + row.replace("\x1b[0m", "\x1b[0m\x1b[7m") + " " * max(0, width - vis) + "\x1b[0m"
        lines.append(row)
    return lines


def read_key(seconds, state):
    """Wait up to `seconds` for one key; return its raw sequence, or "" on timeout."""
    if sys.platform == "win32":
        import msvcrt
        end = time.time() + seconds
        while time.time() < end:
            if msvcrt.kbhit():
                ch = msvcrt.getwch()
                return ch + msvcrt.getwch() if ch in ("\xe0", "\x00") else ch
            time.sleep(0.05)
        return ""
    if not state.get("tty"):
        time.sleep(seconds)
        return ""
    import select
    ready, _, _ = select.select([sys.stdin], [], [], seconds)
    return os.read(sys.stdin.fileno(), 8).decode("utf-8", "replace") if ready else ""


def to_json_node(n, now, symbols):
    key = sym_key(n)
    age = None if n["last"] is None else max(0, int(now - n["last"]))
    blocked = None
    if n["state"] == "blocked":
        since = n["blockedSince"]
        blocked = max(0, int(now - since)) if since is not None else age
    elif n["state"] == "ask":
        blocked = age
    kids = [to_json_node(c, now, symbols) for c in n["children"]]
    cost = lambda t: {"in": int(t[0]), "out": int(t[1]), "cost": round(float(t[2]), 4)}  # noqa: E731
    return {"key": n["key"], "kind": n["kind"], "name": n["name"], "role": n["role"], "rung": n["rung"],
            "state": n["state"], "sym": key, "glyph": symbols[key], "paneId": n["pane"], "pid": n["pid"],
            "cwd": n["cwd"], "age_s": age, "blocked_s": blocked, "own": cost(n["own"]), "tot": cost(n["tot"]),
            "done_children": sum(1 for c in n["children"] if c["state"] == "done"), "children": kids}


def json_line(roots, now, sym_name, symbols):
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return json.dumps({"v": 1, "now": stamp, "symbols": sym_name,
                       "roots": [to_json_node(r, now, symbols) for r in roots]}, separators=(",", ":"))


def follow(adir, interval, since_h, done_ttl, sym_name, symbols, max_ticks=None):
    """One JSON line per refresh, flushed; quiet exit 0 on a closed pipe or Ctrl-C. No TTY handling."""
    cache = UsageCache()
    tick = 0
    try:
        while max_ticks is None or tick < max_ticks:
            now = time.time()
            print(json_line(snapshot(adir, now, since_h, cache, done_ttl), now, sym_name, symbols))
            sys.stdout.flush()
            tick += 1
            if max_ticks is None or tick < max_ticks:
                time.sleep(max(0.0, interval))
    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        try:
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        except (OSError, ValueError):
            pass
    return 0


def loop(adir, interval, since_h, color, done_ttl=None, symbols=None):
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
    ui = {"sel": 0, "cost": True, "status": "", "roots": [], "now": time.time()}

    def draw():
        table = rows(ui["roots"])
        ui["sel"] = max(0, min(ui["sel"], len(table) - 1))
        width = shutil.get_terminal_size((80, 24)).columns
        lines = render(ui["roots"], ui["now"], width, color, ui["cost"], ui["sel"] if table else None, symbols)
        out = "\n".join(lines) + "\n\n" + render_footer(color) + "\n" + ui["status"] + "\n"
        sys.stdout.write("\x1b[H\x1b[2J" + out)
        sys.stdout.flush()

    try:
        while True:
            ui["now"] = time.time()
            ui["roots"] = snapshot(adir, ui["now"], since_h, cache, done_ttl)
            draw()
            end = time.time() + interval
            while time.time() < end:
                act = decode_key(read_key(max(0.0, end - time.time()), state))
                if act == "quit":
                    return 0
                if act == "refresh":
                    break
                if act:
                    table = rows(ui["roots"])
                    ui["status"] = ""
                    if act == "cost":
                        ui["cost"] = not ui["cost"]
                    elif act in ("up", "down"):
                        ui["sel"] += -1 if act == "up" else 1
                    elif act == "enter" and table:
                        ui["status"] = node_path(table[max(0, min(ui["sel"], len(table) - 1))][1])
                    draw()
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
    ap.add_argument("--done-ttl", type=float, metavar="MINUTES",
                    help="hide done sessions (and delete their presence files) after this many minutes; default radar.doneTtlMinutes")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--json", action="store_true", help="print one JSON snapshot line and exit")
    ap.add_argument("--follow", action="store_true", help="print one JSON line per --interval until interrupted")
    ap.add_argument("--symbols", choices=("unicode", "nerd"), help="state symbol set; default ui.symbols")
    ap.add_argument("--max-ticks", type=int, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    for stream in (sys.stdout,):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    adir = agent_dir(a.agent_dir)
    ttl = a.done_ttl if a.done_ttl is not None else config_done_ttl(adir)
    sym_name = a.symbols or config_symbols(adir)
    symbols = load_symbols(sym_name)
    if a.follow:
        return follow(adir, a.interval, a.since, ttl, sym_name, symbols, a.max_ticks)
    if a.json:
        now = time.time()
        print(json_line(snapshot(adir, now, a.since, None, ttl), now, sym_name, symbols))
        return 0
    if a.once or not sys.stdout.isatty():
        now = time.time()
        width = shutil.get_terminal_size((80, 24)).columns
        print("\n".join(render(snapshot(adir, now, a.since, None, ttl), now, width, symbols=symbols) + ["", render_footer()]))
        return 0
    color = not a.no_color and not os.environ.get("NO_COLOR")
    return loop(adir, max(0.5, a.interval), a.since, color, ttl, symbols)


if __name__ == "__main__":
    sys.exit(main())
