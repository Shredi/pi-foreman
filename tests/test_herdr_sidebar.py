import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"
sys.path.insert(0, str(PLUGIN))

import sidebar  # noqa: E402

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None

SYMS = {
    "unicode": {"working": "⏳", "waiting": "⏸", "asking": "?", "blocked": "✋", "done": "✓", "lost": "✗"},
    "nerd": {"working": "\uf252", "waiting": "\uf04c", "asking": "\uf128", "blocked": "\uf256",
             "done": "\uf00c", "lost": "\uf00d"},
}


def node(key, kind, name, sym, state, glyphs, pane=None, children=(), role=None, rung=None,
         age=12, blocked=None, tot=(0, 0, 0.0), cwd=None, pid=None):
    kids = list(children)
    return {"key": key, "kind": kind, "name": name, "role": role, "rung": rung, "state": state,
            "sym": sym, "glyph": glyphs[sym], "paneId": pane, "pid": pid, "cwd": cwd,
            "age_s": age, "blocked_s": blocked,
            "own": {"in": 0, "out": 0, "cost": 0.0},
            "tot": {"in": tot[0], "out": tot[1], "cost": tot[2]},
            "done_children": sum(1 for k in kids if k["state"] == "done"), "children": kids}


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


class ComposeTest(unittest.TestCase):
    def test_widths_and_symbol_sets(self):
        for symbols in ("unicode", "nerd"):
            for width in (26, 30, 34, 44):
                with self.subTest(symbols=symbols, width=width):
                    out = sidebar.compose(snapshot(symbols), width)
                    self.assertEqual(set(out), {"w1:p1", "w1:p2", "w1:p3", "w2:p1"})
                    for tokens in out.values():
                        self.assertLessEqual(len(tokens), 16)
                        self.assertEqual(set(tokens), set(sidebar.KEYS))
                        for v in tokens.values():
                            self.assertTrue(v is None or 0 < len(v) <= 80, v)
                    root = out["w1:p1"]
                    self.assertTrue(root["fm_l1"].startswith("› "))
                    self.assertTrue(root["fm_l1"].endswith("6m"))
                    used = sidebar.INSET + sidebar.cell_width(root["fm_sym"]) + sidebar.GAP
                    self.assertEqual(sidebar.cell_width(root["fm_l1"]), width - used)
                    self.assertIn("builder strong ×2", root["fm_l2"])
                    self.assertNotIn("explorer", root["fm_l2"])
                    if width < 28:
                        self.assertIsNone(root["fm_l3"])
                        self.assertIsNone(root["fm_cost"])
                    elif width < 34:
                        self.assertIsNone(root["fm_l3"])
                        self.assertTrue(root["fm_cost"].startswith("$0.47"))
                    else:
                        self.assertEqual(root["fm_l3"], "↑341k ↓2.3k")
                        self.assertTrue(root["fm_cost"].startswith("$0.47"))
                        self.assertTrue(root["fm_cost"].endswith("✓1"))

    def test_tree_sort_and_late_blocked(self):
        out = sidebar.compose(snapshot(), 34)
        self.assertEqual(out["w1:p1"]["fm_pre"], None)
        self.assertEqual(out["w1:p2"]["fm_pre"], "├─")
        self.assertEqual(out["w1:p3"]["fm_pre"], "└─")
        self.assertEqual([out[p]["fm_sort"] for p in ("w1:p1", "w1:p2", "w1:p3", "w2:p1")],
                         ["r001", "r001.c001", "r001.c002", "r002"])
        self.assertTrue(out["w1:p2"]["fm_l2"].startswith("│"))
        self.assertEqual(out["w1:p3"]["fm_sym"], "✋!")
        self.assertEqual(out["w1:p3"]["fm_block_s"], "1000")
        self.assertEqual(out["w1:p3"]["fm_l2"].lstrip(sidebar.BLANK + " "), "no children")
        self.assertIsNone(out["w1:p2"]["fm_block_s"])
        self.assertEqual(out["w2:p1"]["fm_l2"], "done · 1 child")
        self.assertEqual(out["w2:p1"]["fm_state"], "done")
        nerd = sidebar.compose(snapshot("nerd"), 34)
        self.assertEqual(nerd["w1:p3"]["fm_sym"], "\uf256!")

    def test_pane_collision_keeps_live_youngest(self):
        g = SYMS["unicode"]
        snap = snapshot()
        snap["roots"][0]["children"].append(
            node("old1", "session", "old-a", "done", "done", g, pane="w1:p2", age=5))
        snap["roots"].append(node("old2", "session", "old-b", "done", "done", g, pane="w1:p2", age=9))
        snap["roots"].append(node("s5", "session", "older-live", "working", "working", g,
                                  pane="w1:p2", age=500))
        out = sidebar.compose(snap, 34)
        self.assertIn("fix-parser", out["w1:p2"]["fm_l1"])   # live s2 (age 12) wins
        self.assertEqual([out[p]["fm_sort"] for p in ("w1:p1", "w1:p3", "w2:p1")],
                         ["r001", "r001.c002", "r002"])
        self.assertNotIn("old-a", out["w1:p1"]["fm_l2"])
        snap["roots"][0]["children"][3]["state"] = "done"  # s2 done -> live s5 wins
        self.assertIn("older-live", sidebar.compose(snap, 34)["w1:p2"]["fm_l1"])

    def test_done_without_children(self):
        g = SYMS["unicode"]
        snap = {"roots": [node("d", "session", "d", "done", "done", g, pane="w1:p1")]}
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_l2"], "done")

    def test_only_done_runs_and_base_rung(self):
        g = SYMS["unicode"]
        kids = [node("r1", "run", "explorer", "done", "done", g, role="explorer", rung="model")]
        snap = {"roots": [node("s", "session", "s", "waiting", "idle", g, pane="w1:p1", children=kids)]}
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_l2"], "no active children")
        kids = [node("r2", "run", "explorer", "working", "working", g, role="explorer", rung="model")]
        snap = {"roots": [node("s", "session", "s", "working", "working", g, pane="w1:p1", children=kids)]}
        self.assertEqual(sidebar.compose(snap, 34)["w1:p1"]["fm_l2"], g["working"] + " explorer")

    def test_wide_glyph_width(self):
        self.assertEqual(sidebar.cell_width("⏳ ab"), 5)
        self.assertEqual(sidebar.cell_width("\uf252"), 1)


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


