import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _isolation  # noqa: E402,F401  (scrub leaked session env)
import sidebar  # noqa: E402

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None

BRAILLE = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"]
SYMS = {
    "unicode": {"working": "⏳", "waiting": "⏸", "asking": "?", "blocked": "✋", "done": "✓", "lost": "✗", "keepalive": "♨",
                "cold": "❄", "downshift": "↓",
                "waiting-owner": "\u270b", "waiting-external": "\u21bb", "idle": "\u23f8",
                "spinner": BRAILLE, "review": "◎", "agent": "◆", "task": "⚙", "wait": "◷", "ask": "?", "recent": "✓",
                "pr-fail": "●", "pr-run": "◉", "pr-ok": "○", "pr-none": "◌", "rule": "─"},
    "emoji": {"working": "⏳", "waiting": "⏸️", "asking": "❓", "blocked": "✋", "done": "✅", "lost": "❌",
              "keepalive": "♨️", "cold": "❄️", "downshift": "⬇️",
              "waiting-owner": "✋", "waiting-external": "🔄", "idle": "⏸️",
              "spinner": BRAILLE, "review": "🔍", "agent": "🤖", "task": "⚙️", "wait": "⏱️", "ask": "❓", "recent": "✅",
              "pr-fail": "●", "pr-run": "◉", "pr-ok": "○", "pr-none": "◌", "rule": "─"},
    "nerd": {"working": "\uf252", "waiting": "\uf04c", "asking": "\uf128", "blocked": "\uf256",
             "done": "\uf00c", "lost": "\uf00d", "keepalive": "\uf06d",
             "cold": "\uf2dc", "downshift": "\uf063",
             "waiting-owner": "\uf256", "waiting-external": "\uf017", "idle": "\uf04c",
             "spinner": BRAILLE, "review": "\uf002", "agent": "\uf544", "task": "\uf013", "wait": "\uf017", "ask": "\uf128",
             "recent": "\uf00c",
             "pr-fail": "\uf111", "pr-run": "\uf192", "pr-ok": "\uf10c", "pr-none": "\uf1db", "rule": "\u2500"},
    "ascii": {"working": "*", "waiting": ".", "asking": "?", "blocked": "#", "done": "+", "lost": "x",
              "keepalive": "^", "cold": "_", "downshift": "v", "waiting-owner": "#", "waiting-external": "@", "idle": ".",
              "spinner": ["|", "/", "-", "\\"], "review": "&", "agent": ">", "task": "=", "wait": "~", "ask": "?", "recent": "+",
              "pr-fail": "x", "pr-run": "*", "pr-ok": "o", "pr-none": ".", "rule": "-"},
}
# The glyphs a sidebar state shows (the keys that are not the footer's, a spinner or an activity mark).
STATE_KEYS = ("working", "waiting", "asking", "blocked", "done", "lost", "waiting-owner", "waiting-external", "idle")


def node(key, kind, name, sym, state, glyphs, pane=None, children=(), role=None, rung=None,
         age=12, blocked=None, tot=(0, 0, 0.0), cwd=None, pid=None, sid=None, ended=None):
    kids = list(children)
    unc = tot[3] if len(tot) > 3 else tot[0]
    return {"key": key, "kind": kind, "name": name, "role": role, "rung": rung, "state": state,
            "sym": sym, "glyph": glyphs[sym], "paneId": pane, "pid": pid, "cwd": cwd,
            "age_s": age, "blocked_s": blocked,
            "own": {"in": 0, "out": 0, "cost": 0.0},
            "tot": {"in": tot[0], "out": tot[1], "cost": tot[2], "uncached": unc},
            "done_children": sum(1 for k in kids if k["state"] == "done"), "children": kids,
            "sid": sid, "ended_s": ended}


def snapshot(symbols="unicode"):
    g = SYMS[symbols]
    run = lambda k, role, sym, state, rung=None: node(k, "run", role, sym, state, g, role=role, rung=rung)
    child = node("s2", "session", "fix-parser-a1b2c3d4", "working", "working", g, pane="w1:p2",
                 children=[run("r4", "reviewer", "asking", "ask")], tot=(1200, 300, 0.12))
    late = node("s3", "session", "docs-pass", "blocked", "blocked", g, pane="w1:p3",
                blocked=1000, age=1000, tot=(50, 20, 0.01))
    root = node("s1", "session", "refactor the very long session label here", "working", "working",
                g, pane="w1:p1", age=360, tot=(341000, 2300, 0.4712), children=[
                    run("r1", "builder", "working", "working", "strong"),
                    run("r2", "builder", "working", "working", "strong"),
                    run("r3", "explorer", "done", "done"),
                    child, late])
    done = node("s4", "session", "old-run", "done", "done", g, pane="w2:p1", age=7200,
                children=[run("r5", "builder", "done", "done")], tot=(10, 5, 0.0))
    return {"v": 1, "now": "2026-10-10T12:00:00Z", "symbols": symbols, "roots": [root, done]}


LEGACY = ("fm_sym", "fm_l1", "fm_l2", "fm_l3", "fm_cost")   # retired in Round 53, nulled on clears


class ComposeTest(unittest.TestCase):
    def test_widths_and_symbol_sets(self):
        for symbols in ("unicode", "nerd"):
            for width in (20, 22, 26, 34, 44):
                with self.subTest(symbols=symbols, width=width):
                    out = sidebar.compose(snapshot(symbols), width)
                    self.assertEqual(set(out), {"w1:p1", "w1:p2", "w1:p3", "w2:p1"})
                    for tokens in out.values():
                        self.assertLessEqual(len(tokens), 16)
                        self.assertEqual(set(tokens), set(sidebar.KEYS))
                        for v in tokens.values():
                            self.assertTrue(v is None or 0 < len(v) <= 80, v)
                    root = out["w1:p1"]
                    self.assertTrue(root["fm_hd"].replace(B, " ").strip().endswith("6m"))
                    self.assertIn("builder", root["fm_a1"])
                    self.assertNotIn("explorer", root["fm_a1"])
                    if width < sidebar.NARROW_COST:
                        self.assertIsNone(root["fm_meta"])
                    else:
                        self.assertIn("$0.47", root["fm_meta"])
                        self.assertTrue(root["fm_meta"].endswith("✓1"))

    def test_row3_steps_down_below_20(self):
        root = sidebar.compose(snapshot(), 18)["w1:p1"]
        self.assertIsNone(root["fm_meta"])
        self.assertIn("$0.47", sidebar.compose(snapshot(), 20)["w1:p1"]["fm_meta"])

    def test_the_five_legacy_tokens_are_retired(self):
        self.assertEqual(sidebar.KEYS, ("fm_hd", "fm_a1", "fm_a2", "fm_a3", "fm_pr1", "fm_pr2", "fm_pr3", "fm_pr4",
                                        "fm_meta", "fm_state", "fm_block_s", "fm_sort"))
        self.assertEqual(sidebar.STALE_KEYS, LEGACY + ("fm_pre",))
        for width in (18, 26, 40):
            for tokens in sidebar.compose(snapshot(), width).values():
                self.assertFalse(set(LEGACY) & set(tokens), tokens)
                self.assertLessEqual(len(tokens), 16)

    def test_tree_sort_and_late_blocked(self):
        out = sidebar.compose(snapshot(), 34)
        self.assertNotIn("fm_pre", out["w1:p1"])
        self.assertTrue(out["w1:p1"]["fm_hd"].startswith(IND + "⏳"))
        self.assertTrue(out["w1:p2"]["fm_hd"].startswith(IND + "├─ ⏳"))   # static glyph of the state
        self.assertTrue(out["w1:p3"]["fm_hd"].startswith(IND + "└─ ✋"))
        self.assertEqual([out[p]["fm_sort"] for p in ("w1:p1", "w1:p2", "w1:p3", "w2:p1")],
                         ["r001", "r001.c001", "r001.c002", "r002"])
        self.assertTrue(out["w1:p2"]["fm_a1"].startswith("│"))
        self.assertTrue(out["w1:p3"]["fm_hd"].endswith("16m!"))     # late blocked: the mark follows the age
        self.assertTrue(out["w2:p1"]["fm_hd"].startswith(IND + "✓"))     # done stays ours
        self.assertEqual(out["w1:p3"]["fm_block_s"], "1000")
        self.assertIsNone(out["w1:p3"]["fm_a1"])
        self.assertIsNone(out["w1:p2"]["fm_block_s"])
        self.assertEqual(out["w2:p1"]["fm_a1"].replace(B, " ").strip(), "done · 1 run")
        self.assertEqual(out["w2:p1"]["fm_state"], "done")
        nerd = sidebar.compose(snapshot("nerd"), 34)
        self.assertTrue(nerd["w1:p3"]["fm_hd"].startswith(IND + "└─ \uf256"))

    def test_pane_collision_keeps_live_youngest(self):
        g = SYMS["unicode"]
        snap = snapshot()
        snap["roots"][0]["children"].append(
            node("old1", "session", "old-a", "done", "done", g, pane="w1:p2", age=5))
        snap["roots"].append(node("old2", "session", "old-b", "done", "done", g, pane="w1:p2", age=9))
        snap["roots"].append(node("s5", "session", "older-live", "working", "working", g,
                                  pane="w1:p2", age=500))
        out = sidebar.compose(snap, 34)
        self.assertIn("fix-parser", out["w1:p2"]["fm_hd"])   # live s2 (age 12) wins
        self.assertEqual([out[p]["fm_sort"] for p in ("w1:p1", "w1:p3", "w2:p1")],
                         ["r001", "r001.c002", "r002"])
        self.assertNotIn("old-a", " ".join(v or "" for v in out["w1:p1"].values()))
        snap["roots"][0]["children"][3]["state"] = "done"  # s2 done -> live s5 wins
        self.assertIn("older-live", sidebar.compose(snap, 34)["w1:p2"]["fm_hd"])

    def test_done_without_children(self):
        g = SYMS["unicode"]
        snap = {"roots": [node("d", "session", "d", "done", "done", g, pane="w1:p1")]}
        self.assertIsNone(sidebar.compose(snap, 34)["w1:p1"]["fm_a1"])   # nothing ran

    def test_only_done_runs_and_base_rung(self):
        g = SYMS["unicode"]
        kids = [node("r1", "run", "explorer", "done", "done", g, role="explorer", rung="model")]
        snap = {"roots": [node("s", "session", "s", "waiting", "idle", g, pane="w1:p1", children=kids)]}
        self.assertIsNone(sidebar.compose(snap, 34)["w1:p1"]["fm_a1"])   # only a done run
        kids = [node("r2", "run", "explorer", "working", "working", g, role="explorer", rung="model")]
        snap = {"roots": [node("s", "session", "s", "working", "working", g, pane="w1:p1", children=kids)]}
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_a1"].replace(B, " ").strip(), g["agent"] + " explorer")

    def test_lines_fit_budget_and_keep_age(self):
        gap, inset = sidebar.GAP, sidebar.INSET
        for lead in (0, 1, 2):
            for width in (24, 26, 28, 34, 40):
                out = sidebar.compose(snapshot(), width, lead=lead)
                for pane, t in out.items():
                    with self.subTest(lead=lead, width=width, pane=pane):
                        self.assertRegex(t["fm_hd"], r" \d+[smhd]!?$")
                        for key in ROW_KEYS:
                            if t[key] is not None:
                                self.assertLessEqual(sidebar.cell_width(t[key]), width - inset - sidebar.SAFETY)
        tight = sidebar.compose(snapshot(), 24)["w1:p2"]["fm_hd"]
        self.assertTrue("…" in tight and tight.endswith("12s"), tight)

    def test_lead_precedence(self):
        class A:
            lead_cells = None
        a = A()
        self.assertEqual(sidebar.read_lead(a, {}), 0)   # default: no lead cells
        self.assertEqual(sidebar.read_lead(a, {"HERDR_SIDEBAR_LEAD": "0"}), 0)
        a.lead_cells = 2
        self.assertEqual(sidebar.read_lead(a, {"HERDR_SIDEBAR_LEAD": "0"}), 2)

    def test_wide_glyph_width(self):
        self.assertEqual(sidebar.cell_width("⏳ ab"), 5)
        self.assertEqual(sidebar.cell_width("\uf252"), 1)


    def test_two_lead_cells_never_overflow_line1(self):
        for width in (18, 19, 20):
            for blocked in (None, 59, 3000, 90000):
                snap = snapshot()
                snap["roots"][0]["blocked_s"] = blocked
                out = sidebar.compose(snap, width, lead=2)
                for pane, t in out.items():
                    with self.subTest(width=width, blocked=blocked, pane=pane):
                        self.assertFalse(set(LEGACY) & set(t))
                        self.assertLessEqual(sidebar.cell_width(t["fm_hd"]), width - sidebar.INSET - sidebar.SAFETY)

    def test_depth2_large_totals_drop_counts_before_cost(self):
        g = SYMS["unicode"]
        snap = snapshot()
        deep = node("s9", "session", "deep", "working", "working", g, pane="w1:p9",
                    tot=(12300000, 4560000, 123.4, 2300000),
                    children=[node("r9", "run", "builder", "done", "done", g, role="builder")])
        snap["roots"][0]["children"][3]["children"].append(deep)
        t = sidebar.compose(snap, 26)["w1:p9"]
        meta = t["fm_meta"].strip(sidebar.BLANK + " │")
        self.assertTrue(meta.startswith("$123 ") and meta.endswith(" ✓1"), meta)   # counts dropped, cost kept
        self.assertNotIn("↑", meta)

    def test_counts_show_uncached_input_or_marked_total(self):
        g = SYMS["unicode"]
        snap = {"roots": [node("s", "session", "s", "working", "working", g, pane="w1:p1",
                               tot=(341000, 3100, 0.5, 38000))]}
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_meta"].strip(B), "↑38k ↓3.1k · $0.50")
        snap["roots"][0]["tot"]["uncached"] = None   # no usage file with the cache split
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_meta"].strip(B), "↑~341k ↓3.1k · $0.50")

    def test_recent_done_run_shown_then_counted(self):
        g = SYMS["unicode"]

        def snap(ended):
            run = node("r1", "run", "builder", "done", "done", g, role="builder", rung="strong", ended=ended)
            return {"recentRunSeconds": 8, "roots": [node("s", "session", "s", "working", "working", g,
                                                         pane="w1:p1", children=[run])]}
        fresh = sidebar.compose(snap(3), 26)["w1:p1"]
        self.assertEqual(fresh["fm_a1"].replace(B, " ").strip(), "✓ builder strong")
        self.assertEqual(fresh["fm_meta"].strip(B), "$0.00")      # not counted while shown
        old = sidebar.compose(snap(9), 26)["w1:p1"]
        self.assertIsNone(old["fm_a1"])
        self.assertTrue(old["fm_meta"].endswith("✓1"))
        self.assertIsNone(sidebar.compose(snap(None), 26)["w1:p1"]["fm_a1"])

    def test_self_pushing_pane_gets_only_sort(self):
        g = SYMS["unicode"]
        tmp = tempfile.mkdtemp()
        try:
            os.mkdir(os.path.join(tmp, "push"))
            stamp = os.path.join(tmp, "push", "sid-1.stamp")
            with open(stamp, "w", encoding="utf-8") as fh:
                fh.write("w1:p1")

            def tick(state="working"):
                snap = {"roots": [node("k1", "session", "a", "working", state, g, pane="w1:p1", sid="sid-1"),
                                  node("k2", "session", "b", "working", "working", g, pane="w1:p2", sid="sid-2")]}
                joins = {"k1": "w1:p1", "k2": "w1:p2"}
                own = sidebar.self_panes_for(snap["roots"], joins, sidebar.fresh_stamps(tmp))
                layout = {}
                return sidebar.compose(snap, 26, joins, self_panes=own, layout_out=layout), layout
            out, layout = tick()
            self.assertEqual(out["w1:p1"], {"fm_sort": "r001"})     # other keys omitted, not None
            self.assertEqual(set(out["w1:p2"]), set(sidebar.KEYS))
            self.assertEqual(layout["k1"], {"pre": "", "cont": ""})
            for state in ("lost", "stale", "done"):
                self.assertEqual(set(tick(state)[0]["w1:p1"]), set(sidebar.KEYS), state)
            old = time.time() - sidebar.STAMP_FRESH_S - 1
            os.utime(stamp, (old, old))
            self.assertEqual(set(tick()[0]["w1:p1"]), set(sidebar.KEYS))   # stale stamp: daemon owns all
        finally:
            shutil.rmtree(tmp)

    def test_lead_default_is_zero(self):
        self.assertEqual(sidebar.DEFAULT_LEAD, 0)


