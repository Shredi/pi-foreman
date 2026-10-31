#!/usr/bin/env python3
"""Radar: a read-only tree of the running pi-foreman sessions and their subagent runs (stdlib, 3.13+).

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
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from foreman_session import agent_dir  # noqa: E402

LOST_AFTER = 90.0
STALE_AFTER = 900.0
DONE_TTL_MINUTES = 30.0
RECENT_RUN_SECONDS = 8
STARTING_WINDOW = 120.0
PULL_INTERVAL = 20  # sessions.pull.intervalSeconds default
REMOTE_LIVE_MAX = 90.0  # a remote child's heartbeat age plus the pull age must stay under this to show its live state
SYMBOLS_PATH = Path(__file__).resolve().parent.parent / "config" / "symbols.json"
SYM_ORDER = ("working", "waiting", "asking", "blocked", "done", "lost")
SYM_COLORS = {"working": "32", "waiting": "90", "asking": "33", "blocked": "33", "done": "90", "lost": "31"}
PRESENCE_KEYS = ("waiting-owner", "waiting-external", "idle", "needs-you")  # R11 P4 state icons; header counts stay on SYM_ORDER
FALLBACK_SYMBOLS = {"working": "⏳", "waiting": "⏸", "asking": "?", "blocked": "✋", "done": "✓", "lost": "✗",
                    "waiting-owner": "✋", "waiting-external": "↻", "idle": "⏸", "needs-you": "❓"}
SYMBOL_SETS = ("unicode", "emoji", "nerd", "ascii")
# Activity glyphs of the sidebar rows (agent run, task, wait, ask, finished run); the spinner is a list of frames.
FALLBACK_ACTIVITY = {"review": "◎", "agent": "◆", "task": "⚙", "wait": "◷", "ask": "?", "recent": "✓"}
FALLBACK_SPINNER = ("⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷")
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


SAFE_URL = re.compile(r"https://[A-Za-z0-9][A-Za-z0-9\-._~:/?#\[\]@!$()*+,;=%]*\Z")


def safe_https_url(value):
    """An https URL of URL characters only (no whitespace, control characters or " ' < > ^ | & backslash)."""
    return isinstance(value, str) and len(value) <= 2048 and SAFE_URL.match(value) is not None


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
    """Per usage file: byte offset and running totals, so a refresh reads only appended lines.
    Totals are [in, out, cost, uncached]: in counts fresh input + cache reads + cache writes, uncached only
    fresh input + cache writes (the tokens that cost more than a cache read)."""

    def __init__(self, files=None):
        self.files = files if isinstance(files, dict) else {}

    def read(self, path):
        key = str(path)
        st = self.files.get(key)
        try:
            info = Path(path).stat()
        except OSError:
            self.files.pop(key, None)
            return None
        size, ino = info.st_size, info.st_ino
        if not isinstance(st, dict) or size < st.get("offset", 0) or st.get("ino", ino) != ino:
            st = {"offset": 0, "tot": [0, 0, 0.0, 0], "runs": {}, "ino": ino}
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
                unc = num(row.get("input")) + num(row.get("cacheWrite"))
                for tot in (st["tot"], st["runs"].setdefault(str(row.get("launchId")), [0, 0, 0.0, 0])):
                    tot[0] += tin
                    tot[1] += tout
                    tot[2] += cost
                    tot[3] += unc
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


def config_pull_interval(adir):
    """sessions.pull.intervalSeconds of the merged config; the default on any failure."""
    try:
        import foreman_config
        v = (foreman_config.load_config(agent_dir=str(adir))["config"].get("sessions") or {}).get("pull", {}).get("intervalSeconds")
        if isinstance(v, int) and not isinstance(v, bool) and 5 <= v <= 300:
            return v
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        pass
    return PULL_INTERVAL


def config_recent_runs(adir):
    """radar.recentRunSeconds of the merged config; the default on any failure."""
    try:
        import foreman_config
        v = (foreman_config.load_config(agent_dir=str(adir))["config"].get("radar") or {}).get("recentRunSeconds")
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            return v
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        pass
    return RECENT_RUN_SECONDS


def config_open_prs(adir):
    """True when radar.openPrs.enabled is set in the merged config; False on any failure."""
    try:
        import foreman_config
        v = ((foreman_config.load_config(agent_dir=str(adir))["config"].get("radar") or {}).get("openPrs") or {}).get("enabled")
        return v is True
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        return False


OPEN_PR_STATES = ("fail", "run", "ok", "none")


def read_open_prs(adir):
    """(entries, fetched-at stamp) from state/open-prs.json, re-validated; None when the file is absent or unusable.
    The file is written by the extension (extensions/core-adapter/openprs.ts); this reads it and never uses the network."""
    d = read_json(Path(adir) / "pi-foreman" / "state" / "open-prs.json")
    if not isinstance(d, dict) or not isinstance(d.get("openPrs"), list):
        return None
    at = parse_ts(d.get("fetchedAt"))
    if at is None:
        return None
    out = []
    for p in d["openPrs"][:100]:
        if not isinstance(p, dict) or not safe_https_url(p.get("url")):
            continue
        num_ = p.get("number")
        repo, title, author = p.get("repo"), p.get("title"), p.get("author")
        if isinstance(num_, bool) or not isinstance(num_, int) or not all(isinstance(x, str) for x in (repo, title, author)) or not repo:
            continue
        checks = []
        for c in (p.get("checks") if isinstance(p.get("checks"), list) else [])[:10]:
            if isinstance(c, dict) and c.get("state") in OPEN_PR_STATES and isinstance(c.get("n"), str) and isinstance(c.get("label"), str):
                checks.append({"n": c["n"][:120], "state": c["state"], "label": c["label"][:20]})
        state = p.get("state") if p.get("state") in ("open", "draft") else "open"
        out.append({"repo": repo[:140], "number": num_, "title": title[:200], "url": p["url"], "state": state,
                    "author": author[:60], "checks": checks})
    return out, datetime.datetime.fromtimestamp(at, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def config_symbols(adir):
    """ui.symbols of the merged config: one of SYMBOL_SETS ("unicode" is the default, also for any unknown value or failure)."""
    try:
        import foreman_config
        v = (foreman_config.load_config(agent_dir=str(adir))["config"].get("ui") or {}).get("symbols")
        if v in SYMBOL_SETS:
            return v
    except Exception:  # noqa: BLE001 - display tool: a broken config must not stop the radar
        pass
    return "unicode"


def load_symbols(name="unicode"):
    """State-symbol table of one set from config/symbols.json; the built-in unicode set when unreadable."""
    d = read_json(SYMBOLS_PATH)
    table = d.get(name) if isinstance(d, dict) and isinstance(d.get(name), dict) else None
    if table is None:
        table = d.get("unicode") if isinstance(d, dict) and isinstance(d.get("unicode"), dict) else {}
    out = {k: table[k] if isinstance(table.get(k), str) else FALLBACK_SYMBOLS[k] for k in SYM_ORDER + PRESENCE_KEYS}
    out.update({k: table[k] if isinstance(table.get(k), str) else v for k, v in FALLBACK_ACTIVITY.items()})
    frames = table.get("spinner")
    out["spinner"] = list(frames) if isinstance(frames, list) and frames and all(isinstance(f, str) and f for f in frames) \
        else list(FALLBACK_SPINNER)
    return out


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


def asks_you(n):
    """An open ask waits for the owner on this session: an open ask.md of its own handoff, or a child run or
    session that asks (a forwarded permission prompt) and has not ended."""
    return bool(n.get("asks")) or any(c["state"] == "ask" and c.get("ended") is None for c in n["children"])


def icon_key(n):
    """Symbol key for a row: `needs-you` while an own dialog or ask, an open ask file or a forwarded child ask waits
    for the owner (it beats every other state but done and lost), else the presence state of a live session when
    its file has one, else sym_key."""
    key = sym_key(n)
    p = n.get("presence")
    if n["kind"] == "session" and n["glyph"] != "lost" and key not in ("done", "lost") and (p == "needs-you" or asks_you(n)):
        return "needs-you"
    if n["glyph"] != "lost" and key in ("waiting", "blocked", "working") and p in PRESENCE_KEYS + ("working",):
        return p
    return key


def cell_width(text):
    """Terminal cells of a string: wide and fullwidth characters count 2, combining marks 0."""
    w = 0
    prev = 0
    for ch in str(text):
        if ch == "\ufe0f":  # VS16 makes the character before it 2 cells
            w += 2 - prev if prev == 1 else 0
            prev = 2
            continue
        if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        prev = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        w += prev
    return w


def herdr_panes():
    """Pane ids of `herdr pane list`; None when Herdr cannot be asked (then nothing is provably gone)."""
    try:
        out = subprocess.run(["herdr", "pane", "list"], capture_output=True, text=True, timeout=3.0,
                             stdin=subprocess.DEVNULL, check=True).stdout
        panes = json.loads(out)["result"]["panes"]
        return {p["pane_id"] for p in panes if isinstance(p, dict) and isinstance(p.get("pane_id"), str)}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None


def pid_dead(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except (OSError, OverflowError, ValueError):
        return False
    return False


def provably_closed(d):
    """A session's presence file may go only when its pid is dead AND its pane is gone from `herdr pane list`."""
    pid = d.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or not pid_dead(pid):
        return False
    panes = herdr_panes()
    if panes is None:
        return False
    pane = d.get("paneId")
    return not (isinstance(pane, str) and pane in panes)


def prune_done(path, d, now, ttl_min, closed=None):
    """Delete one presence file whose state is done and whose last activity is older than the TTL; with `closed`
    (a predicate on the file's data) only when that also holds."""
    if d.get("state") != "done":
        return False
    times = [t for t in (parse_ts(d.get("heartbeatAt")), parse_ts(d.get("lastEventAt"))) if t is not None]
    last = max(times) if times else mtime(path)
    if last is None or now - last <= ttl_min * 60:
        return False
    if closed is not None and not closed(d):
        return False
    try:
        os.remove(path)
    except OSError:
        return False
    return True


def load(adir, cache=None, now=None, done_ttl=None, only=None, closed=None):
    """Read every source into plain data. No clock, no printing; with now and done_ttl (minutes) it also deletes
    the presence files of sessions that finished longer ago than the TTL. With `only` (a session id) usage and
    trace files are read only for that session's subtree."""
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
        if now is not None and done_ttl is not None and prune_done(base / "state" / "live" / name, d, now, done_ttl, closed):
            continue
        sid = d.get("sessionId") if isinstance(d.get("sessionId"), str) and d.get("sessionId") else name[:-5]
        d["sessionId"] = sid
        live.append(d)
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
        live_id = read_json(p / "live.json")  # R46: the child's own {intercomId, piSessionId}
        live_id = live_id if isinstance(live_id, dict) else {}
        handoffs[dn] = {"parent": read_line(p / "parent"), "child": read_line(p / "child"), "mtime": mtime(p),
                        "path": str(p),
                        "piSessionId": live_id.get("piSessionId") if isinstance(live_id.get("piSessionId"), str) else None,
                        "has": [f for f in ("result.md", "plan.md", "brief.md") if (p / f).exists()]}
    data = {"live": live, "registry": reg, "handoffs": handoffs, "usage": usage, "trace": trace,
            "pullInterval": config_pull_interval(adir)}
    keep = None if only is None else subtree_sids(data, only)
    for d in live:
        sid = d["sessionId"]
        if keep is not None and sid not in keep:
            continue
        u = cache.read(base / "state" / "usage" / (sid + ".jsonl"))
        if u:
            usage[sid] = u
        trace[sid] = mtime(base / "state" / ("trace-" + sid + ".jsonl"))
    return data


def find_sid(roots, sid):
    for n in roots:
        if n.get("sid") == sid:
            return n
        hit = find_sid([c for c in n["children"] if c["kind"] == "session"], sid)
        if hit is not None:
            return hit
    return None


def subtree_sids(data, sid):
    """Session ids of the subtree rooted at session `sid` (tree built without usage files)."""
    root = find_sid(build(dict(data, usage={}, trace={}), time.time()), sid)
    out = set()

    def visit(n):
        if n.get("sid"):
            out.add(n["sid"])
        for c in n["children"]:
            if c["kind"] == "session":
                visit(c)

    if root is not None:
        visit(root)
    return out


def new_node(kind, key, name):
    # own/tot: [in, out, cost, uncached]; uncached None = unknown (no usage file with the cache split)
    return {"kind": kind, "key": key, "name": name, "glyph": "idle", "state": "", "last": None, "started": None,
            "own": [0, 0, 0.0, 0], "children": [], "tot": [0, 0, 0.0, 0], "parent": None, "path": "",
            "role": None, "rung": None, "model": None, "waits": [], "tasks": [], "pane": None, "hcTerminal": None, "pid": None, "cwd": None, "blockedSince": None, "pressure": None,
            "sid": None, "ended": None, "unc_self": 0}


def live_glyph(d, now):
    state = d.get("state")
    hb = parse_ts(d.get("heartbeatAt"))
    if state != "done" and (hb is None or now - hb > LOST_AFTER):
        return "lost", "stale" if hb is None or now - hb > STALE_AFTER else "lost"
    if state == "blocked":
        return "blocked", "blocked"
    if state == "working":
        return "working", "working"
    if state == "waiting":  # a long wait is pending; Herdr's own status stays working
        return "working", "waiting"
    return "idle", "done" if state == "done" else "idle"


def reg_glyph(status, opened, now, has_result=False):
    young = opened is not None and now - opened < STARTING_WINDOW
    if status == "pending":
        return "starting", "pending"
    if status == "open":
        if has_result:  # no live file, but the child has reported: idle, not lost
            return "idle", "idle"
        return ("starting", "starting") if young else ("lost", "lost")
    if status == "failed":
        return "lost", "failed"
    return "idle", status if status in ("closing", "closed") else "idle"


def remote_glyph(e, opened, now, interval):
    """(glyph, state, pulled time) of a registry entry on a remote machine. The live state of the child counts while the
    last pull is younger than 3 x the pull interval + 30 s and the child's heartbeat age plus the pull age is under
    REMOTE_LIVE_MAX; an open ask, `closing` and `closed` come first; a pull entry with no pull success for that window
    is lost once its starting window is over."""
    pulled = parse_ts(e.get("pulledAt"))
    status = e.get("status")
    if status in ("open", "pending") and isinstance(e.get("ask"), dict):
        return "blocked", "ask", pulled
    if status not in ("open", "pending"):
        return (*reg_glyph(status, opened, now), pulled)
    pull_age = None if pulled is None else max(0.0, now - pulled)
    fresh = pull_age is not None and pull_age < 3 * interval + 30
    live = e.get("remoteLive") if isinstance(e.get("remoteLive"), dict) else {}
    beat = live.get("heartbeatAgeSeconds")
    if fresh and isinstance(beat, (int, float)) and not isinstance(beat, bool) and beat + pull_age < REMOTE_LIVE_MAX:
        state = live.get("state")
        if state == "blocked":
            return "blocked", "blocked", pulled
        if state == "working":
            return "working", "working", pulled
        return "idle", "done" if state == "done" else "idle", pulled
    if status == "pending" or e.get("returnPath") != "pull" or not fresh and pulled is None:
        return (*reg_glyph(status, opened, now), pulled)
    return ("idle", "idle", pulled) if fresh else ("lost", "lost", pulled)


def build(data, now):
    """Join live files, registry entries and handoff dirs into session nodes; return the list of roots."""
    nodes, by_sid, by_handoff = {}, {}, {}
    handoff_by_leaf = data["handoffs"]
    for d in data["live"]:
        sid = d["sessionId"]
        key = d.get("intercomId") if isinstance(d.get("intercomId"), str) and d.get("intercomId") else "sid:" + sid
        n = nodes.get(key) or new_node("session", key, "")
        cwd_name = base_name(d["cwd"]) + " " if isinstance(d.get("cwd"), str) and d.get("cwd") else ""
        n["name"] = (d.get("label") if isinstance(d.get("label"), str) and d.get("label") else "") or n["name"] or cwd_name + sid[:8]
        n["glyph"], n["state"] = live_glyph(d, now)
        n["presence"] = d.get("presence")
        n["sid"] = sid
        times = [parse_ts(d.get("lastEventAt")), data["trace"].get(sid)]
        times = [t for t in times if t is not None]
        n["last"] = max(times) if times else parse_ts(d.get("heartbeatAt"))
        n["started"] = parse_ts(d.get("startedAt"))
        n["path"] = next((d[k] for k in ("sessionFile", "cwd", "handoff") if isinstance(d.get(k), str) and d[k]), "")
        n["pane"] = d["paneId"] if isinstance(d.get("paneId"), str) and d["paneId"] else None
        n["hcTerminal"] = d["hcTerminal"] if isinstance(d.get("hcTerminal"), str) and d["hcTerminal"] else None
        n["pid"] = d["pid"] if isinstance(d.get("pid"), int) and not isinstance(d.get("pid"), bool) else None
        n["cwd"] = d["cwd"] if isinstance(d.get("cwd"), str) and d["cwd"] else None
        n["blockedSince"] = parse_ts(d.get("blockedSince"))
        pr = d.get("pressure")
        n["pressure"] = ({"level": pr["level"], "reasons": [r for r in (pr.get("reasons") or []) if isinstance(r, str)]}
                         if isinstance(pr, dict) and pr.get("level") in ("high", "critical") else None)
        n["parent"] = d.get("parentIntercom") if isinstance(d.get("parentIntercom"), str) and d.get("parentIntercom") else n["parent"]
        ho = handoff_by_leaf.get(leaf(d.get("handoff")))
        if ho and not n["parent"] and ho["parent"]:
            n["parent"] = ho["parent"]
        hb = parse_ts(d.get("heartbeatAt"))
        since_hb = max(0.0, now - hb) if hb is not None else 0.0
        for w in d.get("waits") or []:
            if isinstance(w, dict):  # ageSeconds is as of the heartbeat
                wn = {"id": str(w.get("id") or ""), "kind": str(w.get("kind") or ""),
                      "note": str(w.get("note") or ""),
                      "age_s": int(num(w.get("ageSeconds")) + since_hb),
                      "left_s": max(0, int(num(w.get("leftSeconds")) - since_hb))}
                if w.get("bg") is True:  # additive fields, copied only when present
                    wn["bg"] = True
                prs = [p for p in (w.get("prs") or []) if isinstance(p, int) and not isinstance(p, bool)]
                if prs:
                    wn["prs"] = prs
                n["waits"].append(wn)
        for t in d.get("tasks") or []:
            if isinstance(t, dict):
                n["tasks"].append({"id": str(t.get("id") or ""), "label": str(t.get("label") or ""),
                                   "pid": t["pid"] if isinstance(t.get("pid"), int) and not isinstance(t.get("pid"), bool) else None,
                                   "ageSeconds": int(num(t.get("ageSeconds")) + since_hb)})
        asks = [{"n": a["n"], "topic": str(a.get("topic") or "")} for a in (d.get("asks") or [])
                if isinstance(a, dict) and isinstance(a.get("n"), int) and not isinstance(a.get("n"), bool)]
        if asks:
            n["asks"] = asks
        dots = []
        for x in d.get("dots") or []:
            if not isinstance(x, dict) or len(dots) >= 14:
                continue
            dn, label = x.get("n"), x.get("label")
            if not (dn is None or (isinstance(dn, int) and not isinstance(dn, bool))):
                continue
            if x.get("state") not in ("fail", "run", "ok", "none") or x.get("src") not in ("pr", "ext"):
                continue
            if not isinstance(label, str) or not label:
                continue
            dot = {"n": dn, "state": x["state"], "label": label[:20], "src": x["src"]}
            if safe_https_url(x.get("url")):
                dot["url"] = x["url"]
            dots.append(dot)
        if dots:
            n["dots"] = dots
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
            rn["model"] = r["model"] if isinstance(r.get("model"), str) and r["model"] else None
            rn["glyph"] = "blocked" if rs == "ask" else "working" if rs == "working" else "idle"
            if rn["glyph"] != "idle" and n["glyph"] == "lost":
                rn["glyph"] = "lost"
            rn["last"], rn["path"] = n["last"], n["path"]
            rn["ended"] = parse_ts(r.get("endedAt"))
            ru = (u or {}).get("runs", {}).get(str(r.get("launchId")))
            rn["own"] = list(ru) if ru else [num(r.get("tokensIn")), num(r.get("tokensOut")), num(r.get("cost")), None]
            rn["tot"] = list(rn["own"])
            n["children"].append(rn)
        pres = [d.get("tokensIn"), d.get("tokensOut"), d.get("cost")]
        # uncached: the presence file has no cache split, so it always comes from the usage file, which holds
        # every call of the session and its runs
        n["unc_self"] = u["tot"][3] if u else None
        if any(isinstance(x, (int, float)) and not isinstance(x, bool) for x in pres):
            own_unc = None
            if u:
                own_unc = u["tot"][3] - sum(c["own"][3] for c in n["children"] if c["own"][3] is not None)
            n["own"] = [num(x) for x in pres] + [own_unc]
            n["pres"] = True
        else:
            n["own"] = list(u["tot"]) if u else [sum(c["own"][0] for c in n["children"]),
                                                  sum(c["own"][1] for c in n["children"]),
                                                  sum(c["own"][2] for c in n["children"]), None]
        nodes[key] = n
        by_sid[sid] = n
        if leaf(d.get("handoff")):
            by_handoff[leaf(d.get("handoff"))] = n
    merged = set()
    for e in data["registry"]:
        key = e.get("child") if isinstance(e.get("child"), str) and e.get("child") else None
        if not key:
            continue
        n = nodes.get(key)
        opened = parse_ts(e.get("opened"))
        if n is None and leaf(e.get("handoff")) in by_handoff:
            # the child's live file carries its own published id, not the registry child id: same session, one node
            live = by_handoff[leaf(e.get("handoff"))]
            if not live["parent"] and isinstance(e.get("parent"), str) and e["parent"]:
                live["parent"] = e["parent"]
            merged.add(key)
            continue
        ho = handoff_by_leaf.get(leaf(e.get("handoff")))
        if n is None:
            n = new_node("session", key, e.get("label") if isinstance(e.get("label"), str) and e.get("label") else key)
            last = e.get("last")
            n["last"] = parse_ts(last.get("at")) if isinstance(last, dict) else None
            if isinstance(e.get("machine"), str) and e["machine"]:
                n["machine"] = e["machine"]
                n["name"] += "@" + e["machine"]
                n["glyph"], n["state"], n["pulled"] = remote_glyph(e, opened, now, data.get("pullInterval") or PULL_INTERVAL)
                n["last"] = max([t for t in (n["last"], n["pulled"]) if t is not None], default=None)
            else:
                n["glyph"], n["state"] = reg_glyph(e.get("status"), opened, now, bool(ho and "result.md" in ho["has"]))
            n["last"] = n["last"] or opened
            n["started"] = opened
            n["path"] = e["handoff"] if isinstance(e.get("handoff"), str) else ""
            if ho and ho.get("piSessionId") and not n["sid"]:
                n["sid"] = ho["piSessionId"]
            nodes[key] = n
        if isinstance(e.get("parent"), str) and e["parent"] and not n["parent"]:
            n["parent"] = e["parent"]
        if n["started"] is None:
            n["started"] = opened
        if ho and not n["parent"] and ho["parent"]:
            n["parent"] = ho["parent"]
    reg_keys = set(nodes) | merged
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
        n["glyph"], n["state"] = reg_glyph("open", opened, now, "result.md" in ho["has"])
        n["last"], n["started"], n["parent"] = opened, opened, ho["parent"] or None
        n["path"] = ho.get("path") or ""
        n["sid"] = ho.get("piSessionId") or None
        nodes[key] = n

    def parent_of(n):
        """The node a recorded parent id names: a session key (intercom id), else a live session's Pi session id (a
        restarted parent keeps its session id but may publish a new intercom id), else the Pi session id in the
        parent's own handoff live.json."""
        ref = n["parent"]
        if not ref:
            return None
        p = nodes.get(ref) or by_sid.get(ref)
        if p is None:
            for ho in handoff_by_leaf.values():
                if ho.get("piSessionId") and ho["piSessionId"] in by_sid and ref == ho.get("child"):
                    p = by_sid[ho["piSessionId"]]
                    break
        return p

    roots, seen = [], set()
    for n in nodes.values():
        p = parent_of(n)
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
            p = parent_of(n)
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
    n["tot"] = [n["own"][0], n["own"][1], n["own"][2], n["own"][3] if n["kind"] == "run" else n["unc_self"]]
    for c in (runs + subs if n.get("pres") else subs):  # presence totals exclude the runs; usage-file totals include them
        for i in range(3):
            n["tot"][i] += c["tot"][i]
    for c in subs:  # unc_self already holds the runs (usage file)
        n["tot"][3] = None if n["tot"][3] is None or c["tot"][3] is None else n["tot"][3] + c["tot"][3]
    if n["glyph"] in ACTIVE or subs:
        return True
    if done_ttl is not None and n["state"] == "done" and n["last"] is not None and now - n["last"] > done_ttl * 60:
        return False
    return n["last"] is None or now - n["last"] <= since_h * 3600


def snapshot(adir, now, since_h=24.0, cache=None, done_ttl=None, only=None, closed=None):
    """Roots of the session tree; with `only` (a session id) just that session's subtree as the one root."""
    roots = build(load(adir, cache, now, done_ttl, only, closed), now)
    if only is not None:
        hit = find_sid(roots, only)
        roots = [hit] if hit is not None else []
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
    gw = max(cell_width(symbols[icon_key(n)]) for _, n in table)
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
        sym = symbols[icon_key(n)]
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
        tin, tout, cost = n["tot"][:3]
        if tin or tout or cost:
            tok = d("↑%s ↓%s" % (fmt_tok(tin), fmt_tok(tout)))
            usage = tok + (" " + sgr("34", "$%.2f" % cost, color) if show_cost else "")
        else:
            usage = ""
        row = "%s%s %s%s  %s %s" % (d(prefix), glyph_c, name_c, pad, state_c, age_c)
        row = (row + "  " + usage) if usage else row
        wait_txt = ""
        if n["waits"]:  # wait column: first wait's note (else kind), its age, +n for the others
            w0 = n["waits"][0]
            wait_txt = "wait %s %s%s" % (w0["note"] or w0["kind"], fmt_age(w0["age_s"]),
                                       " +%d" % (len(n["waits"]) - 1) if len(n["waits"]) > 1 else "")
            row += "  " + sgr("36", wait_txt, color)
        if not color:
            row = row.rstrip()
        if color and i == selected:
            vis = cell_width(prefix) + gw + 1 + cell_width(name) + len(pad) + 2 + 9 + 1 + 4 + (2 + cell_width(re.sub(r"\x1b\[[0-9;]*m", "", usage)) if usage else 0) + (2 + cell_width(wait_txt) if wait_txt else 0)
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
    key = icon_key(n)
    age = None if n["last"] is None else max(0, int(now - n["last"]))
    blocked = None
    if n["state"] == "blocked":
        since = n["blockedSince"]
        blocked = max(0, int(now - since)) if since is not None else age
    elif n["state"] == "ask":
        blocked = age
    kids = [to_json_node(c, now, symbols) for c in n["children"]]
    cost = lambda t: {"in": int(t[0]), "out": int(t[1]), "cost": round(float(t[2]), 4),  # noqa: E731
                      "uncached": None if t[3] is None else int(t[3])}
    out = {"key": n["key"], "kind": n["kind"], "name": n["name"], "role": n["role"], "rung": n["rung"],
            "state": n["state"], "sym": key, "glyph": symbols[key], "paneId": n["pane"], "hcTerminal": n.get("hcTerminal"), "pid": n["pid"],
            "cwd": n["cwd"], "age_s": age, "blocked_s": blocked, "own": cost(n["own"]), "tot": cost(n["tot"]),
            "done_children": sum(1 for c in n["children"] if c["state"] == "done"), "children": kids}
    if n["kind"] == "session":
        if n.get("machine"):
            out["machine"] = n["machine"]
            out["pulled_s"] = None if n.get("pulled") is None else max(0, int(now - n["pulled"]))
        out["sid"] = n["sid"]
        out["waits"] = n["waits"]
        out["started"] = n["started"]
        if n.get("tasks"):
            out["tasks"] = n["tasks"]
        if n.get("asks"):
            out["asks"] = n["asks"]
        if n.get("dots"):
            out["dots"] = n["dots"]
        if n.get("pressure"):
            out["pressure"] = n["pressure"]
    else:
        out["model"] = n["model"]
        out["ended_s"] = None if n["ended"] is None else max(0, int(now - n["ended"]))
    return out


def json_doc(roots, now, sym_name, symbols, recent=RECENT_RUN_SECONDS, open_prs=None):
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {"v": 1, "now": stamp, "symbols": sym_name, "recentRunSeconds": recent,
           "roots": [to_json_node(r, now, symbols) for r in roots]}
    if open_prs is not None:
        doc["openPrs"], doc["openPrsAt"] = open_prs
    return doc


def json_line(roots, now, sym_name, symbols, recent=RECENT_RUN_SECONDS, open_prs=None):
    return json.dumps(json_doc(roots, now, sym_name, symbols, recent, open_prs), separators=(",", ":"))


def follow(adir, interval, since_h, done_ttl, sym_name, symbols, max_ticks=None, recent=RECENT_RUN_SECONDS, closed=None, open_prs=False):
    """One JSON line per refresh, flushed; quiet exit 0 on a closed pipe or Ctrl-C. No TTY handling."""
    cache = UsageCache()
    tick = 0
    try:
        while max_ticks is None or tick < max_ticks:
            now = time.time()
            print(json_line(snapshot(adir, now, since_h, cache, done_ttl, closed=closed), now, sym_name, symbols, recent,
                            read_open_prs(adir) if open_prs else None))
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


def loop(adir, interval, since_h, color, done_ttl=None, symbols=None, closed=None):
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
            ui["roots"] = snapshot(adir, ui["now"], since_h, cache, done_ttl, closed=closed)
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
    ap.add_argument("--symbols", choices=SYMBOL_SETS, help="state symbol set; default ui.symbols")
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
    if a.follow or a.json:
        recent = config_recent_runs(adir)
        with_prs = config_open_prs(adir)
    if a.follow:
        return follow(adir, a.interval, a.since, ttl, sym_name, symbols, a.max_ticks, recent, provably_closed, with_prs)
    if a.json:
        now = time.time()
        print(json_line(snapshot(adir, now, a.since, None, ttl, closed=provably_closed), now, sym_name, symbols, recent,
                        read_open_prs(adir) if with_prs else None))
        return 0
    if a.once or not sys.stdout.isatty():
        now = time.time()
        width = shutil.get_terminal_size((80, 24)).columns
        print("\n".join(render(snapshot(adir, now, a.since, None, ttl, closed=provably_closed), now, width, symbols=symbols) + ["", render_footer()]))
        return 0
    color = not a.no_color and not os.environ.get("NO_COLOR")
    return loop(adir, max(0.5, a.interval), a.since, color, ttl, symbols, provably_closed)


if __name__ == "__main__":
    sys.exit(main())