class DecisionTest(unittest.TestCase):
    def test_clears(self):
        prev = {"w1:p1": {}, "w1:p2": {}}
        out = sidebar.clears(prev, {"w1:p1": {}})
        self.assertEqual(list(out), ["w1:p2"])
        self.assertTrue(all(v is None for v in out["w1:p2"].values()))
        self.assertEqual(set(out["w1:p2"]), set(sidebar.KEYS))

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
            self.assertEqual(sidebar.read_width(a, {}, os.path.join(tmp, "missing.toml")), 34)
            self.assertEqual(sidebar.read_width(a, {}, cfg), 30)
            self.assertEqual(sidebar.read_width(a, {"HERDR_SIDEBAR_WIDTH": "28"}, cfg), 28)
            a.width = 44
            self.assertEqual(sidebar.read_width(a, {"HERDR_SIDEBAR_WIDTH": "28"}, cfg), 44)
        finally:
            shutil.rmtree(tmp)


class SnippetTest(unittest.TestCase):
    @unittest.skipIf(tomllib is None, "tomllib needs Python 3.11+")
    def test_snippet_parses_within_limits(self):
        with open(PLUGIN / "config-snippet.toml", "rb") as fh:
            cfg = tomllib.load(fh)
        rows = cfg["ui"]["sidebar"]["agents"]["rows_by_agent"]["pi"]
        self.assertLessEqual(len(rows), 16)
        glyphs = set()
        for s in SYMS.values():
            glyphs.update(s.values())
        for row in rows:
            self.assertLessEqual(len(row), 16)
            for cell in row:
                rules = cell.get("rules", []) if isinstance(cell, dict) else []
                self.assertLessEqual(len(rules), 16)
                for r in rules:
                    self.assertTrue(r["equals"].rstrip("!") in glyphs, r)
        sym_file = ROOT / "config" / "symbols.json"
        if sym_file.is_file():
            with open(sym_file, encoding="utf-8") as fh:
                shared = json.load(fh)
            self.assertEqual(shared, SYMS)
        sym_rules = rows[0][1]["rules"]
        self.assertEqual({r["equals"] for r in sym_rules if not r["equals"].endswith("!")}, glyphs)
        with open(PLUGIN / "herdr-plugin.toml", "rb") as fh:
            manifest = tomllib.load(fh)
        self.assertEqual(manifest["id"], "pi-foreman.sidebar")
        self.assertEqual({a["id"] for a in manifest["actions"]}, {"start", "stop", "configure"})


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


if __name__ == "__main__":
    unittest.main()