class JoinTest(unittest.TestCase):
    def sessions(self):
        g = SYMS["unicode"]
        return [node("a", "session", "a", "working", "working", g, pane="w1:p9", pid=1, cwd="/x"),
                node("b", "session", "b", "working", "working", g, pid=42, cwd="/y"),
                node("c", "session", "c", "working", "working", g, cwd="/z"),
                node("d", "session", "d", "working", "working", g, cwd="/same"),
                node("e", "session", "e", "working", "working", g, cwd="/q"),
                node("f", "session", "f", "working", "working", g, pane="w1:p7", cwd="/w")]

    def test_precedence(self):
        agents = [{"pane_id": "w1:p9", "agent": "pi", "cwd": "/other"},
                  {"pane_id": "w1:p10", "agent": "pi", "cwd": "/w"},
                  {"pane_id": "w1:p1", "agent": "pi", "cwd": "/x"},
                  {"pane_id": "w1:p2", "agent": "pi", "cwd": "/y"},
                  {"pane_id": "w1:p3", "agent": "pi", "cwd": "/z"},
                  {"pane_id": "w1:p4", "agent": "pi", "cwd": "/same"},
                  {"pane_id": "w1:p5", "agent": "pi", "cwd": "/same"},
                  {"pane_id": "w1:p6", "agent": "claude", "cwd": "/q"}]
        joins = sidebar.join(self.sessions(), agents, {"w1:p2": 7, "w1:p8": 42})
        self.assertEqual(joins["a"], "w1:p9")       # presence paneId wins
        self.assertEqual(joins["b"], "w1:p8")       # pid beats the cwd match on w1:p2
        self.assertEqual(joins["c"], "w1:p3")       # unique cwd among pi panes
        self.assertNotIn("d", joins)                # two pi panes share the cwd
        self.assertNotIn("e", joins)                # only a non-pi pane matches
        self.assertEqual(joins["f"], "w1:p10")      # closed presence pane falls through to cwd


class ChildrenLineTest(unittest.TestCase):
    def kids_session(self, kids, **extra):
        g = SYMS["unicode"]
        sess = dict(node("s", "session", "s", "working", "working", g, pane="w1:p1", children=kids), **extra)
        return {"roots": [sess]}

    def builder(self, key, model, rung=None):
        g = SYMS["unicode"]
        return dict(node(key, "run", "builder", "working", "working", g, role="builder", rung=rung), model=model)

    def test_short_model(self):
        for raw, want in ("claude-bridge/claude-sonnet-5-5", "sonnet-5.5"), ("anthropic/claude-opus-5-5", "opus-5.5"), \
                ("openai/gpt-5.2", "gpt-5.2"), ("claude-sonnet-4-5-20250929", "sonnet-4.5"), ("", None), (None, None):
            self.assertEqual(sidebar.short_model(raw), want, raw)

    def test_model_follows_role_and_replaces_rung(self):
        g = SYMS["unicode"]["agent"]
        a1 = lambda snap, width: sidebar.compose(snap, width)["w1:p1"]["fm_a1"].replace(B, " ").strip()  # noqa: E731
        same = self.kids_session([self.builder("a", "claude-bridge/claude-sonnet-5-5", "strong"),
                                  self.builder("b", "claude-bridge/claude-sonnet-5-5", "strong")])
        self.assertEqual(a1(same, 34), g + " builder sonnet-5.5 ×2")
        mixed = self.kids_session([self.builder("a", "anthropic/claude-opus-5-5", "strong"),
                                   self.builder("b", "claude-bridge/claude-sonnet-5-5", "strong")])
        self.assertEqual(a1(mixed, 80), "%s builder opus-5.5 strong · builder sonnet-5.5 strong" % g)
        narrow = a1(mixed, 50)
        self.assertIn(g + " builder opus-5.5 · builder sonnet-5.5", narrow)
        self.assertNotIn("strong", narrow)
        nomodel = self.kids_session([self.builder("a", None, "strong")])
        self.assertEqual(a1(nomodel, 34), g + " builder strong")

    def test_pending_wait_shows_when_no_child_runs(self):
        wait = {"id": "w1", "kind": "pid", "note": "suites", "age_s": 240, "left_s": 600}
        snap = self.kids_session([], waits=[wait])
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_a3"].replace(B, " ").strip(), "◷ suites 4m")
        snap = self.kids_session([], waits=[wait, dict(wait, id="w2")])
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_a3"].replace(B, " ").strip(), "◷ suites 4m · suites 4m")
        snap = self.kids_session([self.builder("a", None)], waits=[wait])
        self.assertIn("suites", sidebar.compose(snap, 34)["w1:p1"]["fm_a3"])   # a wait is shown beside the agents


class StaleTokensTest(unittest.TestCase):
    """Ledger 12: a new pane must not show the previous session's tokens."""
    def test_finished_presence_never_joins_a_new_pane_by_cwd(self):
        g = SYMS["unicode"]
        for state in ("done", "stale", "lost"):
            old = node("old", "session", "old", "done", state, g, cwd="/proj")
            agents = [{"pane_id": "w1:p7", "agent": "pi", "cwd": "/proj"}]
            self.assertEqual(sidebar.join([old], agents), {}, state)
        live_ = node("cur", "session", "cur", "working", "working", g, cwd="/proj")
        self.assertEqual(sidebar.join([live_], agents), {"cur": "w1:p7"})

    def test_unmatched_pi_pane_is_blanked_once(self):
        agents = [{"pane_id": "w1:p7", "agent": "pi", "tokens": {"fm_l1": "› old", "fm_cost": "$1"}},
                  {"pane_id": "w1:p8", "agent": "pi", "tokens": {}},
                  {"pane_id": "w1:p9", "agent": "claude", "tokens": {"fm_l1": "x"}},
                  {"pane_id": "w1:p3", "agent": "pi", "tokens": {"fm_l1": "mine"}}]
        done = set()
        out = sidebar.blanks(agents, {"w1:p1": {}}, {"w1:p3"}, done)
        self.assertEqual(set(out), {"w1:p7"})
        self.assertEqual(out["w1:p7"], {k: None for k in sidebar.KEYS + sidebar.STALE_KEYS})   # legacy keys too
        self.assertEqual(sidebar.blanks(agents, {"w1:p1": {}}, {"w1:p3"}, done), {})   # once
        sidebar.blanks(agents, {"w1:p7": {}}, set(), done)                          # joined later: forgotten
        self.assertEqual(set(sidebar.blanks(agents, {}, {"w1:p3"}, done)), {"w1:p7"})

    def test_defensive_self_pane_without_session_row_is_composed_by_the_daemon(self):
        g = SYMS["unicode"]
        tmp = tempfile.mkdtemp()
        try:
            os.mkdir(os.path.join(tmp, "push"))
            with open(os.path.join(tmp, "push", "sid-1.stamp"), "w", encoding="utf-8") as fh:
                fh.write("w2:p1")
            roots = [node("k1", "session", "a", "working", "working", g, pane="w2:p1", sid="sid-1")]
            fresh = sidebar.fresh_stamps(tmp)
            joins = {"k1": "w2:p1"}
            self.assertEqual(sidebar.self_panes_for(roots, joins, fresh), {"w2:p1"})
            self.assertEqual(sidebar.self_panes_for(roots, joins, fresh, {"w2:p1": {"fm_hd": "a"}}), {"w2:p1"})
            self.assertEqual(sidebar.self_panes_for(roots, joins, fresh, {"w2:p1": {"fm_l1": "› a"}}), set())
            self.assertEqual(sidebar.self_panes_for(roots, joins, fresh, {"w2:p1": {"fm_sort": "r001"}}), set())
            self.assertEqual(sidebar.shown_tokens([{"pane_id": "w2:p1", "tokens": {"fm_sort": "r001"}}, {"pane_id": "x"}]),
                             {"w2:p1": {"fm_sort": "r001"}})
        finally:
            shutil.rmtree(tmp)


class DecisionTest(unittest.TestCase):
    def test_clears(self):
        prev = {"w1:p1": {}, "w1:p2": {}}
        out = sidebar.clears(prev, {"w1:p1": {}})
        self.assertEqual(list(out), ["w1:p2"])
        self.assertTrue(all(v is None for v in out["w1:p2"].values()))
        self.assertEqual(set(out["w1:p2"]), set(sidebar.KEYS + sidebar.STALE_KEYS))

    def test_clears_keep_self_pushing_keys(self):
        out = sidebar.clears({"w1:p1": {}, "w1:p2": {}}, {}, keep={"w1:p1"})
        self.assertEqual(out["w1:p1"], {"fm_sort": None})
        self.assertEqual(set(out["w1:p2"]), set(sidebar.KEYS + sidebar.STALE_KEYS))

    def test_watchdog_grace_scales_with_last_snapshot(self):
        self.assertEqual(sidebar._watchdog_s({}), (25, 15))
        self.assertEqual(sidebar._watchdog_s({}, 6.0), (25, 15))
        self.assertEqual(sidebar._watchdog_s({}, 12.0), (34, 24))
        self.assertEqual(sidebar._watchdog_s({sidebar.WATCHDOG_ENV: "1.5"}, 12.0), (1.5, 1.5))

    def test_report_failure_logged_on_transition_only(self):
        class A:
            no_view, width, lead_cells = True, 26, None
        tmp = tempfile.mkdtemp()
        try:
            pub = sidebar.Publisher(A(), tmp)
            pub.joins_for = lambda snap: ({"s1": "p1"}, [])
            fail = [True]

            def fake_call(method, params):
                if fail[0]:
                    raise sidebar.HerdrError("down")
                return {}
            pub._call = fake_call
            logged = []
            orig, sidebar.log = sidebar.log, logged.append
            try:
                snap = json.loads(SNAP_LINE)
                for _ in range(3):
                    pub.publish(snap)
                fail[0] = False
                pub.publish(snap)
                pub.publish(snap)
            finally:
                sidebar.log = orig
            reports = [m for m in logged if m.startswith("report ")]
            self.assertEqual(reports, ["report p1 failed: down", "report p1 recovered"])
        finally:
            shutil.rmtree(tmp)

    def test_view_decision(self):
        self.assertEqual(sidebar.view_decision(False, 2), "set")
        self.assertEqual(sidebar.view_decision(True, 0), "clear")
        self.assertIsNone(sidebar.view_decision(True, 1))
        self.assertIsNone(sidebar.view_decision(False, 0))
        self.assertIsNone(sidebar.view_decision(True, 1, 59.0))
        self.assertEqual(sidebar.view_decision(True, 1, 60.0), "set")   # periodic re-set
        self.assertIsNone(sidebar.view_decision(False, 0, 600.0))

    def test_view_retry_throttle(self):
        self.assertTrue(sidebar.view_retry_due(None, 5.0))
        self.assertFalse(sidebar.view_retry_due(100.0, 159.0))
        self.assertTrue(sidebar.view_retry_due(100.0, 160.0))

    def test_width_precedence(self):
        tmp = tempfile.mkdtemp()
        try:
            cfg = os.path.join(tmp, "config.toml")
            with open(cfg, "w", encoding="utf-8") as fh:
                fh.write("[ui]\nsidebar_width = 30\n[ui.sidebar.agents]\nrows = []\n")

            class A:
                width = None
            a = A()
            self.assertEqual(sidebar.read_width(a, {}, os.path.join(tmp, "missing.toml")), 26)
            self.assertEqual(sidebar.read_width(a, {}, cfg), 30)
            self.assertEqual(sidebar.read_width(a, {"HERDR_SIDEBAR_WIDTH": "28"}, cfg), 28)
            a.width = 44
            self.assertEqual(sidebar.read_width(a, {"HERDR_SIDEBAR_WIDTH": "28"}, cfg), 44)
        finally:
            shutil.rmtree(tmp)


class SnippetTest(unittest.TestCase):
    def snippet_rows(self, name):
        cfg = tomllib.loads(sidebar.snippet_for(name))
        return cfg["ui"]["sidebar"]["agents"]["rows_by_agent"]["pi"]

    @unittest.skipIf(tomllib is None, "tomllib needs Python 3.11+")
    def test_snippet_of_every_set_parses_within_limits_and_colours_its_glyphs(self):
        # the file itself is the unicode set
        with open(PLUGIN / "config-snippet.toml", "rb") as fh:
            self.assertEqual(tomllib.load(fh), tomllib.loads(sidebar.snippet_for("unicode")))
        for name, g in SYMS.items():
            with self.subTest(name):
                rows = self.snippet_rows(name)
                self.assertLessEqual(len(rows), 16)
                for row in rows:
                    self.assertLessEqual(len(row), 16)
                    for cell in row:
                        self.assertLessEqual(len(cell.get("rules", [])), 16)
                hd = rows[0][0]
                contains = [r["contains"] for r in hd.get("rules", [])]
                if name == "ascii":
                    self.assertEqual(contains, [])
                    self.assertNotIn("fg", hd)
                    for row in rows:
                        for cell in row:
                            self.assertNotIn("rules", cell)
                            self.assertNotIn("fg", cell)
                    self.assertTrue(all(c.get("dim") for row in rows[1:4] + rows[5:] for c in row))
                    continue
                self.assertEqual(hd["fg"], "#5cb85c")
                self.assertEqual(len(contains), 10)
                self.assertEqual(hd["rules"][0], {"contains": "!", "fg": "#d9534f", "bold": True})
                # a rule for every state and reason glyph that needs a colour
                wanted = {g[k] for k in ("blocked", "asking", "review", "agent", "task", "wait", "lost", "done", "idle")}
                self.assertEqual(set(contains[1:]), wanted)
                for frame in g["spinner"]:
                    self.assertFalse(any(c in frame for c in contains), frame)
                for cell in rows[4]:
                    self.assertEqual([r["contains"] for r in cell["rules"]], [g[k] for k in ("pr-fail", "pr-run", "pr-ok")])
                self.assertEqual([r["contains"] for r in rows[1][0]["rules"]], [g["agent"]])
                self.assertEqual([r["contains"] for r in rows[3][0]["rules"]], [g["ask"] + " ask "])
        emoji_hd = [r["contains"] for r in self.snippet_rows("emoji")[0][0]["rules"]]
        self.assertEqual(emoji_hd.count("\u23f8\ufe0f"), 1)
        self.assertNotIn("\u23f8", [c for c in emoji_hd if c != "\u23f8\ufe0f"])

    def test_configure_prints_the_set_and_defaults_to_the_configured_one(self):
        def configure(*extra):
            res = subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "configure"] + list(extra),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            self.assertEqual(res.returncode, 0, res.stderr)
            return res.stdout.decode("utf-8")
        out = configure("--symbols", "nerd")
        self.assertEqual(out, sidebar.snippet_for("nerd"))
        self.assertIn("# Glyph set of this snippet: nerd.", out)
        self.assertIn('contains = "\\uf002"', out)
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        with open(os.path.join(tmp, "foreman.json"), "w", encoding="utf-8") as fh:
            json.dump({"ui": {"symbols": "emoji"}}, fh)
        out = configure("--agent-dir", tmp)
        self.assertEqual(out, sidebar.snippet_for("emoji"))
        self.assertNotEqual(out, sidebar.snippet_for("unicode"))

    @unittest.skipIf(tomllib is None, "tomllib needs Python 3.11+")
    def test_snippet_header_files_and_manifest(self):
        with open(PLUGIN / "config-snippet.toml", "rb") as fh:
            cfg = tomllib.load(fh)
        rows = cfg["ui"]["sidebar"]["agents"]["rows_by_agent"]["pi"]
        sym_file = ROOT / "config" / "symbols.json"
        if sym_file.is_file():
            with open(sym_file, encoding="utf-8") as fh:
                shared = json.load(fh)
            self.assertEqual(shared, SYMS)
        self.assertNotIn("$fm_pre", json.dumps(rows))
        self.assertEqual([[c["token"] for c in row] for row in rows],
                         [["$" + k] for k in ("fm_hd", "fm_a1", "fm_a2", "fm_a3")]
                         + [["$fm_pr1", "$fm_pr2", "$fm_pr3", "$fm_pr4"]] + [["$fm_meta"]])
        for old in ("$fm_sym", "$fm_l1", "$fm_l2", "$fm_l3", "$fm_cost", "state_icon"):
            self.assertNotIn(old, json.dumps(rows))
        for row in rows[1:4] + rows[5:]:
            self.assertEqual(len(row), 1)
            self.assertTrue(row[0]["dim"] and "fg" not in row[0])   # detail rows follow the theme (rules may colour)
        self.assertEqual(len(rows[4]), 4)
        for cell in rows[4]:
            self.assertNotIn("dim", cell)                           # the pr cells are not dim
            self.assertNotIn("fg", cell)
            self.assertEqual(len({r["fg"] for r in cell["rules"]}), 3)
        self.assertEqual([r["contains"] for r in rows[5][0]["rules"]], ["⚠"])
        self.assertNotIn("rules", rows[2][0])
        with open(PLUGIN / "herdr-plugin.toml", "rb") as fh:
            manifest = tomllib.load(fh)
        self.assertEqual(manifest["id"], "pi-foreman.sidebar")
        self.assertEqual({a["id"] for a in manifest["actions"]}, {"start", "stop", "configure"})


