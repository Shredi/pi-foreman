#!/usr/bin/env python3
"""pi-foreman.sidebar: the foreman tree in Herdr's Agents panel.

Reads `foreman radar --json --follow` snapshots, joins each foreman session to
its Herdr pane and publishes `fm_*` tokens per pane over Herdr's socket. The
rows that render those tokens live in config-snippet.toml (`configure` prints
it). Standard library only, Python 3.9+. Imports on every OS; the daemon's
POSIX parts (flock, AF_UNIX) are reached only inside functions.

Subcommands: start | stop | run | status | configure.
"""

import argparse
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
INTERVAL_S = 5
DEFAULT_WIDTH = 34
NARROW_COUNTS = 34   # below: drop token counts from fm_l3
NARROW_COST = 28     # below: clear fm_l3 and fm_cost
LATE_S = 900         # blocked longer than this: glyph gets a "!"
MAX_VALUE = 80
# Columns the Agents panel takes from `ui.sidebar_width` for its frame and
# padding, and the gap Herdr puts between two non-empty cells of a row.
INSET = 2
GAP = 1
# Herdr trims token values at both ends, so a leading blank indent uses
# U+2800 (renders blank, is not whitespace) instead of spaces.
BLANK = "⠀"
KEYS = ("fm_pre", "fm_sym", "fm_l1", "fm_l2", "fm_l3", "fm_cost",
        "fm_state", "fm_block_s", "fm_sort")
SOCKET_FAILURES_MAX = 40
VIEW_RETRY_S = 60
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
    """`left` + inner padding + `right`, right edge at `width` cells."""
    if not right:
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


def _children_text(node, joins):
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
        if _is_row(k, joins) or k.get("state") == "done":
            continue
        label = k.get("role") or k.get("name") or "?"
        if k.get("rung"):
            label += " " + k["rung"]
        item = (k.get("glyph") or "") + " " + label
        if item not in counts:
            groups.append(item)
            counts[item] = 0
        counts[item] += 1
    if not groups:
        return "no children"
    return " · ".join(g if counts[g] == 1 else "%s ×%d" % (g, counts[g]) for g in groups)


