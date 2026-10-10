#!/usr/bin/env python3
"""pi-foreman.sidebar: the foreman tree in Herdr's Agents panel.

Reads `foreman radar --json --follow` snapshots, joins each foreman session to
its Herdr pane and publishes `fm_*` tokens per pane over Herdr's socket. The
rows that render those tokens live in config-snippet.toml (`configure` prints
it). Standard library only, Python 3.9+. Imports on every OS; the daemon's
POSIX parts (flock, AF_UNIX) are reached only inside functions.

Subcommands: start | stop | run | status | configure | push.

`push` is the session's own fast path: it composes the tokens of one session
(radar imported in-process) and reports them for its pane, then touches a push
stamp. While a pane's stamp is fresh and its session is live, the daemon
publishes only `fm_sort` for that pane and leaves the other keys to the session.
"""

import argparse
import faulthandler
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata

PLUGIN_ID = "pi-foreman.sidebar"
SOURCE = "plugin:" + PLUGIN_ID
TTL_MS = 15000
ONCE_TTL_MS = 60000  # `run --once`: long enough to inspect by hand
INTERVAL_S = 5
# Watchdog: a radar child that prints no line for max(3 intervals, 2x the last
# snapshot duration) (plus a startup grace for its first line) is killed and
# restarted.
STARTUP_GRACE_S = 10
WATCHDOG_ENV = "PI_FOREMAN_SIDEBAR_WATCHDOG_S"  # hidden override (tests)
# Herdr config reference: "`ui.sidebar_width` integer default `26`".
DEFAULT_WIDTH = 26
# Row 3 is [fm_l3][fm_cost]. A typical root row needs "↑287k ↓7.4k" (11) +
# GAP (3) + "$0.25 ✓3" (8) = 22 columns inside width - INSET, so counts fit
# from 24. Cost alone needs 8 + INSET = 10; 20 leaves room for the tree indent
# of nested rows. Narrower panels (Herdr's minimum is 18) step down.
NARROW_COUNTS = 24   # below: drop token counts from fm_l3
NARROW_COST = 20     # below: clear fm_l3 and fm_cost
LATE_S = 900         # blocked longer than this: glyph gets a "!"
MAX_VALUE = 80
# Columns the Agents panel takes from `ui.sidebar_width` for its frame and
# padding.
INSET = 2
# Herdr configuration docs: "Herdr normally separates adjacent values with
# ` · ` and uses a single space after `state_icon`." Custom cells are not
# state_icon, so two non-empty cells of a row cost 3 columns between them.
GAP = 3
# Cells the user puts before $fm_sym on row 1 (an icon token, say), each
# assumed 1 column wide plus its separator; --lead-cells / HERDR_SIDEBAR_LEAD.
DEFAULT_LEAD = 0
LEAD_CELL_W = 1
# Line 1 stops this many columns short of its budget, so a misjudged frame
# or glyph width does not push the age into Herdr's ellipsis.
L1_MARGIN = 2
# Herdr trims token values at both ends, so a leading blank indent uses
# U+2800 (renders blank, is not whitespace) instead of spaces.
BLANK = "⠀"
KEYS = ("fm_sym", "fm_l1", "fm_l2", "fm_l3", "fm_cost",
        "fm_state", "fm_block_s", "fm_sort")
STALE_KEYS = ("fm_pre",)  # published by older versions; nulled at shutdown
# Keys a self-pushing session owns; the daemon keeps fm_sort (tree order).
SESSION_KEYS = tuple(k for k in KEYS if k != "fm_sort")
# A pane is self-pushing while its push stamp is younger than this (the TTL)
# and its session is not in one of these radar states.
STAMP_FRESH_S = TTL_MS / 1000.0
NOT_SELF_STATES = ("lost", "stale", "done")
SID_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")  # no ":" (an NTFS stream on Windows)
# Minimum line-1 label when the age is kept: "›…".
L1_MIN_LABEL = 2
SOCKET_FAILURES_MAX = 40
VIEW_RETRY_S = 60
VIEW_REFRESH_S = 60
LOG_MAX_BYTES = 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- formatting

def cell_width(text):
    """Terminal cells: East-Asian wide/full = 2, combining marks = 0."""
    w = 0
    for ch in text:
        if unicodedata.combining(ch):
            continue
        w += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return w


def truncate(text, width):
    """Cut `text` to at most `width` cells, ending in an ellipsis when cut."""
    if width <= 0:
        return ""
    if cell_width(text) <= width:
        return text
    out = ""
    for ch in text:
        if cell_width(out + ch) > width - 1:
            break
        out += ch
    return out + "…"