class StateDirTest(unittest.TestCase):
    def test_three_branches(self):
        tmp = tempfile.mkdtemp()
        try:
            home, xdg, tdir = (os.path.join(tmp, n) for n in ("home", "xdg", "tmp"))
            explicit = os.path.join(tmp, "explicit")
            self.assertEqual(sidebar.state_dir({"HERDR_PLUGIN_STATE_DIR": explicit}, home, tdir),
                             explicit)
            # no herdr/plugins folder yet: temp dir
            self.assertEqual(sidebar.state_dir({"XDG_STATE_HOME": xdg}, home, tdir),
                             os.path.join(tdir, "pi-foreman.sidebar"))
            os.makedirs(os.path.join(xdg, "herdr", "plugins"))
            self.assertEqual(sidebar.state_dir({"XDG_STATE_HOME": xdg}, home, tdir),
                             os.path.join(xdg, "herdr", "plugins", "pi-foreman.sidebar"))
            os.makedirs(os.path.join(home, ".local", "state", "herdr", "plugins"))
            self.assertEqual(sidebar.state_dir({}, home, tdir),
                             os.path.join(home, ".local", "state", "herdr", "plugins",
                                          "pi-foreman.sidebar"))
            for d in (explicit, os.path.join(tdir, "pi-foreman.sidebar")):
                self.assertTrue(os.path.isdir(d))
        finally:
            shutil.rmtree(tmp)


class FakeHerdr:
    """AF_UNIX server answering like Herdr; records (method, params)."""

    def __init__(self, path):
        self.calls = []
        self.lock = threading.Lock()
        self.srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.srv.bind(path)
        self.srv.listen(16)
        self.srv.settimeout(0.2)
        self.stop = threading.Event()
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.srv.accept()
            except OSError:
                continue
            threading.Thread(target=self.handle, args=(conn,), daemon=True).start()

    def handle(self, conn):
        with conn:
            fh = conn.makefile("rb")
            line = fh.readline()
            if not line:
                return
            req = json.loads(line)
            with self.lock:
                self.calls.append((req["method"], req.get("params") or {}))
            result = {}
            if req["method"] == "agent.list":
                result = {"agents": [{"pane_id": "p1", "agent": "pi", "cwd": "/x"}]}
            conn.sendall((json.dumps({"id": req["id"], "result": result}) + "\n").encode())
            if req["method"] == "events.subscribe":
                fh.read()  # hold until the daemon goes away

    def reports(self):
        with self.lock:
            return [p for m, p in self.calls if m == "pane.report_metadata"]

    def close(self):
        self.stop.set()
        self.srv.close()


SNAP_LINE = json.dumps({"v": 1, "roots": [node("s1", "session", "demo", "working", "working",
                                                 SYMS["unicode"], pane="p1", cwd="/x")]})


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "POSIX daemon with AF_UNIX")
class DaemonLoopTest(unittest.TestCase):
    def setUp(self):
        # AF_UNIX paths are short (about 104 bytes on macOS): prefer /tmp
        self.tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        self.herdr = FakeHerdr(os.path.join(self.tmp, "h.sock"))
        self.proc = None

    def tearDown(self):
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.herdr.close()
        shutil.rmtree(self.tmp)

    def daemon(self, body):
        script = os.path.join(self.tmp, "fake_radar.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write("import sys, time\n" + body)
        foreman = os.path.join(self.tmp, "foreman")
        with open(foreman, "w", encoding="utf-8") as fh:
            fh.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, script))
        os.chmod(foreman, os.stat(foreman).st_mode | stat.S_IEXEC)
        env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(self.tmp, "h.sock"),
                   HERDR_PLUGIN_STATE_DIR=os.path.join(self.tmp, "state"),
                   PI_FOREMAN_SIDEBAR_WATCHDOG_S="1.5")
        self.log = os.path.join(self.tmp, "daemon.log")
        with open(self.log, "wb") as logf:
            self.proc = subprocess.Popen([sys.executable, str(PLUGIN / "sidebar.py"), "run", "--no-view",
                                          "--foreman", foreman], env=env, cwd=self.tmp,
                                         stdin=subprocess.DEVNULL, stdout=logf, stderr=logf)

    def wait_for(self, cond, limit):
        end = time.monotonic() + limit
        while time.monotonic() < end:
            if cond():
                return True
            time.sleep(0.1)
        return False

    def read_log(self):
        with open(self.log, encoding="utf-8", errors="replace") as fh:
            return fh.read()

    def test_publishes_within_bound(self):
        self.daemon("while True:\n    print(%r, flush=True)\n    time.sleep(0.5)\n" % SNAP_LINE)
        self.assertTrue(self.wait_for(lambda: any(r["pane_id"] == "p1" and r["tokens"].get("fm_hd")
                                                  for r in self.herdr.reports()), 5), self.read_log())
        self.proc.send_signal(signal.SIGTERM)
        self.proc.wait(timeout=10)
        last = self.herdr.reports()[-1]["tokens"]
        self.assertTrue(all(v is None for v in last.values()))   # shutdown clears
        self.assertIn("fm_pre", last)                              # and the stale key
        log = self.read_log()
        self.assertIn("first radar line", log)
        self.assertEqual(log.count("joined 1 of 1 sessions (1 agents listed)"), 1, log)

    def test_once_reports_and_dry_run_composes(self):
        foreman = os.path.join(self.tmp, "foreman")
        with open(foreman, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\nprintf '%%s\\n' '%s'\n" % SNAP_LINE)
        os.chmod(foreman, 0o755)
        env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(self.tmp, "h.sock"),
                   HERDR_PLUGIN_STATE_DIR=os.path.join(self.tmp, "state"))
        cmd = [sys.executable, str(PLUGIN / "sidebar.py"), "run", "--foreman", foreman]
        res = subprocess.run(cmd + ["--once"], env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(res.returncode, 0, res.stderr)
        lines = res.stdout.decode("utf-8").splitlines()
        self.assertEqual(lines[0], "p1 ok")
        self.assertIn("fm_hd", json.loads(lines[1])["p1"])
        self.assertEqual([r["ttl_ms"] for r in self.herdr.reports()], [60000])
        env["HERDR_SOCKET_PATH"] = os.path.join(self.tmp, "missing.sock")
        res = subprocess.run(cmd + ["--dry-run"], env=env, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, timeout=30)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("p1", json.loads(res.stdout.decode("utf-8")))   # presence paneId fallback
        self.assertEqual(len(self.herdr.reports()), 1)                  # nothing reported

    def test_silent_radar_restarted_by_watchdog(self):
        self.daemon("time.sleep(60)\n")
        self.assertTrue(self.wait_for(lambda: "foreman radar stalled" in self.read_log(), 6),
                        self.read_log())
        self.assertIn("watchdog: no radar line", self.read_log())


def write_agent_dir(root):
    """One live session `sid-1` (pane p1) with a done run that ended 2 s ago."""
    import datetime
    iso = lambda ago: (datetime.datetime.now(datetime.timezone.utc)  # noqa: E731
                       - datetime.timedelta(seconds=ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    adir = os.path.join(root, "agent")
    live = os.path.join(adir, "pi-foreman", "state", "live")
    os.makedirs(live)
    d = {"v": 1, "sessionId": "sid-1", "intercomId": "fm-1", "label": "demo", "cwd": "/x", "pid": 1,
         "paneId": "p1", "startedAt": iso(60), "heartbeatAt": iso(1), "lastEventAt": iso(1),
         "state": "working", "runs": [{"launchId": "L1", "role": "builder", "rung": None, "state": "done",
                                       "tokensIn": 0, "tokensOut": 0, "cost": 0, "endedAt": iso(2)}]}
    with open(os.path.join(live, "sid-1.json"), "w", encoding="utf-8") as fh:
        json.dump(d, fh)
    return adir


class PushComposeTest(unittest.TestCase):
    def test_push_tokens_use_layout_prefix(self):
        tmp = tempfile.mkdtemp()
        try:
            adir = write_agent_dir(tmp)
            sdir = os.path.join(tmp, "state")
            os.makedirs(sdir)
            radar = sidebar._import_radar()
            args = type("A", (), {"session": "sid-1", "pane": "p1", "symbols": None, "agent_dir": adir,
                                  "width": 26, "lead_cells": None, "dry_run": True})()
            root = sidebar.push_tokens(radar, args, sdir)["p1"]
            self.assertEqual(set(root), set(sidebar.SESSION_KEYS))   # never fm_sort
            self.assertTrue(root["fm_hd"].startswith(IND + "⏳" + " demo"), root["fm_hd"])   # no tree.json: root row
            self.assertEqual(root["fm_a1"].replace(B, " ").strip(), "✓ builder")   # recent run (8 s default)
            for name, doc in (("layout.json", {"fm-1": {"pre": "", "cont": ""}}),
                              ("tree.json", {"fm-1": {"P": "", "conn": sidebar.CONN_LAST, "own": sidebar.CONT_LAST}})):
                with open(os.path.join(sdir, name), "w", encoding="utf-8") as fh:
                    json.dump(doc, fh)
            nested = sidebar.push_tokens(radar, args, sdir)["p1"]
            self.assertTrue(nested["fm_hd"].startswith(IND + sidebar.CONN_LAST + "⏳"), nested["fm_hd"])
            self.assertTrue(nested["fm_a1"].startswith(sidebar.CONT_LAST), nested["fm_a1"])
            args.session = "nope"
            self.assertEqual(sidebar.push_tokens(radar, args, sdir), {})
        finally:
            shutil.rmtree(tmp)


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "POSIX AF_UNIX socket")
class PushTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        self.herdr = FakeHerdr(os.path.join(self.tmp, "h.sock"))
        self.adir = write_agent_dir(self.tmp)
        self.stamp = os.path.join(self.tmp, "state", "push", "sid-1.stamp")

    def tearDown(self):
        self.herdr.close()
        shutil.rmtree(self.tmp)

    def push(self, *extra, sock="h.sock"):
        env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(self.tmp, sock),
                   HERDR_PLUGIN_STATE_DIR=os.path.join(self.tmp, "state"), HERDR_SIDEBAR_WIDTH="26")
        return subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "push", "--session", "sid-1",
                               "--pane", "p1", "--agent-dir", self.adir] + list(extra),
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def test_push_publishes_and_stamps_then_clear(self):
        res = self.push()
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, b"", b""))
        (rep,) = self.herdr.reports()
        self.assertEqual((rep["pane_id"], rep["source"], rep["ttl_ms"]), ("p1", sidebar.SOURCE, 15000))
        self.assertEqual(set(rep["tokens"]), set(sidebar.SESSION_KEYS))
        self.assertIn(" demo", rep["tokens"]["fm_hd"])
        with open(self.stamp, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "p1")
        res = self.push("--clear")
        self.assertEqual((res.returncode, res.stdout), (0, b""))
        last = self.herdr.reports()[-1]["tokens"]
        self.assertEqual(last, {k: None for k in sidebar.SESSION_KEYS + sidebar.LEGACY_KEYS})   # and the old tokens
        self.assertFalse(os.path.exists(self.stamp))

    def test_static_glyph_pushed_once_per_state_change(self):
        live = os.path.join(self.adir, "pi-foreman", "state", "live", "sid-1.json")

        def set_state(state):
            with open(live, encoding="utf-8") as fh:
                d = json.load(fh)
            d["state"] = state
            with open(live, "w", encoding="utf-8") as fh:
                json.dump(d, fh)

        # Row 1 carries a wall-clock age ("1s"), so a push that straddles a second boundary (a loaded
        # machine) legitimately re-reports with the same glyph. What must hold regardless of timing:
        # no report repeats the previous tokens, and the glyph changes only with the state.
        def glyphs():
            seq = [r["tokens"]["fm_hd"].lstrip(B)[0] for r in self.herdr.reports()]
            return [g for i, g in enumerate(seq) if i == 0 or g != seq[i - 1]]

        for _ in range(3):
            self.assertEqual(self.push().returncode, 0)
        self.assertEqual(glyphs(), ["⏳"])
        set_state("done")
        self.push()
        self.assertEqual(glyphs(), ["⏳", "✓"])
        self.push()
        self.assertEqual(glyphs(), ["⏳", "✓"])
        toks = [r["tokens"] for r in self.herdr.reports()]
        self.assertTrue(all(a != b for a, b in zip(toks, toks[1:])), toks)
        with open(self.stamp, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "p1")

    def test_final_publishes_row_and_drops_only_the_stamp(self):
        self.push()
        res = self.push("--final")
        self.assertEqual((res.returncode, res.stdout), (0, b""))
        last = self.herdr.reports()[-1]["tokens"]
        self.assertIn(" demo", last["fm_hd"])
        self.assertEqual({k: last[k] for k in sidebar.LEGACY_KEYS}, dict.fromkeys(sidebar.LEGACY_KEYS))   # nulled once
        self.assertFalse(os.path.exists(self.stamp))

    def test_unreachable_herdr_is_quiet_and_dry_run_prints(self):
        res = self.push(sock="missing.sock")
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, b"", b""))
        self.assertFalse(os.path.exists(self.stamp))
        res = self.push("--dry-run", sock="missing.sock")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("fm_hd", json.loads(res.stdout.decode("utf-8"))["p1"])
        self.assertEqual(self.herdr.reports(), [])


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "POSIX AF_UNIX socket")
class PushFinalFinishedRootTest(unittest.TestCase):
    """Round 33 root cause 6: `push --final` must publish the row of a finished root and drop its stamp."""

    def iso(self, ago):
        import datetime
        return (datetime.datetime.now(datetime.timezone.utc)
                - datetime.timedelta(seconds=ago)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def final_push(self, patch):
        tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        herdr = FakeHerdr(os.path.join(tmp, "h.sock"))
        try:
            adir = write_agent_dir(tmp)
            live = os.path.join(adir, "pi-foreman", "state", "live", "sid-1.json")
            with open(live, encoding="utf-8") as fh:
                d = json.load(fh)
            d.update(patch)
            with open(live, "w", encoding="utf-8") as fh:
                json.dump(d, fh)
            stamp = os.path.join(tmp, "state", "push", "sid-1.stamp")
            os.makedirs(os.path.dirname(stamp))
            with open(stamp, "w", encoding="utf-8") as fh:
                fh.write("p1")
            env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(tmp, "h.sock"),
                       HERDR_PLUGIN_STATE_DIR=os.path.join(tmp, "state"), HERDR_SIDEBAR_WIDTH="26")
            res = subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "push", "--session", "sid-1",
                                  "--pane", "p1", "--agent-dir", adir, "--final"],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            return res, herdr.reports(), os.path.exists(stamp)
        finally:
            herdr.close()
            shutil.rmtree(tmp)

    def test_final_publishes_done_and_lost_roots(self):
        cases = {"done": {"state": "done"},
                 "done, silent for 5 minutes": {"state": "done", "heartbeatAt": self.iso(300),
                                                "lastEventAt": self.iso(300)},
                 "lost": {"heartbeatAt": self.iso(300), "lastEventAt": self.iso(300)},
                 "done over 24 h ago": {"state": "done", "heartbeatAt": self.iso(90000),
                                        "lastEventAt": self.iso(90000)}}
        for name, patch in cases.items():
            with self.subTest(name):
                res, reports, stamp_left = self.final_push(patch)
                self.assertEqual((res.returncode, res.stderr), (0, b""))
                self.assertEqual(len(reports), 1)
                self.assertEqual(reports[0]["pane_id"], "p1")
                self.assertIn(" demo", reports[0]["tokens"]["fm_hd"])
                self.assertFalse(stamp_left)