def compose(snapshot, width, joins=None):
    """Snapshot (radar --json) -> {paneId: {fm_key: value or None}}.

    `joins` maps node key -> paneId; without it each node's own `paneId` is
    used. None values clear the token.
    """
    if joins is None:
        joins = {}
        for n in walk(snapshot.get("roots") or []):
            if n.get("paneId"):
                joins[n["key"]] = n["paneId"]
    roots, joins = dedupe_panes(snapshot.get("roots") or [], joins)
    width = int(width)
    out = {}

    def emit(node, sort, pre, cont):
        pane = joins[node["key"]]
        glyph = node.get("glyph") or ""
        blocked_s = node.get("blocked_s")
        sym = glyph
        if blocked_s is not None and blocked_s > LATE_S:
            sym = glyph + "!"
        # row 1: [pre][sym][l1]
        used = INSET + (cell_width(pre) + GAP if pre else 0) + cell_width(sym) + GAP
        right = fmt_age(blocked_s if blocked_s is not None else node.get("age_s"))
        l1 = spread("› " + (node.get("name") or "?"), right, width - used)
        # rows 2 and 3 indent under the glyph with the tree continuation
        indent = (cont + " ") if cont else ""
        room = width - INSET - cell_width(indent)
        l2 = indent + truncate(_children_text(node, joins), room)
        tot = node.get("tot") or {}
        l3 = cost = None
        if width >= NARROW_COST:
            counts = ""
            if width >= NARROW_COUNTS:
                counts = "↑%s ↓%s" % (fmt_tok(tot.get("in")), fmt_tok(tot.get("out")))
            l3 = indent + counts if counts else (indent or None)
            done = node.get("done_children") or 0
            cost_room = room - (cell_width(counts) + GAP if counts else 0)
            cost = spread(fmt_cost(tot.get("cost")), "✓%d" % done if done else "", cost_room)
        tokens = {
            "fm_pre": pre or None,
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
    """Session nodes -> paneId. Presence paneId first, then the node pid as a
    pane's foreground pid (`procinfo` = {paneId: pid}), then a cwd that
    matches exactly one unclaimed pi pane (and one unjoined node)."""
    procinfo = procinfo or {}
    sessions = [n for n in walk(nodes) if n.get("kind") == "session"]
    joins, claimed = {}, set()
    for n in sessions:
        if n.get("paneId"):
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


def clears(prev, now):
    """Null patches for panes published before and absent now."""
    return {pane: {k: None for k in KEYS} for pane in prev if pane not in now}


def view_retry_due(failed_at, now, every=None):
    """After a failed view call, try again only once `every` seconds passed."""
    return failed_at is None or now - failed_at >= (VIEW_RETRY_S if every is None else every)


def view_decision(prev_active, joined_count):
    if joined_count > 0 and not prev_active:
        return "set"
    if joined_count == 0 and prev_active:
        return "clear"
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
    """--width > HERDR_SIDEBAR_WIDTH > ui.sidebar_width in Herdr's config > 34."""
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


def state_dir(env=None):
    env = os.environ if env is None else env
    d = env.get("HERDR_PLUGIN_STATE_DIR") or os.path.join(tempfile.gettempdir(), PLUGIN_ID)
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
        self.view_errors = set()

    def width(self):
        return read_width(self.args, os.environ, os.path.join(herdr_config_dir(), "config.toml"))

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

    def publish(self, snapshot):
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
        now = compose(snapshot, self.width(), joins)
        patches = dict(now)
        patches.update(clears(self.published, now))
        for pane, tokens in patches.items():
            try:
                self._call("pane.report_metadata", {"pane_id": pane, "source": SOURCE,
                                                    "tokens": tokens, "ttl_ms": TTL_MS})
            except HerdrError as exc:
                log("report %s failed: %s" % (pane, exc))
        self.published = now
        self.view(view_decision(self.view_active, len(now)))

    def shutdown(self):
        for pane in list(self.published):
            try:
                call("pane.report_metadata", {"pane_id": pane, "source": SOURCE,
                                              "tokens": {k: None for k in KEYS}})
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
    pub = Publisher(args, state_dir())
    try:
        pub.publish(snap)
    except HerdrError as exc:
        log("publish failed: %s" % exc)
        return 1
    print(json.dumps(pub.published, ensure_ascii=False))
    return 0


def _reader(proc, q):
    for raw in proc.stdout:
        q.put(raw)
    q.put(None)


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
    pub = Publisher(args, sdir)
    wake, stop = threading.Event(), threading.Event()
    threading.Thread(target=subscribe_loop, args=(wake, stop), daemon=True).start()
    proc = None
    last = None
    backoff = 1.0
    log("started, foreman %s" % foreman)
    try:
        pub.reapply_view()
        while True:
            q = queue.Queue()
            proc = subprocess.Popen(_radar_cmd(foreman, args, True), stdout=subprocess.PIPE,
                                    stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace")
            threading.Thread(target=_reader, args=(proc, q), daemon=True).start()
            while True:
                try:
                    raw = q.get(timeout=1.0)
                except queue.Empty:
                    raw = ""
                if raw is None:
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
            proc.wait()
            log("foreman radar exited (%s), restarting in %.0fs" % (proc.returncode, backoff))
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
    logf = open(os.path.join(sdir, "sidebar.log"), "ab")
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
    pid = _read_pid(os.path.join(state_dir(), "sidebar.pid"))
    if pid and _pid_alive(pid):
        print("running pid %d" % pid)
        return 0
    print("not running")
    return 1


def cmd_configure():
    with open(os.path.join(HERE, "config-snippet.toml"), encoding="utf-8") as fh:
        sys.stdout.write(fh.read())
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sidebar.py", description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("start", "stop", "run", "status", "configure"))
    ap.add_argument("--width", type=int)
    ap.add_argument("--no-view", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--foreman")
    ap.add_argument("--agent-dir")
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
    foreman = find_foreman(args.foreman, os.environ, plugin_root())
    if not foreman:
        log("foreman not found (set --foreman or PI_FOREMAN_BIN, or put foreman on PATH)")
        return 2
    if args.once:
        return run_once(args, foreman)
    return run_daemon(args, foreman)


if __name__ == "__main__":
    sys.exit(main())
