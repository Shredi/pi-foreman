#!/usr/bin/env python3
"""pi-foreman.sidebar: the foreman tree in Herdr's Agents panel.

Reads `foreman radar --json --follow` snapshots, joins each foreman session to
its Herdr pane and publishes `fm_*` tokens per pane over Herdr's socket. The
rows that render those tokens live in config-snippet.toml (`configure` prints
it). Standard library only, Python 3.13+. Imports on every OS; the daemon's
POSIX parts (flock, AF_UNIX) are reached only inside functions.

Subcommands: start | stop | run | status | configure | push | sample.

`push` is the session's own fast path: it composes the tokens of one session
(radar imported in-process) and reports them for its pane, then touches a push
stamp. While a pane's stamp is fresh and its session is live, the daemon
publishes only `fm_sort` for that pane and leaves the other keys to the session.
`push --json` composes the same tokens but reports nothing: it prints them with
the header template (`{spin}` for the animated glyph) for the session's own publisher.

`sample` overrides one pane's tokens with a synthetic session for a while (`sample/<pane>.json` in
the state folder): `push` and the daemon use that file for the pane until it expires or `--clear`.
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
# The meta line (fm_meta) shows cost and counts. Cost alone needs 8 + INSET = 10 columns; 20 leaves
# room for the tree indent of nested rows. Narrower panels (Herdr's minimum is 18) hide it.
NARROW_COST = 20     # below: no meta line
LATE_S = 900         # blocked longer than this: glyph gets a "!"
MAX_VALUE = 80
# Columns the Agents panel takes from `ui.sidebar_width` for its frame and
# padding.
INSET = 2
# Herdr configuration docs: "Herdr normally separates adjacent values with
# ` · ` and uses a single space after `state_icon`." Custom cells are not
# state_icon, so two non-empty cells of a row cost 3 columns between them.
GAP = 3
# Cells the user puts before the first token of row 1 besides Herdr's state_icon; kept for
# compatibility (--lead-cells / HERDR_SIDEBAR_LEAD), the header ignores it.
DEFAULT_LEAD = 0
# An unchanged row is sent again only after this many seconds, to keep the TTL alive.
REPUSH_S = 10
# At this width and above the children line shows a run's model and its rung.
WIDE_CHILDREN = 60
# A pushed tree position (tree.json) and the legacy layout.json count as current this long: two
# daemon intervals. Older, the session builds the tree itself.
TREE_FRESH_S = 2 * INTERVAL_S
# fm_hd tokens stop this many columns short of the sidebar width: INSET plus one safety column.
SAFETY = 1
# Activity lines show this many items, then ` +n`.
MAX_ITEMS = 3
# One tree level is three cells: a connector `├─ `/`└─ `, a continuation or a child marker.
UNIT = 3
CONN_MID, CONN_LAST = "├─ ", "└─ "
# Private-use stand-in for the animated glyph while the header template is built (one cell wide).
SPIN_MARK = "\ue000"
SYMBOLS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "config", "symbols.json")
AUX_FALLBACK = {"review": "◎", "agent": "◆", "task": "⚙", "wait": "◷", "ask": "?", "recent": "✓", "working": "⏳",
                "waiting": "⏸", "blocked": "✋", "done": "✓", "lost": "✗", "waiting-owner": "✋",
                "waiting-external": "↻", "idle": "⏸",
                "pr-fail": "●", "pr-run": "◉", "pr-ok": "○", "pr-none": "◌"}
# The static state glyphs that, with the spinner frames, set the width of the header's state slot.
STATE_KEYS = ("working", "waiting", "blocked", "done", "lost", "waiting-owner", "waiting-external", "idle")
REVIEW_ROLES = ("reviewer", "senior-reviewer")
SPINNER_FALLBACK = ("⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷")
SYMBOL_SETS = ("unicode", "emoji", "nerd", "ascii")
# Herdr trims token values at both ends, so a leading blank indent uses
# U+2800 (renders blank, is not whitespace) instead of spaces.
BLANK = "⠀"
CONT_MID, CONT_LAST = "│" + BLANK * 2, BLANK * 3
# Herdr 0.9.3 draws the second and later rows of an agent entry this many cells right of the first
# row (no config key changes it). The header (first row) gets the same number of blank cells in
# front, and the detail rows lose them from their budget, so connectors and `│` share a column.
DETAIL_INDENT = 2
# The PR dots row: up to four cells, one token each, so Herdr can colour each dot by its own rules.
PR_KEYS = ("fm_pr1", "fm_pr2", "fm_pr3", "fm_pr4")
DOT_STATES = ("fail", "run", "ok", "none")  # shown in this order: red, yellow, green, unknown
# The circle glyphs of the unicode and nerd sets (the sets with colour rules) never appear in a label.
DOT_CIRCLES = "●◉○◌\uf111\uf192\uf10c\uf1db"
_CIRCLES_TO_Q = {ord(c): "?" for c in DOT_CIRCLES}
PANE_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,100}")
SAMPLE_MINUTES = 10
SAMPLE_MAX_S = 7 * 86400
KEYS = ("fm_hd", "fm_a1", "fm_a2", "fm_a3") + PR_KEYS + ("fm_meta", "fm_state", "fm_block_s", "fm_sort")
# Published by older versions (the first row layout and its prefix); nulled at shutdown and on clears,
# and by a session's final or clearing push (SESSION_KEYS plus LEGACY_KEYS are 16 tokens).
LEGACY_KEYS = ("fm_sym", "fm_l1", "fm_l2", "fm_l3", "fm_cost")
STALE_KEYS = LEGACY_KEYS + ("fm_pre",)
# Herdr takes at most this many tokens in one pane report.
MAX_TOKENS = 16
# Keys a self-pushing session owns; the daemon keeps fm_sort (tree order).
SESSION_KEYS = tuple(k for k in KEYS if k != "fm_sort")
# A pane is self-pushing while its push stamp is younger than this (the TTL)
# and its session is not in one of these radar states.
STAMP_FRESH_S = TTL_MS / 1000.0
NOT_SELF_STATES = ("lost", "stale", "done")
SID_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}$")  # no ":" (an NTFS stream on Windows)
SOCKET_FAILURES_MAX = 40
VIEW_RETRY_S = 60
VIEW_REFRESH_S = 60
LOG_MAX_BYTES = 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------- formatting

def cell_width(text):
    """Terminal cells, as wcwidth and Rust's unicode-width count them: a VS16 (U+FE0F) after a
    character makes it 2; otherwise East-Asian wide/full = 2; combining marks, ZWJ and VS15 = 0."""
    w = prev = 0
    for ch in text:
        if ch == "\ufe0f":
            if prev == 1:
                w += 1
                prev = 2
            continue
        if ch == "\u200d" or unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me"):
            continue
        prev = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        w += prev
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


def _pressure_suffix(p):
    """` ⚠ <reasons>` when the host is under pressure (level high or critical), else empty."""
    if not isinstance(p, dict) or p.get("level") not in ("high", "critical"):
        return ""
    reasons = [str(r) for r in (p.get("reasons") or []) if r]
    return " ⚠ " + ",".join(reasons) if reasons else " ⚠"


def _cap(value):
    if value is None:
        return None
    value = "".join(ch for ch in value if unicodedata.category(ch) not in ("Cc", "Cf")).strip()
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


def short_model(model):
    """`claude-bridge/claude-sonnet-5-5` -> `sonnet-5.5`: no provider, no `claude-`
    prefix, no date suffix, a trailing `-N-M` version as `N.M`; None for no model."""
    if not isinstance(model, str):
        return None
    m = model.strip().split("/")[-1]
    m = re.sub(r"[-@]\d{8}$|-\d{4}-\d{2}-\d{2}$", "", m)
    m = re.sub(r"^claude-", "", m)
    m = re.sub(r"-(\d+)-(\d{1,2})$", r"-\1.\2", m)
    return m or None


def _run_label(k, width):
    """Role, then its short model, then its rung: the rung only while no model is
    shown (the base rung is implied), or on a wide panel."""
    label = k.get("role") or k.get("name") or "?"
    model = short_model(k.get("model"))
    if model:
        label += " " + model
    rung = k.get("rung")
    if rung and rung != "model" and (not model or (width or 0) >= WIDE_CHILDREN):
        label += " " + rung
    return label


def _remote_label(k):
    """`label@machine · state · age` of a session on another machine (no pane here)."""
    age = fmt_age(k.get("age_s"))
    return " · ".join(p for p in (k.get("name") or "?", k.get("state") or "", age) if p)


_aux_cache = {}


def aux_symbols(name):
    """Activity glyphs (review, agent, task, wait, ask, recent), the state glyphs and the spinner frames of one glyph set, from
    config/symbols.json; a key the file lacks (or a missing file) falls back to the unicode set."""
    name = name if name in SYMBOL_SETS else "unicode"
    if name not in _aux_cache:
        try:
            with open(SYMBOLS_FILE, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = {}
        data = data if isinstance(data, dict) else {}

        def table(which):
            t = data.get(which)
            return t if isinstance(t, dict) else {}

        def pick(key, fallback):
            for t in (table(name), table("unicode")):
                if isinstance(t.get(key), str) and t[key]:
                    return t[key]
            return fallback

        got = {k: pick(k, v) for k, v in AUX_FALLBACK.items()}
        frames = table(name).get("spinner") or table("unicode").get("spinner")
        ok = isinstance(frames, list) and frames and all(isinstance(f, str) and f for f in frames)
        got["spinner"] = list(frames) if ok else list(SPINNER_FALLBACK)
        _aux_cache[name] = got
    return _aux_cache[name]


_UNITS = re.compile("^(?:" + re.escape(CONT_MID) + "|" + re.escape(CONT_LAST) + ")*$")


def _placement(t):
    """A pushed tree position ({P, conn, own}) when well formed, else None."""
    if not isinstance(t, dict):
        return None
    p, conn, own = t.get("P", ""), t.get("conn", ""), t.get("own", "")
    if (isinstance(p, str) and _UNITS.match(p) and conn in ("", CONN_MID, CONN_LAST)
            and own in ("", CONT_MID, CONT_LAST)):
        return {"P": p, "conn": conn, "own": own}
    return None


def _child_order(n):
    s = n.get("started")
    return (s is None, s if s is not None else 0, n.get("sid") or "", n.get("key") or "")


def tree_rows(roots, joins, tree=None):
    """The one tree function: [(node, sort, place)] in display order for the joined rows.

    `place` = {P, conn, own, kids}. P is the ancestors' continuations below the root, conn the
    node's connector (`├─ `/`└─ `, empty for a root), own the continuation under its own
    connector (empty for a root), kids whether it has row children. All units are three cells.
    Roots keep their order; children are ordered by start time, then session id, then key.
    `tree` ({key: {P, conn, own}}) positions a root row inside a tree built elsewhere."""
    out = []

    def walk_rows(nodes, sort_prefix, prefix, depth):
        rows = _row_children(nodes, joins)
        if depth:
            rows = sorted(rows, key=_child_order)
        for i, n in enumerate(rows, 1):
            last = i == len(rows)
            if depth == 0:
                sort = "r%03d" % i
                place = _placement((tree or {}).get(n.get("key"))) or {"P": "", "conn": "", "own": ""}
            else:
                sort = "%s.c%03d" % (sort_prefix, i)
                place = {"P": prefix, "conn": CONN_LAST if last else CONN_MID,
                         "own": CONT_LAST if last else CONT_MID}
            place["kids"] = bool(_row_children(n.get("children") or [], joins))
            out.append((n, sort, place))
            walk_rows(n.get("children") or [], sort, place["P"] + place["own"], depth + 1)

    walk_rows(roots, "", "", 0)
    return out


def slot_width(aux):
    """Cells of the state slot of one glyph set: the widest spinner frame or static state glyph (2 for
    unicode and emoji, whose ⏳ ✋ ✅ ⏸️ are wide, 1 for nerd and ascii). The reason icon is not in the
    header, so every row of a set has one label column. A VS16 glyph such as ⏸️ counts 2, as
    `cell_width` counts it; a terminal that draws it in 1 cell shifts the label by one."""
    return max([cell_width(f) for f in aux["spinner"]] + [cell_width(aux[k]) for k in STATE_KEYS])


def _slot(glyph, width=2):
    """The glyph cell of a header: always `width` cells, so the label never moves."""
    w = cell_width(glyph)
    return glyph + BLANK * (width - w) if 0 < w <= width else BLANK * width


def _live_kid(k):
    """A child session without its own pane row that still runs: not idle, waiting, done or lost, and
    not closed, closing or done."""
    return (k.get("sym") not in ("idle", "waiting", "done", "lost")
            and k.get("state") not in ("closed", "closing", "done"))


def _reason(node, joins):
    """What a session waits on, first match wins: ask (a child run asks), review (a reviewer runs), agent
    (another run, or a live child session without a pane row), task (PR, CI or bg wait, or a task),
    wait (any other wait); None for the session's own turn."""
    kids = node.get("children") or []
    runs = [k for k in kids if k.get("kind") == "run" and k.get("state") != "done"]
    if any(k.get("state") == "ask" for k in runs):
        return "ask"
    if any(k.get("role") in REVIEW_ROLES for k in runs):
        return "review"
    if runs or any(k.get("kind") == "session" and not _is_row(k, joins) and _live_kid(k) for k in kids):
        return "agent"
    waits = [w for w in node.get("waits") or [] if isinstance(w, dict)]
    if node.get("tasks") or any(_is_pr(w) or _is_ci(w) or w.get("bg") for w in waits):
        return "task"
    return "wait" if waits else None