class DaemonTest(unittest.TestCase):
    def test_foreman_not_found_exits_2(self):
        tmp = tempfile.mkdtemp()
        try:
            dest = os.path.join(tmp, "plugin")
            os.mkdir(dest)
            shutil.copy(str(PLUGIN / "sidebar.py"), dest)
            env = {k: v for k, v in os.environ.items()
                   if k not in ("PI_FOREMAN_BIN", "HERDR_PLUGIN_ROOT")}
            env["PATH"] = ""
            env["HERDR_PLUGIN_STATE_DIR"] = os.path.join(tmp, "state")
            res = subprocess.run([sys.executable, os.path.join(dest, "sidebar.py"), "run", "--no-view"],
                                 cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 timeout=60)
            self.assertEqual(res.returncode, 2, res.stderr)
            self.assertIn(b"foreman not found", res.stderr)
        finally:
            shutil.rmtree(tmp)


@unittest.skipUnless(shutil.which("herdr") and os.environ.get("HERDR_ENV") == "1"
                     and os.environ.get("PI_FOREMAN_LIVE_SMOKE") == "1",
                     "live Herdr smoke: needs herdr, HERDR_ENV=1 and PI_FOREMAN_LIVE_SMOKE=1")
class LiveSmokeTest(unittest.TestCase):
    def test_once(self):
        res = subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "run", "--once", "--no-view",
                              "--foreman", str(ROOT / "bin" / "foreman")],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        self.assertEqual(res.returncode, 0, res.stderr)


# ---------------------------------------------------------------- Round 33: tree rows

B = sidebar.BLANK
IND = B * sidebar.DETAIL_INDENT   # a header's leading blank cells
ROW_KEYS = ("fm_hd", "fm_a1", "fm_a2", "fm_a3", "fm_meta")


def tnode(key, name, glyph, sym="working", state=None, age=12, children=(), symbols="unicode",
          tot=(0, 0, 0.0), blocked=None, **extra):
    """A session node whose glyph is shown as given (a spinner frame, say); pane "P-<key>"."""
    n = node(key, "session", name, sym, state or sym, SYMS[symbols], pane="P-" + key, children=children,
             age=age, sid=key, tot=tot, blocked=blocked)
    n["glyph"] = glyph
    n.update(extra)
    return n


def trun(key, role, model=None, state="working", sym="working", **extra):
    n = node(key, "run", role, sym, state, SYMS["unicode"], role=role)
    n["model"] = model
    n.update(extra)
    return n


def rendered(snap, width):
    """The Agents panel as lines: each pane's row tokens in order, blank cells shown as spaces.
    Herdr draws every row but the first of an entry DETAIL_INDENT cells right; so do these lines."""
    out = sidebar.compose(snap, width)
    lines = []
    for pane in sorted(out, key=lambda p: out[p]["fm_sort"]):
        lines += [(" " * sidebar.DETAIL_INDENT * (k != "fm_hd")) + out[pane][k].replace(B, " ")
                  for k in ROW_KEYS if out[pane][k] is not None]
    return lines


SONNET, OPUS = "claude-bridge/claude-sonnet-5-5", "anthropic/claude-opus-5-5"


def mock_snapshot(reverse=False):
    """The plan's mock-up: a root with three row children, one of which has a child of its own."""
    perms = tnode("perms", "r31-perms", "✋", "blocked", age=60, blocked=60, asks=["rule scope"],
                  tot=(0, 0, 0.12), started=4.0)
    sidebar_ = tnode("sidebar", "r31-sidebar", "⠼", age=360, started=1.0, tot=(0, 0, 0.47),
                     children=[trun("r6", "reviewer", OPUS), perms], done_children=1)
    cache = tnode("cache", "r32-cache", "⏸", "waiting", age=120, started=2.0, tot=(0, 0, 1.02), done_children=2,
                  waits=[{"id": "w", "kind": "child", "note": "child r32b", "age_s": 240, "left_s": 0}])
    git = tnode("git", "r31-git", "✓", "done", age=2400, started=3.0, tot=(0, 0, 0.88), done_children=4)
    kids = [trun("r1", "builder", SONNET), trun("r2", "builder", SONNET), trun("r3", "reviewer", OPUS),
            sidebar_, cache, git]
    if reverse:
        kids[3:] = kids[:2:-1]   # the session siblings; the runs keep their order
    root = tnode("root", "pi-foreman", "⠹", age=12, children=kids, tot=(287000, 7400, 3.32), done_children=3,
                 waits=[{"id": "pr_watch", "kind": "pr", "note": "1 pr watch", "age_s": 0, "left_s": 0, "prs": [12]}],
                 tasks=[{"id": "t1", "label": "npm test", "pid": 7, "ageSeconds": 180}])
    return {"v": 1, "symbols": "unicode", "roots": [root]}


MOCK_40 = """\
  ⠹◎ pi-foreman                   12s
  │  ◆ builder sonnet-5.5 ×2 · revie…
  │  ⚙ pr #12 · npm test 3m
  │  ↑287k ↓7.4k · $3.32 · ✓3
  ├─ ⠼◎ r31-sidebar                6m
  │  │  ◆ reviewer opus-5.5
  │  │  $0.47 · ✓1
  │  └─ ✋ r31-perms               1m
  │        ? ask 1: rule scope
  │        $0.12
  ├─ ⏸  r32-cache                  2m
  │     ◷ child r32b 4m
  │     $1.02 · ✓2
  └─ ✓  r31-git                   40m
        $0.88 · ✓4
""".splitlines()

MOCK_26 = """\
  ⠹◎ pi-foreman     12s
  │  ◆ builder sonnet-…
  │  ⚙ pr #12 · npm te…
  │  $3.32 · ✓3
  ├─ ⠼◎ r31-sidebar  6m
  │  │  ◆ reviewer opu…
  │  │  $0.47 · ✓1
  │  └─ ✋ r31-perms 1m
  │        ? ask 1: ru…
  │        $0.12
  ├─ ⏸  r32-cache    2m
  │     ◷ child r32b 4m
  │     $1.02 · ✓2
  └─ ✓  r31-git     40m
        $0.88 · ✓4
""".splitlines()


class TreeSnapshotTest(unittest.TestCase):
    def test_mock_ups_are_exact(self):
        self.assertEqual(rendered(mock_snapshot(), 40), MOCK_40)
        self.assertEqual(rendered(mock_snapshot(), 26), MOCK_26)

    def test_input_order_of_siblings_does_not_matter(self):
        for width in (18, 26, 40, 60):
            self.assertEqual(rendered(mock_snapshot(reverse=True), width), rendered(mock_snapshot(), width), width)

    def test_unknown_start_sorts_last_then_by_session_id(self):
        a, b, c = (tnode(k, k, "⠼", sid=k, started=s) for k, s in (("c", None), ("b", 5.0), ("a", None)))
        root = tnode("root", "root", "⠼", children=[c, a, b])
        out = sidebar.compose({"roots": [root]}, 40)
        self.assertEqual([out[p]["fm_sort"] for p in ("P-b", "P-a", "P-c")], ["r001.c001", "r001.c002", "r001.c003"])

    def test_every_set_width_and_depth_fits_and_keeps_the_label_column(self):
        for symbols in SYMS:
            g = SYMS[symbols]
            for depth in range(4):
                chain = None
                for d in range(depth, -1, -1):
                    kids = [chain] if chain else []
                    kids.append(tnode("x%d" % d, "sibling%d" % d, g["done"], "done", symbols=symbols))
                    chain = tnode("n%d" % d, "level-%d-session" % d, g["working"], symbols=symbols,
                                  children=kids, tot=(1500, 90, 0.25))
                snap = {"symbols": symbols, "roots": [chain]}
                for width in (18, 26, 40, 60):
                    with self.subTest(symbols=symbols, depth=depth, width=width):
                        out = sidebar.compose(snap, width)
                        self.assertEqual(len(out), 2 * depth + 2)
                        for tokens in out.values():
                            for k in ROW_KEYS:
                                if tokens[k] is not None:
                                    self.assertLessEqual(sidebar.cell_width(tokens[k]), width - 3, tokens[k])
                        root_hd = out["P-n0"]["fm_hd"]
                        self.assertTrue(root_hd.startswith(IND + g["working"]))

    def test_late_blocked_mark_follows_the_age(self):
        n = tnode("s", "slow", "✋", "blocked", age=1000, blocked=1000)
        self.assertTrue(sidebar.compose({"roots": [n]}, 40)["P-s"]["fm_hd"].endswith("16m!"))
        n["blocked_s"] = 60
        self.assertTrue(sidebar.compose({"roots": [n]}, 40)["P-s"]["fm_hd"].endswith(" 1m"))

    def test_label_is_cut_before_the_age_is_dropped_and_the_overflow_suffix_is_kept(self):
        n = tnode("s", "a-very-long-session-label", "⠼", age=125)
        n["tasks"] = [{"label": "task%d" % i, "ageSeconds": 60, "id": str(i)} for i in range(5)]
        out = sidebar.compose({"roots": [n]}, 30)["P-s"]
        self.assertEqual(out["fm_hd"].replace(B, " "), "  ⠼⚙ a-very-long-sessio… 2m")   # budget 27; a task shows its icon in the slot
        self.assertTrue(out["fm_a2"].endswith("… +2"), out["fm_a2"])
        self.assertEqual(sidebar.cell_width(out["fm_a2"]), 25)   # budget 27 less Herdr's row indent
        # nested two deep at width 18: under four cells of label next to the age, so the age goes
        leaf = tnode("c", "a-very-long-session-label", "⠼", age=125)
        mid = tnode("b", "mid", "⠼", children=[leaf])
        top = tnode("a", "top", "⠼", children=[mid])
        out = sidebar.compose({"roots": [top]}, 18)["P-c"]
        self.assertEqual(out["fm_hd"].replace(B, " "), "     └─ ⠼  a-v…")

    def test_deep_prefix_is_cut_at_a_unit_boundary_never_inside_a_connector(self):
        n = None
        for d in range(8, -1, -1):
            n = tnode("n%d" % d, "l%d" % d, "⠼", children=[n, tnode("z%d" % d, "z", "✓", "done")] if n else [])
        out = sidebar.compose({"roots": [n]}, 18)
        for tokens in out.values():
            for k in ROW_KEYS:
                v = tokens[k]
                if v is not None:
                    self.assertLessEqual(sidebar.cell_width(v), 15)
                    self.assertNotIn("…", v[:len(v) - len(v.lstrip("│├└─ " + B))])
        deepest = out["P-n8"]["fm_hd"]
        self.assertEqual(deepest[:len(IND)], IND)
        deepest = deepest[len(IND):]
        self.assertEqual(len(deepest) % 3, 0)
        self.assertTrue(deepest.endswith("└─ ") or deepest.endswith("├─ ") or set(deepest) <= set("│├└─ " + B))

    def test_legacy_tokens_are_gone_and_the_tree_places_the_header(self):
        out = sidebar.compose(mock_snapshot(), 40)
        for pane in out:
            self.assertFalse(set(LEGACY) & set(out[pane]), pane)
        self.assertTrue(out["P-sidebar"]["fm_hd"].startswith(IND + "├─ ⠼"))
        self.assertTrue(out["P-perms"]["fm_hd"].startswith(IND + sidebar.CONT_MID + "└─ ✋"))

    def test_self_pushing_pane_keeps_only_fm_sort(self):
        out = sidebar.compose(mock_snapshot(), 40, self_panes={"P-root"})
        self.assertEqual(out["P-root"], {"fm_sort": "r001"})

    def test_tree_out_and_tpl_out(self):
        tree, tpl = {}, {}
        sidebar.compose(mock_snapshot(), 40, tree_out=tree, tpl_out=tpl)
        self.assertEqual(tree["P-root"] if "P-root" in tree else tree["root"], {"P": "", "conn": "", "own": ""})
        self.assertEqual(tree["perms"], {"P": sidebar.CONT_MID, "conn": sidebar.CONN_LAST, "own": sidebar.CONT_LAST})
        self.assertEqual(sorted(tpl), ["P-root", "P-sidebar"])   # the two working sessions
        self.assertEqual(tpl["P-root"].replace(B, " "), "  {spin}◎ pi-foreman                   12s")

    def test_continuations_share_the_column_of_the_connector_or_glyph_they_continue(self):
        # Herdr draws the rows below a header DETAIL_INDENT cells right of it; `rendered` does the same
        lines = rendered(mock_snapshot(), 40)
        self.assertEqual(sidebar.DETAIL_INDENT, 2)
        for i, line in enumerate(lines):
            for c, ch in enumerate(line):
                if ch != "│":
                    continue
                above = next(l for l in reversed(lines[:i]) if len(l) > c and l[c] != " ")
                below = next(l for l in lines[i + 1:] if len(l) > c and l[c] != " ")
                self.assertIn(above[c], "│├⠹⠼", (c, line, above))
                self.assertIn(below[c], "│├└", (c, line, below))
        self.assertEqual(lines[0].index("⠹"), lines[1].index("│"))   # the root's glyph over its trunk
        self.assertEqual(lines[4].index("├"), lines[1].index("│"))   # a child's connector in the trunk's column

    def test_last_joined_child_gets_the_last_connector_whatever_follows_unjoined(self):
        a = tnode("a", "a", "⠼", started=1.0)
        b = tnode("b", "b", "⠼", started=2.0)
        closed = tnode("c", "c", "✓", "done", started=3.0)
        closed["paneId"] = None
        root = tnode("root", "root", "⠼", children=[a, b, closed])
        tree = {}
        sidebar.compose({"roots": [root]}, 40, tree_out=tree)
        self.assertEqual((tree["a"]["conn"], tree["b"]["conn"]), (sidebar.CONN_MID, sidebar.CONN_LAST))
        self.assertEqual(tree["b"]["own"], sidebar.CONT_LAST)
        self.assertNotIn("c", tree)

    def test_pushed_tree_position_places_a_root(self):
        n = tnode("s", "nested", "⠼")
        pos = {"s": {"P": sidebar.CONT_MID, "conn": sidebar.CONN_MID, "own": sidebar.CONT_MID}}
        out = sidebar.compose({"roots": [n]}, 40, tree=pos)["P-s"]
        self.assertTrue(out["fm_hd"].startswith(IND + sidebar.CONT_MID + sidebar.CONN_MID + "⠼"))
        self.assertEqual(out["fm_meta"][:9], sidebar.CONT_MID + sidebar.CONT_MID + sidebar.CONT_LAST)
        bad = {"s": {"P": "x", "conn": "├─ ", "own": ""}}
        self.assertTrue(sidebar.compose({"roots": [n]}, 40, tree=bad)["P-s"]["fm_hd"].startswith(IND + "⠼"))