def fmt_age(secs):
    if secs is None:
        return ""
    secs = max(0, int(secs))
    if secs < 60:
        return "%ds" % secs
    if secs < 3600:
        return "%dm" % (secs // 60)
    if secs < 86400:
        return "%dh" % (secs // 3600)
    return "%dd" % (secs // 86400)


def fmt_tok(n):
    n = int(n or 0)
    if n < 1000:
        return str(n)
    if n < 10000:
        return "%.1fk" % (n / 1000.0)
    if n < 1000000:
        return "%dk" % (n // 1000)
    return "%.1fM" % (n / 1000000.0)


def fmt_cost(c):
    c = float(c or 0.0)
    return "$%.0f" % c if c >= 100 else "$%.2f" % c


def spread(left, right, width):
    """`left` + inner padding + `right`, right edge at `width` cells. When
    `left` would get fewer than L1_MIN_LABEL cells (`›…`), `right` is dropped,
    so the result never exceeds `width`."""
    if not right or width - cell_width(right) - 1 < L1_MIN_LABEL:
        return truncate(left, width)
    room = width - cell_width(right) - 1
    left = truncate(left, room)
    pad = max(1, width - cell_width(left) - cell_width(right))
    return left + " " * pad + right


def _cap(value):
    if value is None:
        return None
    value = "".join(ch for ch in value if unicodedata.category(ch) != "Cc").strip()
    if not value:
        return None
    if len(value) > MAX_VALUE:
        value = value[:MAX_VALUE - 1] + "…"
    assert len(value) <= MAX_VALUE
    return value


# ---------------------------------------------------------------- compose

def _is_row(node, joins):
    return node.get("kind") == "session" and bool(joins.get(node.get("key")))


def _row_children(nodes, joins):
    """Nodes that get their own pane rows: joined sessions, skipping through
    unjoined ones to their joined descendants."""
    out = []
    for n in nodes:
        if _is_row(n, joins):
            out.append(n)
        else:
            out.extend(_row_children(n.get("children") or [], joins))
    return out


def _recent_run(k, recent):
    """A done run that ended at most `recent` seconds ago (shown, not counted)."""
    ended = k.get("ended_s")
    return (k.get("kind") == "run" and k.get("state") == "done" and recent is not None
            and ended is not None and ended <= recent)


def fmt_counts(tot):
    """Row 3 counts: uncached input (fresh + cache writes) and output; the raw
    total with a "~" when the snapshot has no uncached figure."""
    unc = tot.get("uncached")
    if unc is None:
        return "↑~%s ↓%s" % (fmt_tok(tot.get("in")), fmt_tok(tot.get("out")))
    return "↑%s ↓%s" % (fmt_tok(unc), fmt_tok(tot.get("out")))


def _children_text(node, joins, recent=None):
    state = node.get("state")
    kids = node.get("children") or []
    if state == "lost":
        return "lost"
    if state == "done":
        if not kids:
            return "done"
        return "done · %d child%s" % (len(kids), "" if len(kids) == 1 else "ren")
    groups = []
    counts = {}
    for k in kids:
        if _is_row(k, joins) or (k.get("state") == "done" and not _recent_run(k, recent)):
            continue
        label = k.get("role") or k.get("name") or "?"
        if k.get("rung") and k["rung"] != "model":  # the base rung is implied
            label += " " + k["rung"]
        item = (k.get("glyph") or "") + " " + label
        if item not in counts:
            groups.append(item)
            counts[item] = 0
        counts[item] += 1
    if not groups:
        return "no active children" if kids else "no children"
    return " · ".join(g if counts[g] == 1 else "%s ×%d" % (g, counts[g]) for g in groups)


def compose(snapshot, width, joins=None, lead=DEFAULT_LEAD, self_panes=None, layout=None,
            layout_out=None):
    """Snapshot (radar --json) -> {paneId: {fm_key: value or None}}.

    `joins` maps node key -> paneId; without it each node's own `paneId` is
    used. `lead` counts the user's cells before $fm_sym on row 1. None values
    clear the token. Panes in `self_panes` get only `fm_sort` (their session
    publishes the rest). `layout` ({key: {pre, cont}}) places a root row at a
    tree position computed elsewhere; `layout_out` collects every row's.
    """
    if joins is None:
        joins = {}
        for n in walk(snapshot.get("roots") or []):
            if n.get("paneId"):
                joins[n["key"]] = n["paneId"]
    roots, joins = dedupe_panes(snapshot.get("roots") or [], joins)
    width = int(width)
    lead = max(0, int(lead))
    recent = snapshot.get("recentRunSeconds")
    self_panes = self_panes or ()
    out = {}

    def emit(node, sort, pre, cont):
        pane = joins[node["key"]]
        if layout_out is not None:
            layout_out[node["key"]] = {"pre": pre, "cont": cont}
        if pane in self_panes:
            out[pane] = {"fm_sort": _cap(sort)}
            return
        glyph = node.get("glyph") or ""
        blocked_s = node.get("blocked_s")
        sym = glyph
        if blocked_s is not None and blocked_s > LATE_S:
            sym = glyph + "!"
        # row 1: [lead cells][sym][l1], l1 = [tree prefix ]› name ... age
        used = INSET + lead * (LEAD_CELL_W + GAP) + (cell_width(sym) + GAP if sym else 0)
        right = fmt_age(blocked_s if blocked_s is not None else node.get("age_s"))
        left = (pre + " " if pre else "") + "› " + (node.get("name") or "?")
        l1 = spread(left, right, width - used - L1_MARGIN)
        # rows 2 and 3 indent under the glyph with the tree continuation
        indent = (cont + " ") if cont else ""
        room = width - INSET - cell_width(indent)
        l2 = indent + truncate(_children_text(node, joins, recent), room)
        tot = node.get("tot") or {}
        l3 = cost = None
        if width >= NARROW_COST:
            shown = sum(1 for k in node.get("children") or [] if _recent_run(k, recent))
            done = max(0, (node.get("done_children") or 0) - shown)
            cost_text, tick = fmt_cost(tot.get("cost")), ("✓%d" % done if done else "")
            cost_w = cell_width(cost_text) + (1 + cell_width(tick) if tick else 0)
            counts = ""
            if width >= NARROW_COUNTS:
                counts = fmt_counts(tot)
                if cell_width(indent + counts) + GAP + cost_w > width - INSET:
                    counts = ""  # the cost outranks the counts
            l3 = indent + counts if counts else (indent or None)
            cost_room = width - INSET - (cell_width(l3) + GAP if l3 else 0)
            cost = spread(cost_text, tick, cost_room)
        tokens = {
            "fm_sym": sym or None,
            "fm_l1": l1,
            "fm_l2": l2,
            "fm_l3": l3,
            "fm_cost": cost,
            "fm_state": node.get("sym") or node.get("state"),
            "fm_block_s": str(int(blocked_s)) if blocked_s is not None else None,
            "fm_sort": sort,
        }
        out[pane] = {k: _cap(tokens[k]) for k in KEYS}

    def walk_rows(nodes, sort_prefix, prefix_cont, depth):
        rows = _row_children(nodes, joins)
        for i, n in enumerate(rows, 1):
            last = i == len(rows)
            if depth == 0:
                sort, pre, cont, child_cont = "r%03d" % i, "", "", ""
                placed = (layout or {}).get(n.get("key"))
                if isinstance(placed, dict):
                    pre, cont = str(placed.get("pre") or ""), str(placed.get("cont") or "")
                    child_cont = cont
            else:
                sort = "%s.c%03d" % (sort_prefix, i)
                pre = prefix_cont + ("└─" if last else "├─")
                cont = prefix_cont + (BLANK * 2 if last else "│" + BLANK)
                child_cont = cont
            emit(n, sort, pre, cont)
            walk_rows(n.get("children") or [], sort, child_cont, depth + 1)

    walk_rows(roots, "", "", 0)
    return out


def _rank(node):
    """Live before done/lost, then the youngest."""
    age = node.get("age_s")
    return (node.get("state") in ("done", "lost"), float("inf") if age is None else age)


def dedupe_panes(roots, joins):
    """Keep exactly one session per pane (sessions restarted in one pane leave
    several presence files with its paneId). Losers are pruned from the tree:
    no row, no children text. Returns (pruned roots, joins of the winners)."""
    by_pane = {}
    for n in walk(roots):
        pane = joins.get(n.get("key"))
        if n.get("kind") == "session" and pane:
            by_pane.setdefault(pane, []).append(n)
    dropped = set()
    for nodes in by_pane.values():
        best = min(nodes, key=_rank)
        dropped.update(n["key"] for n in nodes if n is not best)

    def prune(nodes):
        return [dict(n, children=prune(n.get("children") or []))
                for n in nodes if n.get("key") not in dropped]

    return prune(roots), {k: v for k, v in joins.items() if k not in dropped}


def walk(nodes):
    for n in nodes:
        yield n
        for c in walk(n.get("children") or []):
            yield c


# ---------------------------------------------------------------- join

def _norm(path):
    if not path:
        return None
    return os.path.normcase(os.path.normpath(path)).rstrip("/\\") or "/"


def join(nodes, agents, procinfo=None):
    """Session nodes -> paneId. Presence paneId first (only while that pane is
    in `agents`, i.e. still open), then the node pid as a
    pane's foreground pid (`procinfo` = {paneId: pid}), then a cwd that
    matches exactly one unclaimed pi pane (and one unjoined node)."""
    procinfo = procinfo or {}
    sessions = [n for n in walk(nodes) if n.get("kind") == "session"]
    joins, claimed = {}, set()
    live = {a.get("pane_id") for a in agents or [] if a.get("pane_id")}
    for n in sessions:
        if n.get("paneId") and n["paneId"] in live:
            joins[n["key"]] = n["paneId"]
            claimed.add(n["paneId"])
    by_pid = {}
    for pane, pid in procinfo.items():
        if pid is not None:
            by_pid.setdefault(int(pid), pane)
    for n in sessions:
        if n["key"] in joins or n.get("pid") is None:
            continue
        pane = by_pid.get(int(n["pid"]))
        if pane and pane not in claimed:
            joins[n["key"]] = pane
            claimed.add(pane)
    pi_panes = [a for a in agents or [] if a.get("agent") == "pi" and a.get("pane_id")]
    rest = [n for n in sessions if n["key"] not in joins and _norm(n.get("cwd"))]
    for n in rest:
        cwd = _norm(n.get("cwd"))
        if sum(1 for m in rest if _norm(m.get("cwd")) == cwd) != 1:
            continue
        hits = [a["pane_id"] for a in pi_panes if a["pane_id"] not in claimed
                and cwd in (_norm(a.get("cwd")), _norm(a.get("foreground_cwd")))]
        if len(hits) == 1:
            joins[n["key"]] = hits[0]
            claimed.add(hits[0])
    return joins


def clears(prev, now, keep=()):
    """Null patches for panes published before and absent now; for panes in
    `keep` (fresh push stamp: the session owns its keys) only fm_sort."""
    return {pane: ({"fm_sort": None} if pane in keep else {k: None for k in KEYS})
            for pane in prev if pane not in now}


def fresh_stamps(sdir, now=None):
    """{session id: paneId} of push stamps younger than STAMP_FRESH_S."""
    now = time.time() if now is None else now
    d = os.path.join(sdir, "push")
    out = {}
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for name in names:
        if not name.endswith(".stamp"):
            continue
        path = os.path.join(d, name)
        try:
            if now - os.path.getmtime(path) >= STAMP_FRESH_S:
                continue
            with open(path, encoding="utf-8") as fh:
                pane = fh.read().strip()
        except OSError:
            continue
        if pane:
            out[name[:-len(".stamp")]] = pane
    return out


def self_panes_for(roots, joins, fresh):
    """Panes whose session pushes its own tokens: fresh stamp naming the pane
    the session is joined to, and the session neither lost, stale nor done."""
    out = set()
    for n in walk(roots):
        pane = joins.get(n.get("key"))
        sid = n.get("sid")
        if (n.get("kind") == "session" and pane and sid and fresh.get(sid) == pane
                and n.get("state") not in NOT_SELF_STATES):
            out.add(pane)
    return out


def write_atomic(path, text):
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def read_layout(sdir):
    try:
        with open(os.path.join(sdir, "layout.json"), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def view_retry_due(failed_at, now, every=None):
    """After a failed view call, try again only once `every` seconds passed."""
    return failed_at is None or now - failed_at >= (VIEW_RETRY_S if every is None else every)


def view_decision(prev_active, joined_count, since_set=None):
    """"set"/"clear" on transitions; while active, "set" again once
    `since_set` seconds reach VIEW_REFRESH_S (a restarted Herdr server
    forgets the view, and set is idempotent)."""
    if joined_count > 0 and not prev_active:
        return "set"
    if joined_count == 0 and prev_active:
        return "clear"
    if prev_active and joined_count > 0 and since_set is not None and since_set >= VIEW_REFRESH_S:
        return "set"
    return None


# ---------------------------------------------------------------- width

def herdr_config_dir(env=None):
    env = os.environ if env is None else env
    base = env.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "herdr")


def _config_width(path):
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return None
    table = ""
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        m = re.match(r"^\[\s*([^\]]+?)\s*\]$", line)
        if m:
            table = m.group(1).replace(" ", "")
            continue
        m = re.match(r"^([A-Za-z0-9_.]+)\s*=\s*(\d+)$", line)
        if m:
            key = (table + "." if table else "") + m.group(1)
            if key == "ui.sidebar_width":
                return int(m.group(2))
    return None


def read_width(args, env, herdr_config_path):
    """--width > HERDR_SIDEBAR_WIDTH > ui.sidebar_width in Herdr's config > 26."""
    w = getattr(args, "width", None) if args is not None else None
    if w:
        return int(w)
    raw = (env or {}).get("HERDR_SIDEBAR_WIDTH", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    if herdr_config_path:
        w = _config_width(herdr_config_path)
        if w:
            return w
    return DEFAULT_WIDTH


def read_lead(args, env):
    """--lead-cells > HERDR_SIDEBAR_LEAD > 0."""
    n = getattr(args, "lead_cells", None) if args is not None else None
    if n is not None and n >= 0:
        return int(n)
    raw = (env or {}).get("HERDR_SIDEBAR_LEAD", "").strip()
    if raw.isdigit():
        return int(raw)
    return DEFAULT_LEAD


# ---------------------------------------------------------------- herdr socket

class HerdrError(Exception):
    pass


def socket_path(env=None):
    env = os.environ if env is None else env
    return env.get("HERDR_SOCKET_PATH") or os.path.join(herdr_config_dir(env), "herdr.sock")


def _connect(path, timeout):
    family = getattr(socket, "AF_UNIX", None)
    if family is None:
        raise HerdrError("no AF_UNIX socket on this platform")
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(path)
    return s


def _readline(s):
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    return buf.decode("utf-8", "replace").strip()


_req_counter = [0]


def call(method, params, path=None, timeout=5.0):
    """One request per connection: write one JSON line, read one reply line."""
    _req_counter[0] += 1
    req = {"id": "fm%d" % _req_counter[0], "method": method, "params": params}
    s = _connect(path or socket_path(), timeout)
    try:
        s.sendall((json.dumps(req, ensure_ascii=False) + "\n").encode("utf-8"))
        line = _readline(s)
    finally:
        s.close()
    if not line:
        raise HerdrError("%s: empty reply" % method)
    reply = json.loads(line)
    if reply.get("error"):
        raise HerdrError("%s: %s" % (method, reply["error"]))
    return reply.get("result") or {}


def subscribe_loop(wake, stop, path=None):
    """Long-lived events.subscribe; every line after the ack sets `wake`."""
    delay = 0.5
    req = {"id": "fm-sub", "method": "events.subscribe", "params": {"subscriptions": [
        {"type": "pane.agent_detected"}, {"type": "pane.created"}]}}
    while not stop.is_set():
        try:
            s = _connect(path or socket_path(), None)
            try:
                s.sendall((json.dumps(req) + "\n").encode("utf-8"))
                fh = s.makefile("rb")
                ack = fh.readline()
                if not ack or b'"error"' in ack:
                    raise HerdrError("subscribe refused")
                delay = 0.5
                wake.set()
                for line in fh:
                    if stop.is_set():
                        break
                    if b"events_lost" in line:
                        break
                    wake.set()
            finally:
                s.close()
        except (OSError, ValueError, HerdrError):
            pass
        if stop.wait(delay):
            break
        delay = min(30.0, delay * 2)


# ---------------------------------------------------------------- daemon

def log(msg):
    sys.stderr.write("%s pi-foreman.sidebar: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stderr.flush()


def state_dir(env=None, home=None, tmp=None):
    """HERDR_PLUGIN_STATE_DIR (set by Herdr for its hooks and actions), else
    Herdr's plugin state path when its `herdr/plugins` folder exists (so a
    daemon started by hand shares pid and log with Herdr's), else TMPDIR."""
    env = os.environ if env is None else env
    d = env.get("HERDR_PLUGIN_STATE_DIR")
    if not d:
        base = env.get("XDG_STATE_HOME") or os.path.join(
            home or os.path.expanduser("~"), ".local", "state")
        plugins = os.path.join(base, "herdr", "plugins")
        if os.path.isdir(plugins):
            d = os.path.join(plugins, PLUGIN_ID)
        else:
            d = os.path.join(tmp or tempfile.gettempdir(), PLUGIN_ID)
    os.makedirs(d, exist_ok=True)
    return d


def plugin_root(env=None):
    env = os.environ if env is None else env
    return env.get("HERDR_PLUGIN_ROOT") or HERE


def find_foreman(flag=None, env=None, root=None):
    env = os.environ if env is None else env
    if flag:
        return flag
    if env.get("PI_FOREMAN_BIN"):
        return env["PI_FOREMAN_BIN"]
    cand = os.path.normpath(os.path.join(root or HERE, "..", "..", "..", "bin", "foreman"))
    if os.path.isfile(cand):
        return cand
    return shutil.which("foreman", path=env.get("PATH", ""))


def _radar_cmd(foreman, args, follow):
    cmd = [foreman, "radar", "--json"]
    if follow:
        cmd += ["--follow", "--interval", str(INTERVAL_S)]
    if args.agent_dir:
        cmd += ["--agent-dir", args.agent_dir]
    return cmd


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except (OSError, ValueError, SystemError):
        return False
    return True


def _read_pid(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return None


class Publisher:
    def __init__(self, args, sdir):
        self.args = args
        self.sdir = sdir
        self.view_file = os.path.join(sdir, "view.json")
        self.published = {}
        self.view_active = False
        self.failures = 0
        self.view_failed_at = None
        self.view_set_at = None
        self.view_errors = set()
        self.ttl_ms = TTL_MS
        self.joined_logged = None
        self.self_panes = set()
        self.report_failed = set()

    def width(self):
        return read_width(self.args, os.environ, os.path.join(herdr_config_dir(), "config.toml"))

    def lead(self):
        return read_lead(self.args, os.environ)

    def _call(self, method, params):
        try:
            res = call(method, params)
        except (OSError, ValueError) as exc:
            self.failures += 1
            if self.failures >= SOCKET_FAILURES_MAX:
                log("herdr socket failed %d times in a row, exiting" % self.failures)
                raise SystemExit(1)
            raise HerdrError(str(exc))
        self.failures = 0
        return res

    def _persist(self):
        try:
            with open(self.view_file, "w", encoding="utf-8") as fh:
                json.dump({"active": self.view_active}, fh)
        except OSError:
            pass

    def view(self, action):
        if self.args.no_view or action is None:
            return
        now = time.monotonic()
        if not view_retry_due(self.view_failed_at, now):
            return
        try:
            if action == "set":
                self._call("agent.view.set", {"source": SOURCE, "label": "pi-foreman", "sort": [
                    {"field": {"token": "fm_sort"}, "order": "asc"},
                    {"field": "attention", "order": "desc"}]})
                self.view_active = True
                self.view_set_at = now
            else:
                self._call("agent.view.clear", {"source": SOURCE})
                self.view_active = False
        except HerdrError as exc:
            self.view_failed_at = now
            msg = "view %s failed: %s" % (action, exc)
            if msg not in self.view_errors:
                self.view_errors.add(msg)
                log(msg + " (retrying at most every %ds)" % VIEW_RETRY_S)
            return
        self.view_failed_at = None
        self._persist()

    def reapply_view(self):
        try:
            with open(self.view_file, encoding="utf-8") as fh:
                wanted = bool(json.load(fh).get("active"))
        except (OSError, ValueError, AttributeError):
            wanted = False
        if wanted:
            self.view("set")

    def joins_for(self, snapshot):
        """agent.list (+ process_info for pid joins) -> (joins, agents)."""
        agents = self._call("agent.list", {}).get("agents") or []
        roots = snapshot.get("roots") or []
        joins = join(roots, agents)
        unjoined = [n for n in walk(roots) if n.get("kind") == "session"
                    and n["key"] not in joins and n.get("pid") is not None]
        if unjoined:
            procinfo = {}
            taken = set(joins.values())
            for a in agents:
                pane = a.get("pane_id")
                if a.get("agent") != "pi" or not pane or pane in taken:
                    continue
                try:
                    info = self._call("pane.process_info", {"pane_id": pane}).get("process_info") or {}
                    procs = info.get("foreground_processes") or []
                    procinfo[pane] = procs[0].get("pid") if procs else None
                except HerdrError:
                    continue
            joins = join(roots, agents, procinfo)
        return joins, agents

    def log_joined(self, snapshot, agents, joined):
        """One log line whenever the joined pane count changes."""
        if joined == self.joined_logged:
            return
        self.joined_logged = joined
        sessions = [n for n in walk(snapshot.get("roots") or []) if n.get("kind") == "session"]
        msg = "joined %d of %d sessions (%d agents listed)" % (joined, len(sessions), len(agents))
        if joined == 0 and sessions:
            live = {a.get("pane_id") for a in agents}
            stale = sorted({n["paneId"] for n in sessions if n.get("paneId")} - live)
            if stale:
                msg += "; presence paneIds not in agent.list: %s" % ", ".join(stale[:4])
            elif not any(a.get("agent") == "pi" for a in agents):
                msg += "; no pi pane in agent.list"
            else:
                msg += "; no pi pane matches a session pid or cwd"
        log(msg)

    def publish(self, snapshot):
        """Join, compose and report; returns {paneId: "ok" or "error: ..."}."""
        joins, agents = self.joins_for(snapshot)
        fresh = fresh_stamps(self.sdir)
        self.self_panes = self_panes_for(snapshot.get("roots") or [], joins, fresh)
        layout = {}
        now = compose(snapshot, self.width(), joins, self.lead(), self.self_panes, layout_out=layout)
        write_atomic(os.path.join(self.sdir, "layout.json"), json.dumps(layout, ensure_ascii=False))
        self.log_joined(snapshot, agents, len(now))
        patches = dict(now)
        patches.update(clears(self.published, now, set(fresh.values())))
        results = {}
        for pane, tokens in patches.items():
            try:
                self._call("pane.report_metadata", {"pane_id": pane, "source": SOURCE,
                                                    "tokens": tokens, "ttl_ms": self.ttl_ms})
                results[pane] = "ok"
            except HerdrError as exc:
                results[pane] = "error: %s" % exc
                if pane not in self.report_failed:  # log the transition, not every tick
                    self.report_failed.add(pane)
                    log("report %s failed: %s" % (pane, exc))
                continue
            if pane in self.report_failed:
                self.report_failed.discard(pane)
                log("report %s recovered" % pane)
        self.published = now
        since = None if self.view_set_at is None else time.monotonic() - self.view_set_at
        self.view(view_decision(self.view_active, len(now), since))
        return results

    def shutdown(self):
        for pane in list(self.published):
            # a self-pushing session keeps its keys; its own TTL ends them
            keys = ("fm_sort",) + STALE_KEYS if pane in self.self_panes else KEYS + STALE_KEYS
            try:
                call("pane.report_metadata", {"pane_id": pane, "source": SOURCE,
                                              "tokens": {k: None for k in keys}})
            except (OSError, ValueError, HerdrError):
                pass
        self.published = {}
        if self.view_active and not self.args.no_view:
            try:
                call("agent.view.clear", {"source": SOURCE})
            except (OSError, ValueError, HerdrError):
                pass
            self.view_active = False
            self._persist()


def _lock(sdir):
    try:
        import fcntl
    except ImportError:
        return True, None
    fh = open(os.path.join(sdir, "sidebar.lock"), "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return False, None
    return True, fh


def _parse_line(line):
    line = line.strip()
    if not line:
        return None
    try:
        snap = json.loads(line)
    except ValueError:
        return None
    return snap if isinstance(snap, dict) and "roots" in snap else None


def run_once(args, foreman):
    """One snapshot. Publishes with a 60 s TTL and prints one `<pane> ok` or
    `<pane> error: ...` line per report, then the tokens; `--dry-run` only
    composes (agent.list when the socket answers, else presence paneIds)."""
    try:
        out = subprocess.run(_radar_cmd(foreman, args, False), stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        log("foreman radar failed: %s" % exc)
        return 1
    snap = _parse_line(out.stdout.decode("utf-8", "replace"))
    if snap is None:
        log("foreman radar gave no snapshot (exit %d)" % out.returncode)
        return 1
    args.no_view = True  # --once never touches the Agents view
    pub = Publisher(args, state_dir())
    if args.dry_run:
        try:
            joins, agents = pub.joins_for(snap)
            tokens = compose(snap, pub.width(), joins, pub.lead())
            pub.log_joined(snap, agents, len(tokens))
        except HerdrError as exc:
            log("agent.list failed (%s); joining by presence paneId only" % exc)
            tokens = compose(snap, pub.width(), None, pub.lead())
        print(json.dumps(tokens, ensure_ascii=False))
        return 0
    pub.ttl_ms = ONCE_TTL_MS
    try:
        results = pub.publish(snap)
    except HerdrError as exc:
        log("publish failed: %s" % exc)
        return 1
    for pane in sorted(results):
        print("%s %s" % (pane, results[pane]))
    print(json.dumps(pub.published, ensure_ascii=False))
    return 0 if all(r == "ok" for r in results.values()) else 1


def _reader(proc, q):
    for raw in proc.stdout:
        q.put(raw)
    q.put(None)


def _executable(path):
    """Absolute path of the radar executable (posix_spawn needs one)."""
    if os.path.dirname(path):
        return os.path.abspath(path)
    return shutil.which(path) or path


def _watchdog_s(env=None, last_s=0.0):
    """(first-line wait, line wait): max(3 intervals, 2x the last snapshot
    duration `last_s`), plus the startup grace for the first line."""
    env = os.environ if env is None else env
    try:
        v = float(env.get(WATCHDOG_ENV, ""))
        if v > 0:
            return v, v
    except ValueError:
        pass
    base = max(3 * INTERVAL_S, 2 * float(last_s or 0.0))
    return base + STARTUP_GRACE_S, base


def _spawn_radar(foreman, args):
    # close_fds=False, an absolute executable, no cwd and no new session keep
    # CPython on its posix_spawn path: no fork of this threaded process, no
    # pre-exec code in the child. Python fds are non-inheritable by default.
    cmd = _radar_cmd(_executable(foreman), args, True)
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL,
                            close_fds=False, encoding="utf-8", errors="replace")


def _dump_stacks():
    try:
        faulthandler.dump_traceback(file=sys.stderr, all_threads=True)
    except (OSError, ValueError, AttributeError, RuntimeError):
        pass


def _end_child(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def run_daemon(args, foreman):
    sdir = state_dir()
    ok, lock = _lock(sdir)
    if not ok:
        return 0
    pid_file = os.path.join(sdir, "sidebar.pid")
    with open(pid_file, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))

    def on_term(signum, frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, on_term)
    if hasattr(faulthandler, "register") and hasattr(signal, "SIGUSR1"):
        faulthandler.register(signal.SIGUSR1, file=sys.stderr, all_threads=True)
    pub = Publisher(args, sdir)
    wake, stop = threading.Event(), threading.Event()
    subscriber = None
    proc = None
    last = None
    backoff = 1.0
    last_s = 0.0  # duration of the last radar snapshot, kept across restarts
    log("started, foreman %s, state dir %s" % (foreman, sdir))
    try:
        pub.reapply_view()
        while True:
            q = queue.Queue()
            proc = _spawn_radar(foreman, args)
            threading.Thread(target=_reader, args=(proc, q), daemon=True).start()
            if subscriber is None:  # after the first spawn, never before it
                subscriber = threading.Thread(target=subscribe_loop, args=(wake, stop), daemon=True)
                subscriber.start()
            spawned = last_line = time.monotonic()
            got_line = False
            stalled = False
            first_wait, line_wait = _watchdog_s(last_s=last_s)
            while True:
                try:
                    raw = q.get(timeout=1.0)
                except queue.Empty:
                    raw = ""
                if raw is None:
                    break
                now = time.monotonic()
                if raw:
                    last_s = max(0.0, now - last_line - (INTERVAL_S if got_line else 0))
                    first_wait, line_wait = _watchdog_s(last_s=last_s)
                    last_line = now
                    if not got_line:
                        got_line = True
                        log("first radar line after %.1fs" % (now - spawned))
                elif now - last_line > (line_wait if got_line else first_wait):
                    # a slow snapshot widens the next grace instead of looping
                    last_s = max(last_s, now - last_line - (INTERVAL_S if got_line else 0))
                    log("watchdog: no radar line for %.0fs, killing pid %d; stacks follow"
                        % (now - last_line, proc.pid))
                    _dump_stacks()
                    stalled = True
                    break
                snap = _parse_line(raw) if raw else None
                if snap is not None:
                    last = snap
                    backoff = 1.0
                elif not (wake.is_set() and last is not None):
                    continue
                wake.clear()
                try:
                    pub.publish(last)
                except HerdrError as exc:
                    log("publish failed: %s" % exc)
            _end_child(proc)
            log("foreman radar %s (%s), restarting in %.0fs"
                % ("stalled" if stalled else "exited", proc.returncode, backoff))
            time.sleep(backoff)
            backoff = min(30.0, backoff * 2)
    finally:
        stop.set()
        if proc is not None and proc.poll() is None:
            proc.terminate()
        pub.shutdown()
        if _read_pid(pid_file) == os.getpid():
            try:
                os.remove(pid_file)
            except OSError:
                pass
        if lock is not None:
            lock.close()


def cmd_start(extra):
    sdir = state_dir()
    pid = _read_pid(os.path.join(sdir, "sidebar.pid"))
    if pid and _pid_alive(pid):
        return 0
    log_path = os.path.join(sdir, "sidebar.log")
    try:
        if os.path.getsize(log_path) > LOG_MAX_BYTES:
            os.replace(log_path, log_path + ".1")
    except OSError:
        pass
    logf = open(log_path, "ab")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "run"] + extra,
                     start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=logf, stderr=logf)
    return 0


def cmd_stop():
    pid = _read_pid(os.path.join(state_dir(), "sidebar.pid"))
    if pid and _pid_alive(pid):
        os.kill(pid, signal.SIGTERM)
        print("stopped pid %d" % pid)
    else:
        print("not running")
    return 0


def cmd_status():
    sdir = state_dir()
    pid = _read_pid(os.path.join(sdir, "sidebar.pid"))
    print("state dir %s" % sdir)
    if pid and _pid_alive(pid):
        print("running pid %d" % pid)
        return 0
    print("not running")
    return 1


def _import_radar():
    """scripts/foreman_radar.py of the package this plugin lives in, or None."""
    scripts = os.path.normpath(os.path.join(HERE, "..", "..", "..", "scripts"))
    if not os.path.isfile(os.path.join(scripts, "foreman_radar.py")):
        log("push: foreman_radar.py not found next to the plugin (%s)" % scripts)
        return None
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    import foreman_radar
    return foreman_radar


def _cache_path(sdir, sid):
    return os.path.join(sdir, "push", sid + ".usage.json")


def push_tokens(radar, args, sdir, now=None):
    """{paneId: tokens} for the session `args.session` on pane `args.pane`
    (session-owned keys only); {} when radar does not know the session.
    Usage totals resume from a per-session byte-offset cache in the state dir,
    so a push reads only the usage lines appended since the last one."""
    now = time.time() if now is None else now
    adir = radar.agent_dir(args.agent_dir)
    sym_name = args.symbols or radar.config_symbols(adir)
    cache_file = _cache_path(sdir, args.session)
    try:
        with open(cache_file, encoding="utf-8") as fh:
            cache = radar.UsageCache(json.load(fh))
    except (OSError, ValueError):
        cache = radar.UsageCache()
    roots = radar.snapshot(adir, now, 24.0, cache, None, only=args.session)
    if not args.dry_run:
        try:
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            write_atomic(cache_file, json.dumps(cache.files))
        except OSError:
            pass
    if not roots:
        return {}
    snap = radar.json_doc(roots, now, sym_name, radar.load_symbols(sym_name),
                          radar.config_recent_runs(adir))
    root = snap["roots"][0]
    joins = {n["key"]: n["paneId"] for n in walk([root])
             if n.get("kind") == "session" and n.get("paneId") and n["paneId"] != args.pane}
    joins[root["key"]] = args.pane
    width = read_width(args, os.environ, os.path.join(herdr_config_dir(), "config.toml"))
    out = compose(snap, width, joins, read_lead(args, os.environ), layout=read_layout(sdir))
    tokens = out.get(args.pane) or {}
    return {args.pane: {k: tokens.get(k) for k in SESSION_KEYS}}


def cmd_push(args):
    """Best effort: exit 0 and quiet when Herdr is unreachable; 2 on bad usage
    or a missing radar. --dry-run prints the tokens and reports nothing."""
    if not args.session or not SID_RE.match(args.session) or not args.pane:
        log("push needs --session <id> and --pane <id>")
        return 2
    sdir = state_dir()
    stamp = os.path.join(sdir, "push", args.session + ".stamp")
    if args.clear:
        patch = {args.pane: {k: None for k in SESSION_KEYS}}
        if args.dry_run:
            print(json.dumps(patch))
            return 0
        for path in (stamp, _cache_path(sdir, args.session)):
            try:
                os.remove(path)
            except OSError:
                pass
    else:
        radar = _import_radar()
        if radar is None:
            return 2
        patch = push_tokens(radar, args, sdir)
        if args.dry_run:
            print(json.dumps(patch, ensure_ascii=False))
            return 0
        if not patch:
            return 0
    try:
        call("pane.report_metadata", {"pane_id": args.pane, "source": SOURCE,
                                      "tokens": patch[args.pane], "ttl_ms": TTL_MS}, timeout=2.0)
    except (OSError, ValueError, HerdrError):
        return 0
    if args.final:
        try:
            os.remove(stamp)  # the daemon takes the keys over at its next tick; the usage cache stays
        except OSError:
            pass
    elif not args.clear:
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
        except OSError:
            return 0
        write_atomic(stamp, args.pane)
    return 0


def cmd_configure():
    with open(os.path.join(HERE, "config-snippet.toml"), encoding="utf-8") as fh:
        sys.stdout.write(fh.read())
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sidebar.py", description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("start", "stop", "run", "status", "configure", "push"))
    ap.add_argument("--width", type=int)
    ap.add_argument("--no-view", action="store_true")
    ap.add_argument("--lead-cells", type=int)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="with run: compose once, report nothing")
    ap.add_argument("--foreman")
    ap.add_argument("--agent-dir")
    ap.add_argument("--session", help="with push: the session id")
    ap.add_argument("--pane", help="with push: the session's Herdr pane id")
    ap.add_argument("--symbols", choices=("unicode", "nerd"), help="with push: glyph set; default ui.symbols")
    ap.add_argument("--clear", action="store_true", help="with push: clear the session's keys")
    ap.add_argument("--final", action="store_true", help="with push: publish the final row, then drop only the stamp")
    argv = sys.argv[1:] if argv is None else argv
    args = ap.parse_args(argv)
    if args.command == "start":
        return cmd_start([a for a in argv if a != "start"])
    if args.command == "stop":
        return cmd_stop()
    if args.command == "status":
        return cmd_status()
    if args.command == "configure":
        return cmd_configure()
    if args.command == "push":
        return cmd_push(args)
    foreman = find_foreman(args.foreman, os.environ, plugin_root())
    if not foreman:
        log("foreman not found (set --foreman or PI_FOREMAN_BIN, or put foreman on PATH)")
        return 2
    if args.once or args.dry_run:
        return run_once(args, foreman)
    return run_daemon(args, foreman)


if __name__ == "__main__":
    sys.exit(main())