def _state_cell(node, joins, aux):
    """(static cell, ticking cell or None) of a header's state slot, before padding. Sym `working`,
    `waiting-external` and `idle` with a reason animate: the ticking cell is `SPIN_MARK` alone. The static
    cell (daemon-published pane, spinner off) is the state glyph. The reason icon lives on the detail
    rows only, so the slot holds one glyph and the label column is the same in every row."""
    sym = node.get("sym")
    if not (sym in ("working", "waiting-external") or (sym == "idle" and _reason(node, joins))):
        return node.get("glyph") or "", None
    return node.get("glyph") or aux.get(sym) or "", SPIN_MARK


def _prefix_only(prefix, budget, indent=""):
    """`indent` and `prefix` cut at a unit boundary to fit `budget`; None when not even one unit fits."""
    cut = prefix[:max(0, (budget - cell_width(indent)) // UNIT * UNIT)]
    return indent + cut if cut else None


def _header(place, glyph, label, age, budget, slot=2):
    """`P conn slot label ... age`. Room is short: the age drops when the label would get under
    four cells, then the label shrinks to one character and `…`; with less room the token is the
    prefix cut at a unit boundary. The row starts with DETAIL_INDENT blank cells, which Herdr adds
    to the rows below it."""
    indent = BLANK * DETAIL_INDENT
    left = indent + place["P"] + place["conn"] + _slot(glyph, slot) + " "
    room = budget - cell_width(left)
    if room < 2:
        return _prefix_only(place["P"] + place["conn"], budget, indent)
    if age and room - cell_width(age) - 1 >= 4:
        lab = truncate(label, room - cell_width(age) - 1)
        return left + lab + " " * (room - cell_width(lab) - cell_width(age)) + age
    return left + truncate(label, room)


def _detail_left(place):
    return place["P"] + place["own"] + (CONT_MID if place["kids"] else CONT_LAST)


def _detail(place, text, budget):
    """A detail line: `P own marker text`. `text` is a string, or (body, hidden) whose ` +hidden`
    suffix is kept when the body is cut. None gives no line."""
    if not text:
        return None
    body, hidden = (text, 0) if isinstance(text, str) else text
    budget -= DETAIL_INDENT  # Herdr draws this row that many cells right
    left = _detail_left(place)
    room = budget - cell_width(left)
    suffix = " +%d" % hidden if hidden else ""
    if suffix and room - cell_width(suffix) < 2:
        suffix = ""
    if room - cell_width(suffix) < 2:
        return _prefix_only(left, budget)
    return left + truncate(body, room - cell_width(suffix)) + suffix


def pane_id_ok(pane):
    """A pane id safe to put in a file name: 1 to 100 of letters, digits and `._:-`, not `.` or `..`
    (the plugin is Linux and macOS only, so `:` is fine)."""
    return isinstance(pane, str) and bool(PANE_ID_RE.fullmatch(pane)) and pane not in (".", "..")


def _dot_label(label):
    """A dot label without control and format characters (bidi overrides, zero-width), the circle
    glyphs replaced by `?`; None for no label."""
    if not isinstance(label, str):
        return None
    label = "".join(ch for ch in label if unicodedata.category(ch) not in ("Cc", "Cf"))
    return label.translate(_CIRCLES_TO_Q).strip() or None


def _dot_items(dots, aux):
    """[(circle, label)] of a session's `dots` ([{n, state, label, src}]): red, yellow, green, unknown,
    then by number (external items without one last), then label; items without a label are dropped."""
    items = []
    for d in dots if isinstance(dots, list) else []:
        label = _dot_label(d.get("label")) if isinstance(d, dict) else None
        if label is None:
            continue
        state = d.get("state") if d.get("state") in DOT_STATES else "none"
        n = d.get("n") if isinstance(d.get("n"), int) and not isinstance(d.get("n"), bool) else None
        items.append((DOT_STATES.index(state), n is None, n or 0, label, aux["pr-" + state]))
    items.sort(key=lambda i: i[:4])
    return [(i[4], i[3]) for i in items]


def _dots(place, dots, budget, aux):
    """The four fm_pr cells: `<circle> <label>` per item, cell 1 behind the continuation. Cells are
    placed left to right while they fit (GAP columns of Herdr separator each); when items are hidden
    the last placed cell becomes `+n` (n = items not shown). Cell 1 is never dropped: it is cut
    with `…`, or the token is the continuation prefix when not even circle and `…` fit. No items,
    no value."""
    items = _dot_items(dots, aux)
    out = [None] * len(PR_KEYS)
    if not items:
        return out
    budget -= DETAIL_INDENT  # Herdr draws this row that many cells right
    left = _detail_left(place)
    room = budget - cell_width(left)
    if room < cell_width(items[0][0]) + 1:
        out[0] = _prefix_only(left, budget)
        return out
    cells = [c + " " + label for c, label in items[:len(PR_KEYS)]]
    row = [truncate(cells[0], room)]
    used = cell_width(row[0])
    for cell in cells[1:]:
        if used + GAP + cell_width(cell) > room:
            break
        used += GAP + cell_width(cell)
        row.append(cell)
    if len(row) > 1:
        if len(row) < len(items):
            row[-1] = "+%d" % (len(items) - len(row) + 1)
    elif len(items) > 1:
        more = "+%d" % (len(items) - 1)
        if used + GAP + cell_width(more) <= room:
            row.append(more)
    row[0] = left + row[0]
    out[:len(row)] = row
    return out


def _meta(node, recent, width, place, budget):
    """`↑in ↓out · $cost · ✓n`: the token counts drop as a whole when the line would not fit.
    Hidden on a panel narrower than NARROW_COST."""
    if width < NARROW_COST:
        return None
    tot = node.get("tot") or {}
    shown = sum(1 for k in node.get("children") or [] if _recent_run(k, recent))
    done = max(0, (node.get("done_children") or 0) - shown)
    parts = [fmt_cost(tot.get("cost")) + _pressure_suffix(node.get("pressure"))]
    if done:
        parts.append("✓%d" % done)
    if not (tot.get("in") or tot.get("out") or tot.get("uncached")):
        return " · ".join(parts)
    full = " · ".join([fmt_counts(tot)] + parts)
    if cell_width(_detail_left(place)) + cell_width(full) <= budget - DETAIL_INDENT:
        return full
    return " · ".join(parts)


def _wait_item(w):
    return "%s %s" % (w.get("note") or w.get("kind") or "wait", fmt_age(w.get("age_s")))


def _is_ci(w):
    return w.get("kind") == "ci"


def _is_pr(w):
    return w.get("kind") == "pr"


def _items(glyph, items):
    """(`glyph item · item`, hidden count): at most MAX_ITEMS items; None for no item."""
    if not items:
        return None
    return "%s %s" % (glyph, " · ".join(items[:MAX_ITEMS])), max(0, len(items) - MAX_ITEMS)


def _agent_line(node, joins, recent, width, aux):
    """fm_a1: the running child runs (`◆ builder sonnet-5.5 ×2 · reviewer`), then the runs that
    just finished (`✓ role`); a done session shows its run count, a lost one `lost`."""
    state = node.get("state")
    kids = node.get("children") or []
    if node.get("sym") == "lost" or state == "lost":
        return "lost"
    if state in ("done", "closed"):
        runs = sum(1 for k in kids if k.get("kind") == "run")
        return "done · %d run%s" % (runs, "" if runs == 1 else "s") if runs else None
    groups, counts = [], {}
    for k in kids:
        if _is_row(k, joins) or (k.get("kind") == "session" and not _live_kid(k)):
            continue
        finished = k.get("state") == "done"
        if finished and not _recent_run(k, recent):
            continue
        item = (finished, _remote_label(k) if k.get("machine") else _run_label(k, width))
        if item not in counts:
            groups.append(item)
            counts[item] = 0
        counts[item] += 1
    text = lambda g: g[1] if counts[g] == 1 else "%s ×%d" % (g[1], counts[g])  # noqa: E731
    running = [text(g) for g in groups if not g[0]]
    recents = [aux["recent"] + " " + text(g) for g in groups if g[0]]
    shown = (running + recents)[:MAX_ITEMS]
    hidden = len(running) + len(recents) - len(shown)
    parts = []
    if running and shown[:len(running)]:
        parts.append(aux["agent"] + " " + " · ".join(shown[:len(running)]))
    parts.extend(shown[len(running):])
    return (" · ".join(parts), hidden) if parts else None


def _task_line(node, aux):
    """fm_a2: PR watches, CI waits, background commands (waits flagged `bg`), then the bg_run tasks."""
    waits = [w for w in node.get("waits") or [] if isinstance(w, dict)]
    items = []
    for w in waits:
        if _is_pr(w):
            prs = [p for p in w.get("prs") or [] if isinstance(p, int) and not isinstance(p, bool)]
            if prs:
                items.extend("pr #%d" % p for p in prs)
            else:
                items.append(w.get("note") or "pr")
    items += [_wait_item(w) for w in waits if _is_ci(w) and not _is_pr(w)]
    items += [_wait_item(w) for w in waits if w.get("bg") and not _is_ci(w) and not _is_pr(w)]
    items += ["%s %s" % (t.get("label") or t.get("id") or "task", fmt_age(t.get("ageSeconds")))
              for t in node.get("tasks") or [] if isinstance(t, dict)]
    return _items(aux["task"], items)


def _wait_line(node, aux):
    """fm_a3: an open ask (`? ask 1: topic`), then the other waits (timer, file, child, pid)."""
    kids = node.get("children") or []
    asks = [(a.get("n"), str(a.get("topic") or "")) if isinstance(a, dict) else (None, str(a))
            for a in node.get("asks") or [] if a]
    n = len(asks) + sum(1 for k in kids if k.get("kind") == "run" and k.get("state") == "ask")
    if not n and node.get("state") == "ask":
        n = 1
    if asks and isinstance(asks[0][0], int) and not isinstance(asks[0][0], bool):
        n = asks[0][0]
    topic = asks[0][1] if asks else ""
    parts = ["%s ask %d%s" % (aux["ask"], n, ": " + topic if topic else "")] if n else []
    waits = [w for w in node.get("waits") or [] if isinstance(w, dict)
             and not (w.get("bg") or _is_ci(w) or _is_pr(w))]
    line = _items(aux["wait"], [_wait_item(w) for w in waits])
    if line:
        parts.append(line[0])
    if not parts:
        return None
    return " · ".join(parts), line[1] if line else 0


def _activity(node, joins, recent, width, aux):
    """(fm_a1, fm_a2, fm_a3) texts of one session: what runs (agents), what it watches (tasks, PRs,
    CI, background commands) and what it waits on (an ask, timers, children). None = nothing to show."""
    if node.get("sym") == "lost" or node.get("state") in ("lost", "done", "closed"):
        return _agent_line(node, joins, recent, width, aux), None, None
    return (_agent_line(node, joins, recent, width, aux), _task_line(node, aux),
            _wait_line(node, aux))


def compose(snapshot, width, joins=None, lead=DEFAULT_LEAD, self_panes=None, layout=None,
            layout_out=None, tree=None, tree_out=None, tpl_out=None):
    """Snapshot (radar --json) -> {paneId: {fm_key: value or None}}.

    `joins` maps node key -> paneId; without it each node's own `paneId` is
    used. `lead` is kept for compatibility (the header ignores it).
    None values clear the token. Panes in `self_panes` get only `fm_sort` (their
    session publishes the rest). `layout` ({key: {pre, cont}}) and `tree`
    ({key: {P, conn, own}}) place a root row at a tree position computed elsewhere
    (legacy prefixes and the new rows); `layout_out` and `tree_out` collect every
    row's. `tpl_out` collects, per pane of an animated session (working, waiting on something external,
    idle with a reason), the fm_hd header with its state slot as `{spin}`.
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
    symbols = snapshot.get("symbols")
    self_panes = self_panes or ()
    aux = aux_symbols(symbols)
    slot = slot_width(aux)
    budget = max(0, width - INSET - SAFETY)
    out = {}

    def emit(node, sort, place, pre, cont):
        pane = joins[node["key"]]
        if layout_out is not None:
            layout_out[node["key"]] = {"pre": pre, "cont": cont}
        if tree_out is not None:
            tree_out[node["key"]] = {k: place[k] for k in ("P", "conn", "own")}
        if pane in self_panes:
            out[pane] = {"fm_sort": _cap(sort)}
            return
        blocked_s = node.get("blocked_s")
        age = fmt_age(blocked_s if blocked_s is not None else node.get("age_s"))
        if blocked_s is not None and blocked_s > LATE_S:
            age += "!"
        label = node.get("name") or "?"
        static, spin = _state_cell(node, joins, aux)
        if tpl_out is not None and spin:
            tpl_out[pane] = _cap(_header(place, spin, label, age, budget, slot).replace(SPIN_MARK, "{spin}"))
        a1, a2, a3 = _activity(node, joins, recent, width, aux)
        tokens = {
            "fm_hd": _header(place, static, label, age, budget, slot),
            "fm_a1": _detail(place, a1, budget),
            "fm_a2": _detail(place, a2, budget),
            "fm_a3": _detail(place, a3, budget),
            "fm_meta": _detail(place, _meta(node, recent, width, place, budget), budget),
            "fm_state": node.get("sym") or node.get("state"),
            "fm_block_s": str(int(blocked_s)) if blocked_s is not None else None,
            "fm_sort": sort,
        }
        tokens.update(zip(PR_KEYS, _dots(place, node.get("dots"), budget, aux)))
        out[pane] = {k: _cap(tokens[k]) for k in KEYS}

    for n, sort, place in tree_rows(roots, joins, tree):
        # the row prefixes come from the same placement; a pushed layout wins for a root
        pre, cont = place["P"] + place["conn"][:2], place["P"] + place["own"][:2]
        placed = (layout or {}).get(n.get("key")) if not sort.count(".") else None
        if isinstance(placed, dict):
            pre, cont = str(placed.get("pre") or ""), str(placed.get("cont") or "")
        emit(n, sort, place, pre, cont)
    return out


def _rank(node, fg_pid=None):
    """Total order for the sessions that claim one pane (smaller wins), independent
    of input order: a fresh heartbeat before a stale one (so a reused pid cannot
    revive a dead record), live before done, a pid that is the pane's foreground
    process, the youngest, then the session id."""
    age = node.get("age_s")
    pid = node.get("pid")
    state = node.get("state")
    return (state in ("lost", "stale"), state in NOT_SELF_STATES,
            fg_pid is None or pid is None or int(pid) != int(fg_pid),
            float("inf") if age is None else age, node.get("sid") or "", node.get("key") or "")


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


def session_names(agent_session, sid):
    """Whether Herdr's agent_session (a session file path) names exactly session `sid`: the file's basename without
    `.jsonl`, or the id after its last `_` (`<timestamp>_<id>.jsonl`). `s-1` does not match `s-10.jsonl`."""
    if not isinstance(agent_session, str) or not sid:
        return False
    base = re.split(r"[\\/]", agent_session)[-1]
    if base.endswith(".jsonl"):
        base = base[:-6]
    return sid in (base, base.rsplit("_", 1)[-1])


def join(nodes, agents, procinfo=None):
    """Session nodes -> paneId. Presence paneId first (only while that pane is
    in `agents`, i.e. still open), then the node pid as a
    pane's foreground pid (`procinfo` = {paneId: pid}), then a cwd that
    matches exactly one unclaimed pi pane (and one unjoined node). A finished,
    stale or lost session never joins by cwd: its pane is gone, and a new pi pane
    in the same folder would show its tokens. Herdr reuses pane ids, so a finished,
    stale or lost session's presence file may name a pane a live session now
    owns: the live sessions join first (paneId, then pid), the others only take
    a pane no live session claimed. Even then a finished, stale or lost session
    joins a pi pane only when Herdr's `agent_session` names that session: a pi pane
    with another (or no) agent_session may be a live child whose presence has no
    pane id yet, so the pane stays unjoined rather than show a finished row.
    A pane goes to exactly one session, chosen by `_rank` (not by input order);
    the other claimants get no join."""
    procinfo = procinfo or {}
    sessions = [n for n in walk(nodes) if n.get("kind") == "session"]
    joins, claimed = {}, set()
    live = {a.get("pane_id") for a in agents or [] if a.get("pane_id")}
    by_pane = {a.get("pane_id"): a for a in agents or [] if a.get("pane_id")}

    def may_join(n, pane):
        if n.get("state") not in NOT_SELF_STATES:
            return True
        a = by_pane.get(pane) or {}
        if a.get("agent") != "pi":
            return True
        sid = n.get("sid")
        return bool(sid) and session_names(a.get("agent_session"), sid)

    by_pid = {}
    for pane, pid in procinfo.items():
        if pid is not None:
            by_pid.setdefault(int(pid), pane)
    # Each session names at most one pane (its presence paneId while open, else
    # its pid's pane); every pane then goes to its best-ranked claimant only.
    claims = {}
    for n in sessions:
        pane = n.get("paneId")
        if not (pane and pane in live and may_join(n, pane)):
            pane = by_pid.get(int(n["pid"])) if n.get("pid") is not None else None
            if not (pane and may_join(n, pane)):
                continue
        claims.setdefault(pane, []).append(n)
    for pane, claimants in claims.items():
        winner = min(claimants, key=lambda m: _rank(m, procinfo.get(pane)))
        joins[winner["key"]] = pane
        claimed.add(pane)
    pi_panes = [a for a in agents or [] if a.get("agent") == "pi" and a.get("pane_id")]
    rest = [n for n in sessions if n["key"] not in joins and _norm(n.get("cwd"))
            and n.get("state") not in NOT_SELF_STATES]
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


def split_tokens(tokens):
    """`tokens` as dicts of at most MAX_TOKENS keys, in order."""
    items = list(tokens.items())
    return [dict(items[i:i + MAX_TOKENS]) for i in range(0, len(items), MAX_TOKENS)] or [{}]


def clears(prev, now, keep=()):
    """Null patches for panes published before and absent now; for panes in
    `keep` (fresh push stamp: the session owns its keys) only fm_sort."""
    return {pane: ({"fm_sort": None} if pane in keep else {k: None for k in KEYS + STALE_KEYS})
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


def self_panes_for(roots, joins, fresh, shown=None):
    """Panes whose session pushes its own tokens: fresh stamp naming the pane
    the session is joined to, and the session neither lost, stale nor done.
    `shown` ({paneId: tokens} from agent.list) lets the daemon see a pane whose
    stamp is fresh but that carries no session row (no fm_hd): the daemon
    composes that one itself instead of leaving it blank."""
    out = set()
    for n in walk(roots):
        pane = joins.get(n.get("key"))
        sid = n.get("sid")
        if (n.get("kind") == "session" and pane and sid and fresh.get(sid) == pane
                and n.get("state") not in NOT_SELF_STATES):
            if shown is not None and pane in shown and not (shown[pane] or {}).get("fm_hd"):
                continue
            out.add(pane)
    return out


def shown_tokens(agents):
    """{paneId: tokens} of the agents that report a tokens object."""
    return {a["pane_id"]: a.get("tokens") or {} for a in agents or []
            if a.get("pane_id") and isinstance(a.get("tokens"), dict)}


def blanks(agents, now, fresh_panes, done):
    """Null patches for pi panes no session is joined to (and that no session
    pushes for): whatever an earlier session of the folder left there goes. Each
    pane once (`done`: panes blanked already; a joined pane leaves it), and only
    when its tokens (if agent.list reports them) still hold an fm_* key."""
    done.difference_update(now)
    out = {}
    for a in agents or []:
        pane = a.get("pane_id")
        if a.get("agent") != "pi" or not pane or pane in now or pane in fresh_panes or pane in done:
            continue
        tokens = a.get("tokens")
        if isinstance(tokens, dict) and not any(k in tokens for k in KEYS + STALE_KEYS):
            continue
        done.add(pane)
        out[pane] = {k: None for k in KEYS + STALE_KEYS}
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


def _read_fresh(sdir, name, now=None):
    """The JSON object in `name` when the file is at most TREE_FRESH_S old, else {}."""
    path = os.path.join(sdir, name)
    try:
        if (time.time() if now is None else now) - os.path.getmtime(path) > TREE_FRESH_S:
            return {}
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def read_layout(sdir, now=None):
    """{key: {pre, cont}} the daemon wrote last; {} when absent or older than TREE_FRESH_S."""
    return _read_fresh(sdir, "layout.json", now)


def read_tree(sdir, now=None):
    """{key: {P, conn, own}} the daemon wrote last; {} when absent or older than TREE_FRESH_S."""
    return _read_fresh(sdir, "tree.json", now)


def read_winners(sdir, now=None):
    """{paneId: sid} the daemon published last, {} when absent or older than two push TTLs."""
    path = os.path.join(sdir, "winners.json")
    try:
        if (time.time() if now is None else now) - os.path.getmtime(path) >= 2 * STAMP_FRESH_S:
            return {}
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def pane_winners(roots, joins):
    return {pane: n["sid"] for n in walk(roots) for pane in [joins.get(n.get("key"))]
            if n.get("kind") == "session" and pane and n.get("sid")}


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
        self.blanked = set()
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
        self.self_panes = self_panes_for(snapshot.get("roots") or [], joins, fresh,
                                         shown_tokens(agents))
        layout, tree = {}, {}
        write_atomic(os.path.join(self.sdir, "winners.json"),
                     json.dumps(pane_winners(snapshot.get("roots") or [], joins)))
        now = compose(snapshot, self.width(), joins, self.lead(), self.self_panes,
                      layout_out=layout, tree_out=tree)
        write_atomic(os.path.join(self.sdir, "layout.json"), json.dumps(layout, ensure_ascii=False))
        write_atomic(os.path.join(self.sdir, "tree.json"), json.dumps(tree, ensure_ascii=False))
        self.log_joined(snapshot, agents, len(now))
        for pane in list(now):  # a fresh sample file stands in for the real row of its pane
            sample = None if pane in self.self_panes else read_sample(self.sdir, pane)
            if sample:
                now[pane] = dict(sample[0], fm_sort=now[pane].get("fm_sort"))
        patches = dict(now)
        patches.update(clears(self.published, now, set(fresh.values())))
        for pane, tokens in blanks(agents, now, set(fresh.values()), self.blanked).items():
            patches.setdefault(pane, tokens)
        results = {}
        for pane, tokens in patches.items():
            try:
                for chunk in split_tokens(tokens):
                    self._call("pane.report_metadata", {"pane_id": pane, "source": SOURCE,
                                                        "tokens": chunk, "ttl_ms": self.ttl_ms})
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
                for chunk in split_tokens({k: None for k in keys}):
                    call("pane.report_metadata", {"pane_id": pane, "source": SOURCE, "tokens": chunk})
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


def _full_placements(radar, data, now, sym_name, symbols, recent, sdir, width, own=None):
    """({key: {P, conn, own}}, {key: {pre, cont}}) of the whole tree, built here from every presence
    file and the registry when the daemon's files are stale or lack the session. Rows are the
    sessions the daemon's fresh winners.json joined to a pane (by paneId, pid or cwd), so a closed
    session whose presence file still names a pane takes no tree slot; without winners, the
    sessions with a presence paneId. `own` ({key: pane}) is always a row."""
    roots = [r for r in radar.build(data, now) if radar.finish(r, now, 24.0)]
    roots.sort(key=lambda c: (radar.rank(c), c["started"] if c["started"] is not None else float("inf")))
    snap = radar.json_doc(roots, now, sym_name, symbols, recent)
    by_sid = {sid: pane for pane, sid in read_winners(sdir, now).items()}
    joins = dict(own or {})
    for n in walk(snap["roots"]):
        if n.get("kind") != "session" or n["key"] in joins:
            continue
        pane = by_sid.get(n.get("sid")) if by_sid else n.get("paneId")
        if pane:
            joins[n["key"]] = pane
    layout, tree = {}, {}
    compose(snap, width, joins, 0, layout_out=layout, tree_out=tree)
    return tree, layout


def push_compose(radar, args, sdir, now=None):
    """(tokens, header template) of the session `args.session` on pane `args.pane`: the session-owned
    keys, and the fm_hd line with `{spin}` for the glyph while it works (None otherwise);
    (None, None) when radar does not know the session.
    The tree position comes from the daemon's tree.json and layout.json while they are fresh,
    else from a tree built here. Usage totals resume from a per-session byte-offset cache in the
    state dir, so a push reads only the usage lines appended since the last one."""
    now = time.time() if now is None else now
    sample = read_sample(sdir, args.pane, now)
    if sample:
        return sample
    adir = radar.agent_dir(args.agent_dir)
    sym_name = args.symbols or radar.config_symbols(adir)
    cache_file = _cache_path(sdir, args.session)
    try:
        with open(cache_file, encoding="utf-8") as fh:
            cache = radar.UsageCache(json.load(fh))
    except (OSError, ValueError):
        cache = radar.UsageCache()
    data = radar.load(adir, cache, now, None, args.session)
    if not args.dry_run:
        try:
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            write_atomic(cache_file, json.dumps(cache.files))
        except OSError:
            pass
    own = radar.find_sid(radar.build(data, now), args.session)
    if own is None or not radar.finish(own, now, float("inf")):  # a finished session is still ours
        return None, None
    symbols, recent = radar.load_symbols(sym_name), radar.config_recent_runs(adir)
    snap = radar.json_doc([own], now, sym_name, symbols, recent)
    root = snap["roots"][0]
    # row children are the sessions the daemon's fresh winners.json joined to a pane (as in
    # _full_placements), so a closed child whose presence file still names a pane takes no slot
    by_sid = {sid: pane for pane, sid in read_winners(sdir, now).items()}
    joins = {}
    for n in walk([root]):
        if n.get("kind") != "session":
            continue
        pane = by_sid.get(n.get("sid")) if by_sid else n.get("paneId")
        if pane and pane != args.pane:
            joins[n["key"]] = pane
    joins[root["key"]] = args.pane
    width = read_width(args, os.environ, os.path.join(herdr_config_dir(), "config.toml"))
    tree, layout = read_tree(sdir, now), read_layout(sdir, now)
    if root["key"] not in tree or root["key"] not in layout:
        full_tree, full_layout = _full_placements(radar, data, now, sym_name, symbols, recent, sdir, width,
                                                  {root["key"]: args.pane})
        tree = tree if root["key"] in tree else full_tree
        layout = layout if root["key"] in layout else full_layout
    tpl = {}
    out = compose(snap, width, joins, read_lead(args, os.environ), layout=layout, tree=tree, tpl_out=tpl)
    tokens = out.get(args.pane) or {}
    return {k: tokens.get(k) for k in SESSION_KEYS}, tpl.get(args.pane)


def push_tokens(radar, args, sdir, now=None):
    """{paneId: tokens} for the session `args.session` on pane `args.pane`
    (session-owned keys only); {} when radar does not know the session."""
    tokens, _ = push_compose(radar, args, sdir, now)
    return {args.pane: tokens} if tokens is not None else {}


def _unchanged(tokens_file, tokens, now=None):
    """The last report of this session carried exactly these tokens less than REPUSH_S ago."""
    try:
        with open(tokens_file, encoding="utf-8") as fh:
            last = json.load(fh)
        return (last["tokens"] == tokens
                and 0 <= (time.time() if now is None else now) - float(last["at"]) < REPUSH_S)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def cmd_push(args):
    """Best effort: exit 0 and quiet when Herdr is unreachable; 2 on bad usage
    or a missing radar. --dry-run prints the tokens and reports nothing."""
    if not args.session or not SID_RE.match(args.session) or not pane_id_ok(args.pane):
        log("push needs --session <id> and --pane <id>")
        return 2
    sdir = state_dir()
    as_json = getattr(args, "json", False) and not args.clear
    owner = read_winners(sdir).get(args.pane)
    if owner and owner != args.session and not args.dry_run:
        if as_json:
            print("{}")
        return 0  # another session owns this pane; publishing would make the row flip
    stamp = os.path.join(sdir, "push", args.session + ".stamp")
    tokens_file = os.path.join(sdir, "push", args.session + ".tokens")
    if as_json:
        radar = _import_radar()
        if radar is None:
            return 2
        tokens, tpl = push_compose(radar, args, sdir)
        if tokens is None:
            print("{}")
            return 0
        if not args.dry_run:
            try:
                os.remove(tokens_file)  # a later plain push must report, not be short-cut
            except OSError:
                pass
        print(json.dumps({"tokens": tokens, "fm_hd_tpl": tpl, "stamp": os.path.abspath(stamp),
                          "pane": args.pane}, ensure_ascii=False))
        return 0
    if args.clear:
        patch = {args.pane: {k: None for k in SESSION_KEYS + LEGACY_KEYS}}
        if args.dry_run:
            print(json.dumps(patch))
            return 0
        for path in (stamp, tokens_file, _cache_path(sdir, args.session)):
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
        if not args.final and _unchanged(tokens_file, patch[args.pane]):
            write_atomic(stamp, args.pane)  # still ours; no report
            return 0
    report = patch[args.pane]
    if args.final:  # the last row also ends what an older version left on the pane
        report = dict(report, **{k: None for k in LEGACY_KEYS})
    try:
        call("pane.report_metadata", {"pane_id": args.pane, "source": SOURCE,
                                      "tokens": report, "ttl_ms": TTL_MS}, timeout=2.0)
    except (OSError, ValueError, HerdrError):
        return 0
    if args.final:
        try:
            os.remove(stamp)  # the daemon takes the keys over at its next tick; the usage cache stays
            os.remove(tokens_file)
        except OSError:
            pass
    elif not args.clear:
        try:
            os.makedirs(os.path.dirname(stamp), exist_ok=True)
        except OSError:
            return 0
        write_atomic(stamp, args.pane)
        write_atomic(tokens_file, json.dumps({"tokens": patch[args.pane], "at": time.time()}))
    return 0


# ---------------------------------------------------------------- sample

def sample_path(sdir, pane):
    return os.path.join(sdir, "sample", pane + ".json")


def read_sample(sdir, pane, now=None):
    """(session tokens, fm_hd template) of the pane's sample file while it has not expired, else None.
    The pane id is checked before the path is built."""
    if not pane_id_ok(pane):
        return None
    now = time.time() if now is None else now
    try:
        with open(sample_path(sdir, pane), encoding="utf-8") as fh:
            d = json.load(fh)
        if not now < float(d["expires"]) < now + SAMPLE_MAX_S:
            return None
        tokens, tpl = d["tokens"], d.get("fm_hd_tpl")
        got = {k: _cap(tokens[k]) if isinstance(tokens.get(k), str) else None for k in SESSION_KEYS}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return got, tpl if isinstance(tpl, str) else None


SAMPLE_REASONS = ("none", "ask", "review", "agent", "task", "wait", "blocked", "idle", "done")


def _sample_reason(root, reason, aux):
    """`root` (the mixed sample session) changed so that it shows `reason`: the detail lines that carry the
    reason icon (the header shows the spinner only), or a static state."""
    run = lambda role, state="working": {"key": "sample-" + role, "kind": "run", "role": role,  # noqa: E731
                                         "name": role, "state": state, "sym": state, "children": []}
    root.update(children=[], waits=[], tasks=[], asks=[])
    if reason in ("blocked", "idle", "done"):
        root.update(sym=reason, state=reason, glyph=aux[reason])
        if reason == "blocked":
            root["blocked_s"] = 60
    elif reason == "ask":
        root["children"] = [run("builder", "ask")]
    elif reason in ("review", "agent"):
        root["children"] = [run("reviewer" if reason == "review" else "builder")]
    elif reason == "task":
        root["tasks"] = [{"id": "t", "label": "npm test", "pid": 1, "ageSeconds": 180}]
    elif reason == "wait":
        root["waits"] = [{"id": "w", "kind": "timer", "note": "timer", "age_s": 60, "left_s": 240}]


def sample_snapshot(variant, symbols, reason=None):
    """A synthetic radar snapshot of one working session: two live agents, a PR watch and a task, an
    open ask, the pressure suffix and the PR dots of `variant` (`pr`: one dot per state; `mixed`: PRs,
    an external item and three more PRs that overflow)."""
    aux = aux_symbols(symbols)
    dot = lambda n, state, label=None, src="pr": {"n": n, "state": state, "src": src,  # noqa: E731
                                                  "label": label or "#%d" % n}
    if variant == "mixed":
        dots = [dot(17, "fail"), dot(21, "run"), dot(None, "ok", "deploy", "ext"),
                dot(12, "none"), dot(13, "none"), dot(14, "none")]
    else:
        dots = [dot(17, "fail"), dot(21, "run"), dot(19, "ok"), dot(12, "none")]
    agents = [{"key": "sample-r%d" % i, "kind": "run", "role": "builder", "name": "builder", "state": "working",
               "sym": "working", "glyph": aux["working"], "model": "claude-bridge/claude-sonnet-5-5",
               "children": []} for i in (1, 2)]
    root = {"key": "sample", "kind": "session", "sid": "sample", "name": "r53-sidebar", "state": "working",
            "sym": "working", "glyph": aux["working"], "age_s": 12, "blocked_s": None, "children": agents,
            "done_children": 3, "tot": {"in": 300000, "out": 7400, "cost": 3.32, "uncached": 287000},
            "pressure": {"level": "high", "reasons": ["mem"]}, "dots": dots,
            "waits": [{"id": "w", "kind": "pr", "note": "1 pr watch", "age_s": 0, "left_s": 0, "prs": [21]}],
            "tasks": [{"id": "t", "label": "npm test", "pid": 1, "ageSeconds": 180}],
            "asks": [{"n": 1, "topic": "rule scope"}]}
    if reason:
        _sample_reason(root, reason, aux)
    return {"v": 1, "symbols": symbols, "roots": [root]}


def sample_tokens(variant, symbols, width, pane, reason=None):
    """(session tokens, fm_hd template) of the sample, composed like real data."""
    tpl = {}
    out = compose(sample_snapshot(variant, symbols, reason), width, {"sample": pane}, tpl_out=tpl)[pane]
    return {k: out.get(k) for k in SESSION_KEYS}, tpl.get(pane)


def sample_preview(tokens, tpl, symbols):
    """The sample as Herdr draws it: the header, then the detail rows DETAIL_INDENT right; the dot
    cells share one line with Herdr's separator."""
    lines = [(tpl or tokens["fm_hd"] or "").replace("{spin}", aux_symbols(symbols)["spinner"][2])]
    for k in ("fm_a1", "fm_a2", "fm_a3", PR_KEYS, "fm_meta"):
        text = " · ".join(tokens[c] for c in k if tokens[c]) if isinstance(k, tuple) else tokens[k]
        if text:
            lines.append(" " * DETAIL_INDENT + text)
    return [line.replace(BLANK, " ") for line in lines]


def cmd_sample(args):
    """Override one pane's tokens with the sample: write sample/<pane>.json and publish once.
    --dry-run prints the sample per glyph set and writes nothing; --clear removes the file."""
    pane = args.pane or os.environ.get("HERDR_PANE_ID")
    if not pane_id_ok(pane) and not (args.dry_run and not pane):
        log("sample needs a valid pane id (--pane or HERDR_PANE_ID: 1-100 of A-Za-z0-9._:-)")
        return 2
    pane = pane or "pane"
    minutes = SAMPLE_MINUTES if args.minutes is None else args.minutes
    if not 0 < minutes <= SAMPLE_MAX_S / 60:
        log("sample --minutes must be between 0 and %d" % (SAMPLE_MAX_S // 60))
        return 2
    variant = args.variant or "pr"
    width = read_width(args, os.environ, os.path.join(herdr_config_dir(), "config.toml"))
    if args.reason == "all" and not args.dry_run:
        log("sample --reason all needs --dry-run")
        return 2
    if args.dry_run and args.reason == "all":
        for name in [args.symbols] if args.symbols else SYMBOL_SETS:
            frame = aux_symbols(name)["spinner"][2]
            print("== %s, width %d: reason, ticking header (one frame), non-ticking header ==" % (name, width))
            for reason in SAMPLE_REASONS:
                tokens, tpl = sample_tokens(variant, name, width, pane, reason)
                ticking = (tpl or tokens["fm_hd"]).replace("{spin}", frame)
                print(("%-8s %s   %s" % (reason, ticking, tokens["fm_hd"])).replace(BLANK, " "))
        return 0
    reason = args.reason
    if args.dry_run:
        for name in [args.symbols] if args.symbols else SYMBOL_SETS:
            tokens, tpl = sample_tokens(variant, name, width, pane, reason)
            print("== %s, variant %s, width %d ==" % (name, variant, width))
            print("\n".join(sample_preview(tokens, tpl, name)))
        return 0
    sdir = state_dir()
    path = sample_path(sdir, pane)
    if args.clear:
        try:
            os.remove(path)
        except OSError:
            pass
        print("%s sample cleared" % pane)
        return 0
    name = args.symbols
    if not name:
        radar = _import_radar()
        name = radar.config_symbols(radar.agent_dir(args.agent_dir)) if radar else "unicode"
    name = name if name in SYMBOL_SETS else "unicode"
    tokens, tpl = sample_tokens(variant, name, width, pane, reason)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_atomic(path, json.dumps({"tokens": tokens, "fm_hd_tpl": tpl, "expires": time.time() + minutes * 60},
                                  ensure_ascii=False))
    if not os.path.isfile(path):
        log("could not write %s" % path)
        return 1
    try:
        call("pane.report_metadata", {"pane_id": pane, "source": SOURCE, "tokens": tokens,
                                      "ttl_ms": ONCE_TTL_MS}, timeout=2.0)
    except (OSError, ValueError, HerdrError) as exc:
        log("sample written, but Herdr did not take it: %s" % exc)
        return 1
    print("%s ok (%s, variant %s, width %d, %g min)" % (pane, name, variant, width, minutes))
    print("\n".join(sample_preview(tokens, tpl, name)))
    return 0


SNIPPET_SET_LINE = "# Glyph set of this snippet: unicode."


def snippet_for(name, text=None):
    """config-snippet.toml (written for the unicode set) mapped to glyph set `name`: every glyph inside a
    `contains` string becomes the set's glyph in one pass over the distinct unicode glyphs. The ascii set
    loses its `rules` and the cell `fg` (its glyphs would collide with label text) and keeps `dim`."""
    name = name if name in SYMBOL_SETS else "unicode"
    if text is None:
        with open(os.path.join(HERE, "config-snippet.toml"), encoding="utf-8") as fh:
            text = fh.read()
    text = text.replace(SNIPPET_SET_LINE, "# Glyph set of this snippet: %s." % name)
    if name == "unicode":
        return text
    if name == "ascii":
        text = re.sub(r',\s*rules = \[.*?\n\s*\]', "", text, flags=re.S)
        return re.sub(r', fg = "[^"]*"', "", text)
    src, dst = aux_symbols("unicode"), aux_symbols(name)
    glyphs = {}
    for key, glyph in src.items():
        if key != "spinner" and key in dst:
            glyphs.setdefault(glyph, dst[key])
    pattern = re.compile("|".join(re.escape(g) for g in sorted(glyphs, key=len, reverse=True)))

    def contains(m):
        mapped = pattern.sub(lambda g: glyphs[g.group()], m.group(1))
        return 'contains = "%s"' % "".join("\\u%04x" % ord(c) if unicodedata.category(c) == "Co" else c
                                          for c in mapped)

    return re.sub(r'contains = "([^"]*)"', contains, text)


def cmd_configure(args):
    name = args.symbols
    if not name:
        radar = _import_radar()
        name = radar.config_symbols(radar.agent_dir(args.agent_dir)) if radar else "unicode"
    sys.stdout.write(snippet_for(name))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="sidebar.py", description=__doc__.splitlines()[0])
    ap.add_argument("command", choices=("start", "stop", "run", "status", "configure", "push", "sample"))
    ap.add_argument("--width", type=int)
    ap.add_argument("--no-view", action="store_true")
    ap.add_argument("--lead-cells", type=int)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="with run: compose once, report nothing")
    ap.add_argument("--foreman")
    ap.add_argument("--agent-dir")
    ap.add_argument("--session", help="with push: the session id")
    ap.add_argument("--pane", help="with push: the session's Herdr pane id; with sample: the pane (default HERDR_PANE_ID)")
    ap.add_argument("--symbols", choices=SYMBOL_SETS, help="with push, sample or configure: glyph set; default ui.symbols")
    ap.add_argument("--variant", choices=("pr", "mixed"), help="with sample: the dots shown (default pr)")
    ap.add_argument("--reason", choices=SAMPLE_REASONS + ("all",),
                    help="with sample: the state cell to show (default: the mixed sample); all with --dry-run lists them")
    ap.add_argument("--minutes", type=float, help="with sample: how long the override lasts (default %d)" % SAMPLE_MINUTES)
    ap.add_argument("--json", action="store_true",
                    help="with push: print {tokens, fm_hd_tpl, stamp, pane}; report nothing, write no stamp")
    ap.add_argument("--clear", action="store_true", help="with push: clear the session's keys; with sample: end the override")
    ap.add_argument("--final", action="store_true", help="with push: publish the final row, then drop only the stamp")
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    argv = sys.argv[1:] if argv is None else argv
    args = ap.parse_args(argv)
    if args.command == "start":
        return cmd_start([a for a in argv if a != "start"])
    if args.command == "stop":
        return cmd_stop()
    if args.command == "status":
        return cmd_status()
    if args.command == "configure":
        return cmd_configure(args)
    if args.command == "push":
        return cmd_push(args)
    if args.command == "sample":
        return cmd_sample(args)
    foreman = find_foreman(args.foreman, os.environ, plugin_root())
    if not foreman:
        log("foreman not found (set --foreman or PI_FOREMAN_BIN, or put foreman on PATH)")
        return 2
    if args.once or args.dry_run:
        return run_once(args, foreman)
    return run_daemon(args, foreman)


if __name__ == "__main__":
    sys.exit(main())