class TreePropertyTest(unittest.TestCase):
    NAMES = ("alpha", "b", "r31-sidebar", "日本語の名前", "cafe\u0301-long-name", "x" * 40, "🤖bot", "r")
    STATES = (("working", "working"), ("waiting", "waiting"), ("blocked", "blocked"), ("done", "done"))

    def random_tree(self, rnd, symbols):
        g = SYMS[symbols]
        count = [0]

        def make(depth):
            count[0] += 1
            i = count[0]
            sym, state = rnd.choice(self.STATES)
            kids = []
            while depth < 5 and count[0] < 12 and rnd.random() < 0.55:
                kids.append(make(depth + 1))
            n = tnode("n%d" % i, rnd.choice(self.NAMES), g[sym], sym, state, age=rnd.choice((0, 59, 4000, 90000)),
                      children=kids, symbols=symbols, started=rnd.choice((None, 1.0, 2.0)),
                      tot=(rnd.choice((0, 1500, 99000)), 12, rnd.choice((0.0, 1.5, 120.0))))
            if rnd.random() < 0.3:
                n["tasks"] = [{"id": "t", "label": "npm test", "pid": 1, "ageSeconds": 70}]
            if rnd.random() < 0.2:
                n["asks"] = ["which scope"]
            if rnd.random() < 0.15 and depth:
                n["paneId"] = None   # an unjoined session: its row children attach to the nearest joined ancestor
            return n
        root = make(0)
        root["paneId"] = "P-n1"
        return {"symbols": symbols, "roots": [root]}

    def check(self, snap, width, symbols):
        joins = {n["key"]: "P-" + n["key"] for n in sidebar.walk(snap["roots"])
                 if n["kind"] == "session" and n.get("paneId")}
        tree = {}
        out = sidebar.compose(snap, width, joins, tree_out=tree)
        # Herdr draws detail rows DETAIL_INDENT cells right of the header, which carries those cells
        # as a blank indent: both are compared on one grid, the header without its indent
        budget = width - 3 - sidebar.DETAIL_INDENT
        lines = []   # (key, kind, text)
        for pane in sorted(out, key=lambda p: out[p]["fm_sort"]):
            key = pane[2:]
            for k in ROW_KEYS:
                if out[pane][k] is not None:
                    text = out[pane][k]
                    if k == "fm_hd":
                        self.assertEqual(text[:sidebar.DETAIL_INDENT], B * sidebar.DETAIL_INDENT)
                        text = text[sidebar.DETAIL_INDENT:]
                    lines.append((key, k, text))
        by_key = {key: i for i, (key, k, _) in reversed(list(enumerate(lines))) if k == "fm_hd"}
        for key, k, text in lines:
            self.assertLessEqual(sidebar.cell_width(text), budget, text)
            stripped = text.lstrip("│├└─ " + B)
            self.assertNotIn("…", text[:len(text) - len(stripped)])
        col = lambda text, c: text[c] if len(text) > c else ""   # noqa: E731
        headers = [(i, key, text) for i, (key, k, text) in enumerate(lines) if k == "fm_hd"]
        for i, (key, k, text) in enumerate(lines):
            if k != "fm_hd":
                continue
            pos = tree[key]
            c = len(pos["P"])
            if pos["conn"] and c + 3 <= budget:
                self.assertEqual(text[c:c + 3].rstrip(), pos["conn"].rstrip())
                # an unbroken chain of │/├ in this column back to the parent's own header
                j = i - 1
                while j >= 0 and col(lines[j][2], c) in ("│", "├"):
                    j -= 1
                self.assertTrue(j >= 0 and lines[j][1] == "fm_hd", (key, lines[j] if j >= 0 else None))
                parent = tree[lines[j][0]]
                self.assertEqual(len(parent["P"]) + len(parent["own"]), c, (key, lines[j]))
            if pos["conn"] and c + 3 <= budget and pos["conn"] == sidebar.CONN_MID:
                # a later sibling closes the column: │ runs on until a connector
                j = i + 1
                while j < len(lines) and col(lines[j][2], c) == "│":
                    j += 1
                self.assertTrue(j < len(lines) and col(lines[j][2], c) in ("├", "└"), (key, text))
            if pos["conn"] == sidebar.CONN_LAST and c + 3 <= budget and i + 1 < len(lines):
                self.assertNotEqual(col(lines[i + 1][2], c), "│", (key, lines[i + 1]))
        for i, (key, k, text) in enumerate(lines):
            pos = tree[key]
            if k == "fm_hd":
                want = len(pos["P"]) + (6 if pos["conn"] else 3) + sidebar.slot_width(sidebar.aux_symbols(symbols)) - 2
                if budget - want >= 2:
                    rest = text[len(pos["P"]) + len(pos["conn"]):]   # slot, space, label
                    slot = sidebar.slot_width(sidebar.aux_symbols(symbols))
                    self.assertEqual(sidebar.cell_width(rest[:rest.index(" ") + 1]), slot + 1, text)
            else:
                want = len(pos["P"]) + len(pos["own"]) + 3
                if budget - want >= 2:
                    self.assertEqual(text[want - 3:want], sidebar.CONT_MID if self.has_kids(snap, joins, key)
                                     else sidebar.CONT_LAST)
                    self.assertTrue(text[want] not in (B, "│"), text)
            c = len(pos["P"]) + len(pos["own"])
            if k != "fm_hd" and c + 3 <= budget and text[c] == "│":
                self.assertTrue(self.has_kids(snap, joins, key), (key, text))
        # a │ anywhere is followed by a connector in its column further down
        for i, (_, _, text) in enumerate(lines):
            for c in range(0, min(len(text), budget), 3):
                if text[c] == "│" and c + 3 <= budget:
                    j = i + 1
                    while j < len(lines) and col(lines[j][2], c) == "│":
                        j += 1
                    self.assertTrue(j < len(lines) and col(lines[j][2], c) in ("├", "└"), (c, text))
        self.assertEqual(len(by_key), len(headers))

    def has_kids(self, snap, joins, key):
        node = next(n for n in sidebar.walk(snap["roots"]) if n["key"] == key)
        return bool(sidebar._row_children(node.get("children") or [], joins))

    def test_random_trees_at_every_width(self):
        import random
        rnd = random.Random(33)
        for trial in range(60):
            symbols = rnd.choice(sorted(SYMS))
            snap = self.random_tree(rnd, symbols)
            for width in (18, 19, 20, 24, 26, 30, 40, 60, 100):
                with self.subTest(trial=trial, width=width, symbols=symbols):
                    self.check(snap, width, symbols)


class CellWidthTest(unittest.TestCase):
    # width of every glyph of config/symbols.json (state glyphs, activity marks, spinner frames)
    WIDTHS = {
        "unicode": {"working": 2, "waiting": 1, "asking": 1, "blocked": 2, "done": 1, "lost": 1, "keepalive": 1,
                    "cold": 1, "downshift": 1, "waiting-owner": 2, "waiting-external": 1, "idle": 1, "review": 1, "agent": 1, "task": 1, "wait": 1,
                    "ask": 1, "recent": 1, "pr-fail": 1, "pr-run": 1, "pr-ok": 1, "pr-none": 1, "rule": 1},
        "emoji": {"working": 2, "waiting": 2, "asking": 2, "blocked": 2, "done": 2, "lost": 2, "keepalive": 2,
                  "cold": 2, "downshift": 2, "waiting-owner": 2, "waiting-external": 2, "idle": 2, "review": 2, "agent": 2, "task": 2, "wait": 2,
                  "ask": 2, "recent": 2, "pr-fail": 1, "pr-run": 1, "pr-ok": 1, "pr-none": 1, "rule": 1},
        "nerd": dict.fromkeys(("working", "waiting", "asking", "blocked", "done", "lost", "keepalive", "cold", "downshift",
                               "waiting-owner", "waiting-external", "idle", "review", "agent", "task", "wait", "ask", "recent",
                               "pr-fail", "pr-run", "pr-ok", "pr-none", "rule"), 1),
        "ascii": dict.fromkeys(("working", "waiting", "asking", "blocked", "done", "lost", "keepalive", "cold", "downshift",
                                "waiting-owner", "waiting-external", "idle", "review", "agent", "task", "wait", "ask", "recent",
                                "pr-fail", "pr-run", "pr-ok", "pr-none", "rule"), 1),
    }

    def test_every_glyph_of_symbols_json_has_its_pinned_width(self):
        with open(ROOT / "config" / "symbols.json", encoding="utf-8") as fh:
            shared = json.load(fh)
        self.assertEqual(set(shared), set(self.WIDTHS))
        for name, table in shared.items():
            frames = table["spinner"]
            self.assertEqual(set(table) - {"spinner"}, set(self.WIDTHS[name]), name)
            for key, want in self.WIDTHS[name].items():
                self.assertEqual(sidebar.cell_width(table[key]), want, (name, key, table[key]))
            self.assertTrue(frames and all(sidebar.cell_width(f) == 1 for f in frames), name)

    def test_the_rule(self):
        cw = sidebar.cell_width
        self.assertEqual([cw("⏸"), cw("⏸\ufe0f"), cw("⚙"), cw("⚙\ufe0f"), cw("♨\ufe0f")], [1, 2, 1, 2, 2])
        self.assertEqual([cw("⏳"), cw("✋"), cw("🤖"), cw("✅"), cw("❓")], [2, 2, 2, 2, 2])
        self.assertEqual([cw("*"), cw("#"), cw("7"), cw("*\ufe0f"), cw("a\u0301")], [1, 1, 1, 2, 1])
        self.assertEqual([cw("a\u200db"), cw("⏸\ufe0e"), cw("日本"), cw("⠀"), cw(""), cw("\ufe0f")], [2, 1, 4, 1, 1, 0])
        self.assertEqual(sidebar.truncate("⏸\ufe0fabc", 3), "⏸\ufe0f…")


class ActivityTest(unittest.TestCase):
    def lines(self, symbols="unicode", sym="working", state=None, recent=8, **extra):
        n = tnode("s", "sess", "⠼", sym, state, symbols=symbols, **extra)
        out = sidebar.compose({"symbols": symbols, "recentRunSeconds": recent, "roots": [n]}, 60)["P-s"]
        return [out[k] and out[k].replace(B, " ").strip() for k in ("fm_a1", "fm_a2", "fm_a3")]

    def test_idle_session_shows_no_activity_lines(self):
        self.assertEqual(self.lines(sym="waiting"), [None, None, None])

    def test_runs_are_agents_and_just_finished_runs_show_a_tick(self):
        kids = [trun("a", "builder"), trun("b", "builder"), trun("c", "explorer", state="done", sym="done", ended_s=2),
                trun("d", "old", state="done", sym="done", ended_s=60)]
        self.assertEqual(self.lines(children=kids)[0], "◆ builder ×2 · ✓ explorer")
        self.assertEqual(self.lines(children=kids[2:3])[0], "✓ explorer")
        self.assertEqual(self.lines(children=kids[3:])[0], None)

    def test_tasks_bg_waits_ci_and_pr_are_one_line(self):
        wait = lambda kind, note, **kw: dict({"id": kind, "kind": kind, "note": note, "age_s": 120, "left_s": 0}, **kw)  # noqa: E731
        self.assertEqual(self.lines(tasks=[{"id": "t", "label": "npm test", "pid": 1, "ageSeconds": 180}])[1:],
                         ["⚙ npm test 3m", None])
        self.assertEqual(self.lines(waits=[wait("timer", "watch logs", bg=True)])[1:], ["⚙ watch logs 2m", None])
        self.assertEqual(self.lines(waits=[wait("ci", "ci main")])[1:], ["⚙ ci main 2m", None])
        self.assertEqual(self.lines(waits=[wait("pr", "2 pr watch", prs=[12, 14])])[1:], ["⚙ pr #12 · pr #14", None])
        self.assertEqual(self.lines(waits=[wait("pr", "2 pr watch")])[1:], ["⚙ 2 pr watch", None])
        both = self.lines(waits=[wait("timer", "bg cmd", bg=True), wait("pr", "1 pr watch", prs=[3])],
                          tasks=[{"id": "t", "label": "lint", "pid": 1, "ageSeconds": 5}])
        self.assertEqual(both[1], "⚙ pr #3 · bg cmd 2m · lint 5s")

    def test_other_waits_and_asks(self):
        wait = lambda kind, note: {"id": kind, "kind": kind, "note": note, "age_s": 60, "left_s": 0}  # noqa: E731
        for kind, note in (("timer", "until 15:00"), ("file", "out.log"), ("child", "child r32b"), ("pid", "suites")):
            self.assertEqual(self.lines(waits=[wait(kind, note)])[1:], [None, "◷ %s 1m" % note], kind)
        self.assertEqual(self.lines(asks=["rule scope"])[2], "? ask 1: rule scope")
        self.assertEqual(self.lines(sym="blocked", state="ask")[2], "? ask 1")
        self.assertEqual(self.lines(children=[trun("q", "builder", state="ask", sym="asking")])[2], "? ask 1")
        mixed = self.lines(asks=["scope"], waits=[wait("timer", "nap")])
        self.assertEqual(mixed[2], "? ask 1: scope · ◷ nap 1m")

    def test_ask_objects_render_number_and_topic(self):
        self.assertEqual(self.lines(asks=[{"n": 3, "topic": "rule scope"}])[2], "? ask 3: rule scope")
        self.assertEqual(self.lines(asks=[{"n": 3, "topic": ""}])[2], "? ask 3")
        self.assertEqual(self.lines(asks=["plain"])[2], "? ask 1: plain")

    def test_overflow_counts_hidden_items(self):
        tasks = [{"id": str(i), "label": "t%d" % i, "pid": 1, "ageSeconds": 60} for i in range(5)]
        self.assertEqual(self.lines(tasks=tasks)[1], "⚙ t0 1m · t1 1m · t2 1m +2")

    def test_done_and_lost_sessions(self):
        runs = [trun("a", "builder", state="done", sym="done"), trun("b", "builder", state="done", sym="done")]
        self.assertEqual(self.lines(sym="done", children=runs)[0], "done · 2 runs")
        self.assertEqual(self.lines(sym="done", children=runs[:1])[0], "done · 1 run")
        self.assertEqual(self.lines(sym="done")[0], None)
        self.assertEqual(self.lines(sym="done", tasks=[{"label": "x", "ageSeconds": 1}]), [None, None, None])
        lost = tnode("s", "sess", "✗", "waiting")
        lost["sym"] = "lost"
        self.assertEqual(sidebar.compose({"roots": [lost]}, 40)["P-s"]["fm_a1"].strip(B), "lost")

    def test_older_versions_without_the_new_fields(self):
        n = tnode("s", "sess", "⠼")
        for gone in ("waits", "tasks", "asks", "started", "pressure"):
            n.pop(gone, None)
        out = sidebar.compose({"roots": [n]}, 40)["P-s"]
        self.assertEqual([out[k] for k in ("fm_a1", "fm_a2", "fm_a3")], [None, None, None])
        self.assertEqual(out["fm_meta"].strip(B), "$0.00")

    def test_every_glyph_set_reaches_the_renderer(self):
        tasks = [{"id": "t", "label": "x", "pid": 1, "ageSeconds": 60}]
        waits = [{"id": "w", "kind": "timer", "note": "nap", "age_s": 60, "left_s": 0}]
        for symbols in SYMS:
            g = SYMS[symbols]
            got = self.lines(symbols, children=[trun("a", "builder")], tasks=tasks, waits=waits, asks=["q"])
            self.assertEqual(got, [g["agent"] + " builder", g["task"] + " x 1m",
                                   "%s ask 1: q · %s nap 1m" % (g["ask"], g["wait"])], symbols)

    def test_unknown_set_and_missing_file_fall_back_to_unicode(self):
        self.assertEqual(sidebar.aux_symbols("klingon"), sidebar.aux_symbols("unicode"))
        old = sidebar.SYMBOLS_FILE
        sidebar._aux_cache.clear()
        sidebar.SYMBOLS_FILE = os.path.join(tempfile.gettempdir(), "no-such-symbols.json")
        try:
            got = sidebar.aux_symbols("emoji")
        finally:
            sidebar.SYMBOLS_FILE = old
            sidebar._aux_cache.clear()
        self.assertEqual((got["agent"], got["spinner"]), ("◆", list(sidebar.SPINNER_FALLBACK)))

    def test_wait_line_for_every_set_and_no_legacy_tokens(self):
        wait = {"id": "w1", "kind": "pid", "note": "suites", "age_s": 240, "left_s": 600}
        for symbols, glyph in (("emoji", "⏱️"), ("ascii", "~"), ("unicode", "◷"), ("nerd", "\uf017")):
            n = tnode("s", "s", "⠼", waits=[wait])
            out = sidebar.compose({"symbols": symbols, "roots": [n]}, 40)["P-s"]
            self.assertEqual(out["fm_a3"].replace(B, " ").strip(), "%s suites 4m" % glyph, symbols)
            self.assertFalse(set(LEGACY) & set(out), symbols)


class TreeFilesTest(unittest.TestCase):
    def test_layout_and_tree_are_read_only_while_fresh(self):
        tmp = tempfile.mkdtemp()
        try:
            for name, reader in (("layout.json", sidebar.read_layout), ("tree.json", sidebar.read_tree)):
                path = os.path.join(tmp, name)
                self.assertEqual(reader(tmp), {})
                with open(path, "w", encoding="utf-8") as fh:
                    json.dump({"k": {}}, fh)
                self.assertEqual(reader(tmp), {"k": {}})
                old = time.time() - sidebar.TREE_FRESH_S - 1
                os.utime(path, (old, old))
                self.assertEqual(reader(tmp), {})
                self.assertEqual(reader(tmp, now=old + 1), {"k": {}})
        finally:
            shutil.rmtree(tmp)

    def test_daemon_publish_writes_layout_and_tree(self):
        tmp = tempfile.mkdtemp()
        try:
            pub = sidebar.Publisher(type("A", (), {"width": 40, "lead_cells": None, "no_view": True,
                                                   "agent_dir": None})(), tmp)
            pub._call = lambda method, params: {"agents": []} if method == "agent.list" else {}
            pub.publish(mock_snapshot())
            self.assertEqual(sidebar.read_tree(tmp), {})   # no agent.list pane for any session: nothing joined
        finally:
            shutil.rmtree(tmp)


def write_child_session(adir, sid, intercom, parent, pane):
    import datetime
    iso = lambda ago: (datetime.datetime.now(datetime.timezone.utc)  # noqa: E731
                       - datetime.timedelta(seconds=ago)).strftime("%Y-%m-%dT%H:%M:%SZ")
    d = {"v": 1, "sessionId": sid, "intercomId": intercom, "parentIntercom": parent, "label": sid, "cwd": "/x",
         "pid": 1, "paneId": pane, "startedAt": iso(30), "heartbeatAt": iso(1), "lastEventAt": iso(1),
         "state": "working", "runs": []}
    with open(os.path.join(adir, "pi-foreman", "state", "live", sid + ".json"), "w", encoding="utf-8") as fh:
        json.dump(d, fh)


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "POSIX AF_UNIX socket")
class PushJsonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        self.herdr = FakeHerdr(os.path.join(self.tmp, "h.sock"))
        self.adir = write_agent_dir(self.tmp)
        self.sdir = os.path.join(self.tmp, "state")
        os.makedirs(os.path.join(self.sdir, "push"))
        self.stamp = os.path.join(self.sdir, "push", "sid-1.stamp")
        self.tokens_file = os.path.join(self.sdir, "push", "sid-1.tokens")

    def tearDown(self):
        self.herdr.close()
        shutil.rmtree(self.tmp)

    def push(self, *extra, session="sid-1", pane="p1"):
        env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(self.tmp, "h.sock"),
                   HERDR_PLUGIN_STATE_DIR=self.sdir, HERDR_SIDEBAR_WIDTH="26")
        return subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "push", "--session", session,
                               "--pane", pane, "--agent-dir", self.adir] + list(extra),
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def write_fresh(self, name, data, age=0):
        path = os.path.join(self.sdir, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        if age:
            os.utime(path, (time.time() - age, time.time() - age))

    def test_json_prints_the_bundle_reports_nothing_and_writes_no_stamp(self):
        with open(self.tokens_file, "w", encoding="utf-8") as fh:
            json.dump({"tokens": {}, "at": time.time()}, fh)
        res = self.push("--json")
        self.assertEqual((res.returncode, res.stderr), (0, b""))
        doc = json.loads(res.stdout.decode("utf-8"))
        self.assertEqual(set(doc), {"tokens", "fm_hd_tpl", "stamp", "pane"})
        self.assertEqual((doc["pane"], doc["stamp"]), ("p1", self.stamp))
        self.assertEqual(set(doc["tokens"]), set(sidebar.SESSION_KEYS))
        self.assertTrue(doc["tokens"]["fm_hd"].startswith(IND + "⏳"))        # the static glyph
        self.assertTrue(doc["fm_hd_tpl"].startswith(IND + "{spin}" + B + " demo"), doc["fm_hd_tpl"])
        self.assertEqual(self.herdr.reports(), [])
        self.assertFalse(os.path.exists(self.stamp))
        self.assertFalse(os.path.exists(self.tokens_file))
        # a plain push after --json reports at once
        self.assertEqual(self.push().returncode, 0)
        self.assertEqual(len(self.herdr.reports()), 1)
        self.assertTrue(os.path.exists(self.stamp))

    def test_no_template_while_the_session_is_not_working(self):
        live = os.path.join(self.adir, "pi-foreman", "state", "live", "sid-1.json")
        with open(live, encoding="utf-8") as fh:
            d = json.load(fh)
        d["state"] = "done"
        with open(live, "w", encoding="utf-8") as fh:
            json.dump(d, fh)
        doc = json.loads(self.push("--json").stdout.decode("utf-8"))
        self.assertIsNone(doc["fm_hd_tpl"])
        self.assertTrue(doc["tokens"]["fm_hd"].startswith(IND + "✓"))

    def test_fm_a3_drops_a_wait_once_the_presence_file_no_longer_lists_it(self):
        # the TS side (r61-wait-brief-supersede.test.ts) pins resolve/cancel -> presence file; this is the compose half
        live = os.path.join(self.adir, "pi-foreman", "state", "live", "sid-1.json")
        with open(live, encoding="utf-8") as fh:
            d = json.load(fh)
        d["waits"] = [{"id": "w1", "kind": "timer", "note": "ruling", "ageSeconds": 5, "leftSeconds": 60}]
        with open(live, "w", encoding="utf-8") as fh:
            json.dump(d, fh)
        before = json.loads(self.push("--json").stdout.decode("utf-8"))["tokens"]["fm_a3"]
        self.assertIn("ruling", before or "")
        d["waits"] = []
        with open(live, "w", encoding="utf-8") as fh:
            json.dump(d, fh)
        after = json.loads(self.push("--json").stdout.decode("utf-8"))["tokens"]["fm_a3"]
        self.assertNotIn("ruling", after or "")
        self.assertFalse(after and after.replace(B, " ").strip())

    def test_unknown_session_and_a_losing_session_print_an_empty_object(self):
        self.assertEqual(self.push("--json", session="nope").stdout, b"{}\n")
        self.write_fresh("winners.json", {"p1": "another-session"})
        res = self.push("--json")
        self.assertEqual((res.returncode, res.stdout), (0, b"{}\n"))

    def test_fresh_tree_json_places_the_row(self):
        self.write_fresh("tree.json", {"fm-1": {"P": sidebar.CONT_MID, "conn": sidebar.CONN_LAST, "own": sidebar.CONT_LAST}})
        doc = json.loads(self.push("--json").stdout.decode("utf-8"))
        self.assertTrue(doc["tokens"]["fm_hd"].startswith(IND + sidebar.CONT_MID + sidebar.CONN_LAST), doc["tokens"]["fm_hd"])
        self.assertTrue(doc["fm_hd_tpl"].startswith(IND + sidebar.CONT_MID + sidebar.CONN_LAST + "{spin}"))

    def test_stale_or_missing_tree_json_builds_the_full_tree(self):
        write_child_session(self.adir, "sid-2", "fm-2", "fm-1", "p2")
        write_child_session(self.adir, "sid-3", "fm-3", "fm-1", "p3")
        # the daemon's file claims the child is the root of its own tree; it is a minute old
        self.write_fresh("tree.json", {"fm-3": {"P": "", "conn": "", "own": ""}}, age=60)
        self.write_fresh("layout.json", {"fm-3": {"pre": "", "cont": ""}}, age=60)
        hd = lambda sid, pane: json.loads(self.push("--json", session=sid, pane=pane).stdout)["tokens"]["fm_hd"]  # noqa: E731
        self.assertTrue(hd("sid-2", "p2").startswith(IND + sidebar.CONN_MID + "⏳"), hd("sid-2", "p2"))
        self.assertTrue(hd("sid-3", "p3").startswith(IND + sidebar.CONN_LAST + "⏳"), hd("sid-3", "p3"))
        os.remove(os.path.join(self.sdir, "tree.json"))
        self.assertTrue(hd("sid-3", "p3").startswith(IND + sidebar.CONN_LAST))
        # fresh files win over the fallback, for the keys they hold
        self.write_fresh("tree.json", {"fm-3": {"P": "", "conn": sidebar.CONN_MID, "own": sidebar.CONT_MID}})
        self.write_fresh("layout.json", {"fm-3": {"pre": "├─", "cont": "│" + B}})
        self.assertTrue(hd("sid-3", "p3").startswith(IND + sidebar.CONN_MID))

    def test_full_tree_skips_a_closed_session_so_the_last_joined_child_gets_the_last_connector(self):
        write_child_session(self.adir, "sid-2", "fm-2", "fm-1", "p2")
        write_child_session(self.adir, "sid-3", "fm-3", "fm-1", "p3")
        write_child_session(self.adir, "sid-4", "fm-4", "fm-1", "p4")   # its pane is closed: not in winners
        self.write_fresh("winners.json", {"p1": "sid-1", "p2": "sid-2", "p3": "sid-3"})
        hd = lambda sid, pane: json.loads(self.push("--json", session=sid, pane=pane).stdout)["tokens"]["fm_hd"]  # noqa: E731
        self.assertTrue(hd("sid-2", "p2").startswith(IND + sidebar.CONN_MID), hd("sid-2", "p2"))
        self.assertTrue(hd("sid-3", "p3").startswith(IND + sidebar.CONN_LAST), hd("sid-3", "p3"))

    def test_every_glyph_set_is_a_symbols_choice(self):
        want = {"unicode": "⏳", "emoji": "⏳", "nerd": "", "ascii": "*"}
        for name, glyph in want.items():
            doc = json.loads(self.push("--json", "--symbols", name).stdout.decode("utf-8"))
            self.assertTrue(doc["tokens"]["fm_hd"].startswith(IND + glyph), (name, doc["tokens"]["fm_hd"]))
        self.assertEqual(self.push("--json", "--symbols", "klingon").returncode, 2)

    def test_final_after_json_still_publishes(self):
        self.push("--json")
        self.assertEqual(self.push("--final").returncode, 0)
        self.assertEqual(len(self.herdr.reports()), 1)


# ---------------------------------------------------------------- Round 53: PR dots, sample

PR_KEYS = ("fm_pr1", "fm_pr2", "fm_pr3", "fm_pr4")
PR_STATE_KEYS = {"fail": "pr-fail", "run": "pr-run", "ok": "pr-ok", "none": "pr-none"}


def dot(n, state, label=None, src="pr"):
    return {"n": n, "state": state, "label": "#%d" % n if label is None else label, "src": src}


def dots_snap(dots, symbols="unicode", kids=()):
    root = tnode("d", "dots", SYMS[symbols]["working"], symbols=symbols, dots=dots, children=list(kids))
    return {"symbols": symbols, "roots": [root]}


def pr_cells(dots, width, symbols="unicode", kids=()):
    out = sidebar.compose(dots_snap(dots, symbols, kids), width)["P-d"]
    return [out[k] for k in PR_KEYS]


FOUR = [dot(12, "none"), dot(19, "ok"), dot(21, "run"), dot(17, "fail")]


class DotsRowTest(unittest.TestCase):
    def test_cells_per_set_and_state(self):
        for symbols, g in SYMS.items():
            with self.subTest(symbols=symbols):
                cells = pr_cells(FOUR, 60, symbols)
                self.assertEqual(cells, [sidebar.CONT_LAST + g["pr-fail"] + " #17", g["pr-run"] + " #21",
                                         g["pr-ok"] + " #19", g["pr-none"] + " #12"])
                for state, key in PR_STATE_KEYS.items():
                    one = pr_cells([dot(5, state)], 60, symbols)
                    self.assertEqual(one, [sidebar.CONT_LAST + g[key] + " #5", None, None, None])

    def test_order_is_state_then_number_then_label(self):
        aux = sidebar.aux_symbols("ascii")
        dots = [dot(3, "none"), dot(9, "ok"), dot(5, "fail"), dot(1, "run"), dot(2, "fail"),
                dot(None, "fail", "zeta", "ext"), dot(None, "fail", "alpha", "ext"), dot(9, "fail", "#9b")]
        items = sidebar._dot_items(dots, aux)
        self.assertEqual([label for _, label in items],
                         ["#2", "#5", "#9b", "alpha", "zeta", "#1", "#9", "#3"])
        self.assertEqual([c for c, _ in items], [aux["pr-fail"]] * 5 + [aux["pr-run"], aux["pr-ok"], aux["pr-none"]])
        self.assertEqual(sidebar._dot_items([dot(1, "weird")], aux), [(aux["pr-none"], "#1")])

    def test_the_width_26_example_and_plus_n_counts_hidden_items(self):
        self.assertEqual(pr_cells(FOUR, 26), [sidebar.CONT_LAST + "● #17", "+3", None, None])
        self.assertEqual(" · ".join(c for c in pr_cells(FOUR, 26) if c).replace(sidebar.BLANK, ""), "● #17 · +3")
        self.assertEqual(sidebar.cell_width("● #17 · +3"), 10)
        # a width where three cells fit: the third becomes +2, the hidden red one still counts at 3 cells
        self.assertEqual(pr_cells(FOUR, 34)[1:3], ["◉ #21", "+2"])
        # more than four items: the fourth cell is +n
        six = FOUR + [dot(30, "none"), dot(31, "none")]
        self.assertEqual(pr_cells(six, 60), [sidebar.CONT_LAST + "● #17", "◉ #21", "○ #19", "+3"])
        # four items that all fit show no +n
        self.assertEqual(pr_cells(FOUR, 60)[3], "◌ #12")

    def test_only_cell_one_fits_then_plus_n_is_appended_only_if_it_fits(self):
        # room = width - 3 - 2 - 3: at width 18 cell 1 (5) and ` · +3` (5) fit in 10, cell 2 does not
        self.assertEqual(pr_cells(FOUR, 18), [sidebar.CONT_LAST + "● #17", "+3", None, None])
        self.assertEqual(pr_cells(FOUR, 17), [sidebar.CONT_LAST + "● #17", None, None, None])
        self.assertEqual(pr_cells(FOUR, 13), [sidebar.CONT_LAST + "● #17", None, None, None])

    def test_cell_one_is_cut_never_dropped(self):
        long = [dot(1, "fail", "x" * 40), dot(2, "run")]
        for width in range(12, 40):
            cells = pr_cells(long, width)
            room = width - 3 - sidebar.DETAIL_INDENT - sidebar.UNIT
            self.assertTrue(cells[0].startswith(sidebar.CONT_LAST + "● x"), (width, cells))
            self.assertTrue(cells[0].endswith("…"))
            self.assertEqual(sidebar.cell_width(cells[0]) - sidebar.UNIT, room, (width, cells))
            self.assertEqual(cells[1:], [None] * 3)
        # not even the circle and an ellipsis fit: the continuation prefix, as a detail line does
        for width in (4, 7, 8, 9):
            self.assertEqual(pr_cells(long, width)[0], sidebar.CONT_LAST[:max(0, width - 3 - 2) // 3 * 3] or None)
        self.assertEqual(pr_cells(long, 10)[0], sidebar.CONT_LAST + "●…")

    def test_cell_one_carries_the_continuation_of_its_row(self):
        g = SYMS["unicode"]
        kid = tnode("k", "kid", g["working"])
        self.assertTrue(pr_cells(FOUR, 40, kids=[kid])[0].startswith(sidebar.CONT_MID + "●"))
        out = sidebar.compose(dots_snap(FOUR, kids=[dict(kid, dots=FOUR)]), 40)["P-k"]
        self.assertTrue(out["fm_pr1"].startswith(sidebar.CONT_LAST * 2 + "●"), out["fm_pr1"])   # under a last child
        self.assertEqual(out["fm_pr2"], "◉ #21")

    def test_no_value_without_items(self):
        for dots in (None, [], "x", 3, [None, 5, "x"], [dot(1, "ok", ""), dot(2, "ok", "\u200b\u202e"), {"state": "ok"},
                                                        dot(3, "ok", 7)]):
            self.assertEqual(pr_cells(dots, 40), [None] * 4, dots)
        node_ = tnode("d", "dots", "✓", "done")
        self.assertEqual([sidebar.compose({"roots": [node_]}, 40)["P-d"][k] for k in PR_KEYS], [None] * 4)

    def test_labels_are_sanitised(self):
        label = lambda text: sidebar._dot_label(text)  # noqa: E731
        self.assertEqual(label("a\u202eb\u200bc\x07d\u2066"), "abcd")      # Cf (bidi, zero width) and Cc stripped
        self.assertEqual(label("● x ◉○◌\uf111\uf192\uf10c\uf1db"), "? x ???????")
        self.assertEqual(label("ox.* deploy"), "ox.* deploy")              # ascii letters are left alone
        self.assertEqual(label("\u200b\x00 \u202e"), None)
        self.assertIsNone(label(None))
        self.assertEqual(pr_cells([dot(1, "ok", "a\u202eb●c")], 60)[0], sidebar.CONT_LAST + "○ ab?c")
        # no token of the row carries a Cf character
        out = sidebar.compose(dots_snap([dot(1, "ok", "\u200bz")]), 40)["P-d"]
        self.assertEqual(out["fm_pr1"], sidebar.CONT_LAST + "○ z")

    def test_cap_strips_format_characters_from_every_token(self):
        self.assertEqual(sidebar._cap("a\u202eb\u200bc\u2066d\x07e"), "abcde")
        snap = {"roots": [tnode("d", "ab\u202ecd\u200bef", "⏳", asks=["scope\u202e"])]}
        for value in sidebar.compose(snap, 60)["P-d"].values():
            self.assertFalse(value and any(unicodedata.category(c) in ("Cc", "Cf") for c in value), value)

    def test_circle_widths_are_pinned(self):
        for ch in "●◉○◌\uf111\uf192\uf10c\uf1db":
            self.assertEqual(sidebar.cell_width(ch), 1, hex(ord(ch)))
        for ch in "🔴🟡🟢⚪":
            self.assertEqual(sidebar.cell_width(ch), 2, hex(ord(ch)))


class DotsPropertyTest(unittest.TestCase):
    LABELS = ("#1", "#17", "#2048", "deploy", "a-very-long-external-label-for-a-check", "日本語", "x", "🤖", "e\u0301")

    def test_random_trees_at_every_width(self):
        import random
        rnd = random.Random(53)
        for trial in range(120):
            symbols = rnd.choice(sorted(SYMS))
            aux = sidebar.aux_symbols(symbols)
            dots = [dot(rnd.choice((None, 1, 12, 300)), rnd.choice(sidebar.DOT_STATES), rnd.choice(self.LABELS),
                        rnd.choice(("pr", "ext"))) for _ in range(rnd.randint(0, 7))]
            kids = [tnode("k", "kid", SYMS[symbols]["working"], symbols=symbols)] if rnd.random() < 0.5 else []
            snap = dots_snap(dots, symbols, kids)
            items = len(sidebar._dot_items(dots, aux))
            left = sidebar.CONT_MID if kids else sidebar.CONT_LAST
            for width in list(range(4, 41)) + [60, 100]:
                with self.subTest(trial=trial, width=width, symbols=symbols):
                    cells = [sidebar.compose(snap, width)["P-d"][k] for k in PR_KEYS]
                    present = sum(c is not None for c in cells)
                    self.assertEqual([c is not None for c in cells], [True] * present + [False] * (4 - present))
                    if not items:
                        self.assertEqual(present, 0)
                    if present == 0:   # no items, or not even one continuation unit fits
                        self.assertTrue(not items or width - 3 - sidebar.DETAIL_INDENT < sidebar.UNIT)
                        continue
                    room = width - 3 - sidebar.DETAIL_INDENT
                    self.assertLessEqual(sidebar.cell_width(cells[0]), room)
                    total = sidebar.cell_width(cells[0]) + sum(3 + sidebar.cell_width(c) for c in cells[1:present])
                    self.assertLessEqual(total, room, cells)
                    self.assertTrue(left.startswith(cells[0]) or cells[0].startswith(left), cells)
                    if cells[0].startswith(left):
                        self.assertNotIn(sidebar.BLANK, "".join(cells[1:present]))
                    last = cells[present - 1]
                    if last.startswith("+") and present > 1:
                        self.assertEqual(present - 1 + int(last[1:]), items, cells)
                    elif present > 1:
                        self.assertEqual(present, items, cells)


class RoundFiftyOneFollowUpTest(unittest.TestCase):
    def test_prefix_only_clamps_its_slice(self):
        two = sidebar.CONT_MID * 2
        for budget in range(-6, 3):
            self.assertIsNone(sidebar._prefix_only(two, budget), budget)
        self.assertEqual(sidebar._prefix_only(two, 3), sidebar.CONT_MID)
        self.assertEqual(sidebar._prefix_only(two, 7), two)
        self.assertIsNone(sidebar._prefix_only(two, 2, sidebar.BLANK * 2))
        self.assertEqual(sidebar._prefix_only(two, 5, sidebar.BLANK * 2), sidebar.BLANK * 2 + sidebar.CONT_MID)

    def test_widths_of_four_and_below_cut_nothing_from_the_wrong_end(self):
        for width in range(1, 5):
            out = sidebar.compose(mock_snapshot(), width)
            for pane, tokens in out.items():
                for k in ROW_KEYS:
                    if tokens[k] is not None:
                        self.assertLessEqual(sidebar.cell_width(tokens[k]), max(0, width - 3), (width, pane, k, tokens[k]))
                        self.assertTrue(set(tokens[k]) <= set(B + "│├└─ "), (width, pane, k, tokens[k]))


class PushWorld(unittest.TestCase):
    """A Herdr stand-in, one live session `sid-1` on pane p1 and a state folder."""
    skip = not (os.name == "posix" and hasattr(socket, "AF_UNIX"))

    def setUp(self):
        if self.skip:
            self.skipTest("POSIX AF_UNIX socket")
        self.tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        self.herdr = FakeHerdr(os.path.join(self.tmp, "h.sock"))
        self.adir = write_agent_dir(self.tmp)
        self.sdir = os.path.join(self.tmp, "state")
        os.makedirs(os.path.join(self.sdir, "push"))

    def tearDown(self):
        if not self.skip:
            self.herdr.close()
            shutil.rmtree(self.tmp)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if k != "HERDR_PANE_ID"}
        env.update(HERDR_SOCKET_PATH=os.path.join(self.tmp, "h.sock"), HERDR_PLUGIN_STATE_DIR=self.sdir,
                   HERDR_SIDEBAR_WIDTH="26")
        env.update(extra)
        return env

    def run_cli(self, *argv, env=None):
        return subprocess.run([sys.executable, str(PLUGIN / "sidebar.py")] + list(argv), env=env or self.env(),
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def push(self, *extra, pane="p1"):
        return self.run_cli("push", "--session", "sid-1", "--pane", pane, "--agent-dir", self.adir, *extra)

    def sample(self, *extra):
        return self.run_cli("sample", "--pane", "p1", "--symbols", "unicode", *extra)

    def sample_file(self, pane="p1"):
        return os.path.join(self.sdir, "sample", pane + ".json")


class SampleCommandTest(PushWorld):
    def test_sample_tokens_compose_both_variants_in_every_set(self):
        for symbols, g in SYMS.items():
            for variant in ("pr", "mixed"):
                with self.subTest(symbols=symbols, variant=variant):
                    tokens, tpl = sidebar.sample_tokens(variant, symbols, 48, "p1")   # room for the wide emoji cells
                    self.assertEqual(set(tokens), set(sidebar.SESSION_KEYS))      # never fm_sort
                    self.assertIn("{spin}", tpl)
                    self.assertIn("r53-sidebar", tokens["fm_hd"])
                    self.assertIn(g["agent"] + " builder sonnet-5.5 ×2", tokens["fm_a1"])
                    self.assertIn("pr #21", tokens["fm_a2"])
                    self.assertIn("npm test", tokens["fm_a2"])
                    self.assertIn(g["ask"] + " ask 1: rule scope", tokens["fm_a3"])
                    self.assertIn("⚠", tokens["fm_meta"])
                    cells = [tokens[k] for k in PR_KEYS]
                    if variant == "pr":
                        self.assertEqual(cells[1:], [g["pr-run"] + " #21", g["pr-ok"] + " #19", g["pr-none"] + " #12"])
                        self.assertTrue(cells[0].endswith(g["pr-fail"] + " #17"))
                    else:
                        self.assertEqual(cells[1:], [g["pr-run"] + " #21", g["pr-ok"] + " deploy", "+3"])

    def test_width_26_shows_the_overflow_example(self):
        tokens, _ = sidebar.sample_tokens("pr", "unicode", 26, "p1")
        self.assertEqual([tokens[k] for k in PR_KEYS], [sidebar.CONT_LAST + "● #17", "+3", None, None])

    def test_dry_run_prints_every_set_and_writes_nothing(self):
        for variant in ("pr", "mixed"):
            res = self.run_cli("sample", "--dry-run", "--variant", variant, "--width", "40")
            self.assertEqual((res.returncode, res.stderr), (0, b""))
            text = res.stdout.decode("utf-8")
            for name in SYMS:
                self.assertIn("== %s, variant %s, width 40 ==" % (name, variant), text)
            self.assertIn("● #17 · ◉ #21 · ○ #19 · ◌ #12" if variant == "pr" else "○ deploy · +3", text)
            emoji = text.split("\n== emoji, variant %s, width 40 ==\n" % variant)[1].split("\n== ")[0]
            self.assertIn("● #17", emoji)
            self.assertNotIn("🔴", text)
            self.assertIn("x #17 · * #21 · o #19 · . #12" if variant == "pr" else "o deploy · +3", text)
        one = self.run_cli("sample", "--dry-run", "--symbols", "ascii", "--width", "26")
        self.assertEqual(one.stdout.decode("utf-8").count("=="), 2)
        self.assertFalse(os.path.exists(os.path.join(self.sdir, "sample")))
        self.assertEqual(self.herdr.reports(), [])

    def test_sample_writes_the_file_and_publishes_once(self):
        res = self.sample("--variant", "mixed", "--width", "40", "--minutes", "5")
        self.assertEqual((res.returncode, res.stderr), (0, b""), res.stdout)
        (rep,) = self.herdr.reports()
        self.assertEqual((rep["pane_id"], rep["source"], rep["ttl_ms"]), ("p1", sidebar.SOURCE, 60000))
        with open(self.sample_file(), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual(set(doc), {"tokens", "fm_hd_tpl", "expires"})
        self.assertEqual(set(doc["tokens"]), set(sidebar.SESSION_KEYS))
        self.assertEqual(doc["tokens"], rep["tokens"])
        self.assertIn("{spin}", doc["fm_hd_tpl"])
        self.assertAlmostEqual(doc["expires"], time.time() + 300, delta=30)
        self.assertEqual(doc["tokens"]["fm_pr4"], "+3")

    def test_the_pane_comes_from_the_environment_and_a_bad_id_exits_2(self):
        res = self.run_cli("sample", "--symbols", "unicode", env=self.env(HERDR_PANE_ID="w3:p4"))
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertTrue(os.path.isfile(self.sample_file("w3:p4")))
        for bad in ("..", ".", "../x", "a/b", "a b", "x" * 101, "p1\n", ""):
            res = self.run_cli("sample", "--pane", bad, "--symbols", "unicode")
            self.assertEqual(res.returncode, 2, (bad, res.stderr))
            res = self.run_cli("sample", "--pane", bad, "--clear")
            self.assertEqual(res.returncode, 2, bad)
            res = self.run_cli("push", "--session", "sid-1", "--pane", bad, "--agent-dir", self.adir, "--dry-run")
            self.assertEqual(res.returncode, 2, (bad, res.stderr))
        res = self.run_cli("sample", "--symbols", "unicode")   # no pane at all
        self.assertEqual(res.returncode, 2)
        self.assertEqual(sorted(os.listdir(os.path.join(self.sdir, "sample"))), ["w3:p4.json"])

    def test_pane_id_ok(self):
        for good in ("p1", "w1:p2", "a.b-c_d", "1", "x" * 100, "...", ".a"):
            self.assertTrue(sidebar.pane_id_ok(good), good)
        for bad in ("", ".", "..", "a/b", "a\\b", "a b", "a\n", "x" * 101, "ä", None, 5, "a\x00"):
            self.assertFalse(sidebar.pane_id_ok(bad), bad)
        self.assertIsNone(sidebar.read_sample(self.sdir, ".."))

    def test_minutes_must_be_positive(self):
        for bad in ("0", "-1", "99999999"):
            self.assertEqual(self.sample("--minutes", bad).returncode, 2, bad)


class SampleOverrideTest(PushWorld):
    def real_tokens(self):
        return json.loads(self.push("--json").stdout.decode("utf-8"))

    def test_push_uses_the_sample_until_it_is_cleared(self):
        before = self.real_tokens()
        self.assertIsNone(before["tokens"]["fm_pr1"])
        self.assertEqual(self.sample("--width", "40").returncode, 0)
        sampled = self.real_tokens()
        self.assertEqual(set(sampled["tokens"]), set(sidebar.SESSION_KEYS))
        self.assertTrue(sampled["tokens"]["fm_pr1"].endswith("● #17"))
        self.assertIn("r53-sidebar", sampled["tokens"]["fm_hd"])
        self.assertIn("{spin}", sampled["fm_hd_tpl"])
        self.assertEqual((sampled["pane"], sampled["stamp"]), ("p1", os.path.join(self.sdir, "push", "sid-1.stamp")))
        # a plain push reports the sample, not the session's own row
        n = len(self.herdr.reports())
        self.assertEqual(self.push().returncode, 0)
        self.assertEqual(self.herdr.reports()[n]["tokens"], sampled["tokens"])
        # another pane is untouched
        self.assertEqual(self.push("--dry-run", pane="p9").returncode, 0)
        res = self.run_cli("sample", "--pane", "p1", "--clear")
        self.assertEqual((res.returncode, res.stderr), (0, b""))
        self.assertFalse(os.path.exists(self.sample_file()))
        after = self.real_tokens()
        self.assertIsNone(after["tokens"]["fm_pr1"])
        self.assertIn(" demo", after["tokens"]["fm_hd"])

    def test_an_expired_sample_is_ignored(self):
        tokens, tpl = sidebar.sample_tokens("pr", "unicode", 40, "p1")
        os.makedirs(os.path.dirname(self.sample_file()))
        for expires, want_sample in ((time.time() + 60, True), (time.time() - 1, False), ("soon", False),
                                     (float("nan"), False), (time.time() + 10 ** 9, False)):
            with open(self.sample_file(), "w", encoding="utf-8") as fh:
                json.dump({"tokens": tokens, "fm_hd_tpl": tpl, "expires": expires}, fh)
            got = self.real_tokens()["tokens"]["fm_pr1"]
            self.assertEqual(got is not None, want_sample, expires)
        with open(self.sample_file(), "w", encoding="utf-8") as fh:
            fh.write("not json")
        self.assertIsNone(self.real_tokens()["tokens"]["fm_pr1"])

    def test_sample_file_values_are_taken_as_strings_only(self):
        os.makedirs(os.path.dirname(self.sample_file()))
        with open(self.sample_file(), "w", encoding="utf-8") as fh:
            json.dump({"tokens": {"fm_hd": "x", "fm_pr1": 5, "fm_sort": "zzz", "evil": "y"}, "fm_hd_tpl": 3,
                       "expires": time.time() + 60}, fh)
        got = sidebar.read_sample(self.sdir, "p1")
        self.assertEqual(got[0]["fm_hd"], "x")
        self.assertEqual(set(got[0]), set(sidebar.SESSION_KEYS))
        self.assertIsNone(got[0]["fm_pr1"])
        self.assertIsNone(got[1])

    def test_the_daemon_publishes_a_fresh_sample_for_its_pane_with_the_real_sort(self):
        tokens, tpl = sidebar.sample_tokens("mixed", "unicode", 40, "p1")
        os.makedirs(os.path.dirname(self.sample_file()))
        with open(self.sample_file(), "w", encoding="utf-8") as fh:
            json.dump({"tokens": tokens, "fm_hd_tpl": tpl, "expires": time.time() + 60}, fh)
        snap = {"v": 1, "roots": [node("s1", "session", "demo", "working", "working", SYMS["unicode"],
                                       pane="p1", cwd="/x")]}
        reports = []

        def fake(method, params, path=None, timeout=5.0):
            if method == "pane.report_metadata":
                reports.append(params)
            return {"agents": [{"pane_id": "p1", "agent": "pi", "cwd": "/x"}]} if method == "agent.list" else {}

        import argparse
        args = argparse.Namespace(width=40, lead_cells=None, no_view=True)
        old = sidebar.call
        sidebar.call = fake
        try:
            pub = sidebar.Publisher(args, self.sdir)
            pub.publish(snap)
            self.assertEqual(reports[-1]["tokens"], dict(tokens, fm_sort="r001"))
            os.remove(self.sample_file())   # cleared: the next tick restores the real row
            pub.publish(snap)
            self.assertIsNone(reports[-1]["tokens"]["fm_pr1"])
            self.assertIn("demo", reports[-1]["tokens"]["fm_hd"])
            with open(self.sample_file(), "w", encoding="utf-8") as fh:   # expired
                json.dump({"tokens": tokens, "fm_hd_tpl": tpl, "expires": time.time() - 5}, fh)
            pub.publish(snap)
            self.assertIn("demo", reports[-1]["tokens"]["fm_hd"])
        finally:
            sidebar.call = old


class PushClosedChildTest(PushWorld):
    def test_a_child_that_is_not_a_fresh_winner_leaves_no_dangling_bar(self):
        write_child_session(self.adir, "sid-2", "fm-2", "fm-1", "p2")   # its pane is closed
        meta = lambda: json.loads(self.push("--json").stdout)["tokens"]["fm_meta"]  # noqa: E731
        self.assertTrue(meta().startswith(sidebar.CONT_MID), meta())          # no winners.json: its presence pane counts
        with open(os.path.join(self.sdir, "winners.json"), "w", encoding="utf-8") as fh:
            json.dump({"p1": "sid-1"}, fh)
        self.assertTrue(meta().startswith(sidebar.CONT_LAST), meta())         # closed child: no │ under the root
        with open(os.path.join(self.sdir, "winners.json"), "w", encoding="utf-8") as fh:
            json.dump({"p1": "sid-1", "p2": "sid-2"}, fh)
        self.assertTrue(meta().startswith(sidebar.CONT_MID), meta())          # a winner child keeps it


class MixedSourcesTest(PushWorld):
    def test_a_radar_node_with_pr_and_ext_dots_composes_one_ordered_row(self):
        radar_dots = [dot(None, "ok", "deploy", "ext"), dot(21, "run"), dot(17, "fail"), dot(None, "fail", "lint", "ext")]
        g = SYMS["unicode"]
        self.assertEqual(pr_cells(radar_dots, 60),
                         [sidebar.CONT_LAST + g["pr-fail"] + " #17", g["pr-fail"] + " lint", g["pr-run"] + " #21",
                          g["pr-ok"] + " deploy"])

    def test_every_daemon_report_holds_at_most_sixteen_keys(self):
        self.assertEqual(sidebar.MAX_TOKENS, 16)
        chunks = sidebar.split_tokens({"k%d" % i: "v" for i in range(18)})
        self.assertEqual([len(c) for c in chunks], [16, 2])
        self.assertEqual(sidebar.split_tokens({}), [{}])
        reports = []

        def fake(method, params, path=None, timeout=5.0):
            if method == "pane.report_metadata":
                reports.append(params)
            return {"agents": [{"pane_id": "p1", "agent": "pi", "cwd": "/x"}]} if method == "agent.list" else {}

        import argparse
        args = argparse.Namespace(width=40, lead_cells=None, no_view=True)
        snap = {"v": 1, "roots": [dict(node("s1", "session", "demo", "working", "working", SYMS["unicode"],
                                           pane="p1", cwd="/x"), dots=FOUR)]}
        old = sidebar.call
        sidebar.call = fake
        try:
            pub = sidebar.Publisher(args, self.sdir)
            pub.publish(snap)
            pub.publish({"v": 1, "roots": []})   # the pane's keys are cleared: KEYS plus the retired keys
        finally:
            sidebar.call = old
        self.assertGreaterEqual(len(reports), 3)
        for report in reports:
            self.assertLessEqual(len(report["tokens"]), 16, report)
        cleared = {k for r in reports[1:] for k in r["tokens"]}
        self.assertEqual(cleared, set(sidebar.KEYS + sidebar.STALE_KEYS))

    def test_sample_values_pass_through_the_cap(self):
        os.makedirs(os.path.dirname(self.sample_file()))
        long = "x" * 200
        with open(self.sample_file(), "w", encoding="utf-8") as fh:
            json.dump({"tokens": {"fm_hd": long, "fm_meta": "a\u200bb\x07c", "fm_a1": "   ", "fm_a2": 7,
                                  "fm_a3": ["x"]}, "expires": time.time() + 60}, fh)
        got = sidebar.read_sample(self.sdir, "p1")[0]
        self.assertEqual(got["fm_hd"], "x" * (sidebar.MAX_VALUE - 1) + "…")
        self.assertEqual(got["fm_meta"], "abc")
        for key in ("fm_a1", "fm_a2", "fm_a3", "fm_pr1"):
            self.assertIsNone(got[key], key)


class StateCellTest(unittest.TestCase):
    """Round 61: the two-part state cell (spinner + reason icon) of fm_hd."""
    REASONS = {
        "none": {},
        "ask": {"children": lambda: [trun("r", "builder", state="ask", sym="asking")]},
        "review": {"children": lambda: [trun("r", "reviewer")]},
        "agent": {"children": lambda: [trun("r", "builder")]},
        "task": {"tasks": [{"id": "t", "label": "npm test", "pid": 1, "ageSeconds": 5}]},
        "wait": {"waits": [{"id": "w", "kind": "timer", "note": "nap", "age_s": 5, "left_s": 5}]},
    }
    SYMS_ = ("working", "waiting-external", "waiting-owner", "blocked", "idle", "waiting", "done", "lost")
    ANIMATED = {"working": True, "waiting-external": True, "idle": None}   # idle: only with a reason

    def session(self, sym, reason="none", symbols="unicode"):
        extra = {k: v() if callable(v) else v for k, v in self.REASONS[reason].items()}
        return tnode("s", "label", SYMS[symbols][sym], sym, sym, symbols=symbols, **extra)

    def header(self, sym, reason="none", symbols="unicode"):
        """(non-ticking fm_hd, ticking template or None), blanks as spaces."""
        tpl = {}
        snap = {"symbols": symbols, "roots": [self.session(sym, reason, symbols)]}
        hd = sidebar.compose(snap, 40, tpl_out=tpl)["P-s"]["fm_hd"]
        t = tpl.get("P-s")
        return hd.replace(B, " "), t.replace(B, " ") if t else None

    def test_reason_of_each_kind(self):
        for reason in self.REASONS:
            with self.subTest(reason):
                want = None if reason == "none" else reason
                self.assertEqual(sidebar._reason(self.session("working", reason), {}), want)
        self.assertEqual(sidebar._reason(tnode("s", "l", "x", waits=[{"kind": "ci"}]), {}), "task")
        self.assertEqual(sidebar._reason(tnode("s", "l", "x", waits=[{"kind": "pr"}]), {}), "task")
        self.assertEqual(sidebar._reason(tnode("s", "l", "x", waits=[{"kind": "file", "bg": True}]), {}), "task")
        self.assertEqual(sidebar._reason(tnode("s", "l", "x", waits=[{"kind": "pid"}]), {}), "wait")
        self.assertEqual(sidebar._reason(tnode("s", "l", "x", children=[trun("r", "senior-reviewer")]), {}), "review")
        self.assertIsNone(sidebar._reason(tnode("s", "l", "x", children=[trun("r", "builder", state="done", sym="done")]), {}))

    def test_precedence_ask_review_agent_task_wait(self):
        n = tnode("s", "l", "x", children=[trun("a", "builder", state="ask", sym="asking"), trun("b", "reviewer"),
                                           trun("c", "builder")],
                  tasks=[{"id": "t"}], waits=[{"kind": "timer"}])
        seen = []
        while True:
            seen.append(sidebar._reason(n, {}))
            if not n["children"] and not n["tasks"] and not n["waits"]:
                break
            if n["children"]:
                n["children"].pop(0)
            elif n["tasks"]:
                n["tasks"] = []
            else:
                n["waits"] = []
        self.assertEqual(seen, ["ask", "review", "agent", "task", "wait", None])

    def test_paneless_child_session_is_an_agent_only_while_live(self):
        def reason(sym, state):
            kid = tnode("k", "kid", "x", sym, state)
            kid["paneId"] = None
            return sidebar._reason(tnode("s", "l", "x", children=[kid]), {})
        for sym, state in (("working", "working"), ("working", "starting"), ("waiting-external", "working"),
                           ("waiting-owner", "blocked")):
            self.assertEqual(reason(sym, state), "agent", (sym, state))
        for sym, state in (("idle", "idle"), ("waiting", "idle"), ("done", "done"), ("lost", "lost"),
                           ("working", "closed"), ("working", "closing")):
            self.assertIsNone(reason(sym, state), (sym, state))
        # a kid with its own pane row is a row, not an agent
        kid = tnode("k", "kid", "x")
        self.assertIsNone(sidebar._reason(tnode("s", "l", "x", children=[kid]), {"k": "P-k"}))

    def test_animation_decision_per_sym(self):
        for symbols in SYMS:
            icons = sidebar.aux_symbols(symbols)
            for sym in self.SYMS_:
                for reason in self.REASONS:
                    with self.subTest(symbols=symbols, sym=sym, reason=reason):
                        hd, tpl = self.header(sym, reason, symbols)
                        animated = sym in ("working", "waiting-external") or (sym == "idle" and reason != "none")
                        self.assertEqual(tpl is not None, animated)
                        if animated:
                            icon = icons[reason] if reason != "none" else ""
                            self.assertTrue(tpl.startswith("  {spin}" + icon), tpl)

    def test_static_states_keep_their_glyph_whatever_the_reason(self):
        for sym in ("waiting-owner", "blocked", "waiting", "done", "lost"):
            for reason in self.REASONS:
                hd, tpl = self.header(sym, reason)
                self.assertTrue(hd.startswith("  " + SYMS["unicode"][sym]), (sym, reason, hd))
                self.assertIsNone(tpl)
        hd, tpl = self.header("idle")
        self.assertEqual((hd.startswith("  ⏸"), tpl), (True, None))

    def test_non_ticking_header_per_set(self):
        want = {
            "unicode": {"working": "⏳", "waiting-external": "↻◷", "idle": "⏸◷"},   # glyph + icon when both fit 2 cells
            "emoji": {"working": "⏳", "waiting-external": "🔄", "idle": "⏱️"},       # 3 cells: glyph alone; icon alone for idle
            "nerd": {"working": "\uf252\uf017", "waiting-external": "\uf017\uf017", "idle": "\uf04c\uf017"},
            "ascii": {"working": "*~", "waiting-external": "@~", "idle": ".~"},
        }
        for symbols, cases in want.items():
            for sym, cell in cases.items():
                with self.subTest(symbols=symbols, sym=sym):
                    hd, _ = self.header(sym, "wait", symbols)
                    pad = sidebar.slot_width(sidebar.aux_symbols(symbols)) - sidebar.cell_width(cell)
                    self.assertTrue(hd.startswith("  " + cell + " " * pad + " label"), hd)
        # no reason: the glyph alone
        for symbols in SYMS:
            hd, _ = self.header("working", "none", symbols)
            self.assertTrue(hd.startswith("  " + SYMS[symbols]["working"]), hd)

    def test_slot_width_per_set(self):
        self.assertEqual({n: sidebar.slot_width(sidebar.aux_symbols(n)) for n in SYMS},
                         {"unicode": 2, "emoji": 3, "nerd": 2, "ascii": 2})

    def test_label_column_never_moves_within_a_set(self):
        for symbols in SYMS:
            slot = sidebar.slot_width(sidebar.aux_symbols(symbols))
            frame = SYMS[symbols]["spinner"][1]
            for sym in self.SYMS_:
                for reason in self.REASONS:
                    hd, tpl = self.header(sym, reason, symbols)
                    for text in (hd, tpl and tpl.replace("{spin}", frame)):
                        if text is None:
                            continue
                        with self.subTest(symbols=symbols, sym=sym, reason=reason, text=text):
                            self.assertEqual(sidebar.cell_width(text[:text.index(" label") + 1]),
                                             sidebar.DETAIL_INDENT + slot + 1, text)   # indent, slot, space

    def test_pinned_widths_of_the_new_glyphs(self):
        cw = sidebar.cell_width
        self.assertEqual([cw(f) for f in "⣾⣽⣻⢿⡿⣟⣯⣷"], [1] * 8)
        self.assertEqual([cw("◎"), cw("◷"), cw("🔍"), cw("⏱️"), cw("\uf002"), cw("\uf017")], [1, 1, 2, 2, 1, 1])

    def test_sample_reason_all_dry_run_lists_every_reason_and_state_per_set(self):
        res = subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "sample", "--reason", "all", "--dry-run",
                              "--width", "40"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        lines = res.stdout.decode("utf-8").splitlines()
        self.assertEqual([l.split(",")[0] for l in lines if l.startswith("== ")],
                         ["== " + n for n in sidebar.SYMBOL_SETS])
        for i, name in enumerate(sidebar.SYMBOL_SETS):
            block = lines[i * 10 + 1:i * 10 + 10]
            self.assertEqual([l.split()[0] for l in block], list(sidebar.SAMPLE_REASONS), name)
            self.assertTrue(all("r53-sidebar" in l for l in block))
        review = next(l for l in lines if l.startswith("review"))
        self.assertIn("⣻◎ r53-sidebar", review)   # unicode set first: one frame, then the icon
        # one reason alone, a single set
        res = subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "sample", "--reason", "task", "--dry-run",
                              "--symbols", "unicode"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("⣻⚙ r53-sidebar", res.stdout.decode("utf-8"))


class LiveKidsOnAgentLineTest(unittest.TestCase):
    """Round 61 bug 1: child sessions without a pane row show on the agents line only while live."""

    def a1(self, *kids):
        kid_nodes = []
        for i, (sym, state) in enumerate(kids):
            kid = tnode("k%d" % i, "kid%d" % i, "x", sym, state)
            kid["paneId"] = None
            kid_nodes.append(kid)
        parent = tnode("s", "parent", "x", children=kid_nodes)
        out = sidebar.compose({"symbols": "unicode", "roots": [parent]}, 60)["P-s"]["fm_a1"]
        return out and out.replace(B, " ").strip()

    def test_closed_idle_and_stale_kids_leave_the_line(self):
        self.assertIsNone(self.a1(("idle", "idle"), ("working", "closed"), ("waiting", "idle"), ("done", "done"),
                                  ("lost", "lost"), ("working", "closing")))

    def test_live_kids_stay(self):
        for sym, state in (("working", "working"), ("working", "starting"), ("waiting-external", "working"),
                           ("waiting-owner", "blocked")):
            with self.subTest(sym=sym, state=state):
                self.assertIn("kid0", self.a1((sym, state)))

    def test_mix_shows_and_counts_only_live_kids(self):
        kids = [("working", "working"), ("idle", "idle"), ("working", "closed"), ("waiting-external", "working"),
                ("waiting-owner", "blocked"), ("working", "starting"), ("done", "done")]
        line = self.a1(*kids)
        for name in ("kid0", "kid3", "kid4"):
            self.assertIn(name, line)
        for name in ("kid1", "kid2", "kid6"):
            self.assertNotIn(name, line)
        live = [("working", "working"), ("waiting-external", "working")] * 4   # six live names would need +n
        many = self.a1(*(live + [("idle", "idle")] * 3))
        self.assertIn("+%d" % (len(live) - sidebar.MAX_ITEMS), many)


if __name__ == "__main__":
    unittest.main()
