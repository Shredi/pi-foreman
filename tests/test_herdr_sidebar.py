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
                    self.assertTrue(root["fm_l1"].startswith("› "))
                    self.assertTrue(root["fm_l1"].endswith("6m"))
                    used = (sidebar.INSET + sidebar.LEAD_CELL_W + sidebar.GAP
                            + sidebar.cell_width(root["fm_sym"]) + sidebar.GAP)
                    self.assertEqual(sidebar.cell_width(root["fm_l1"]), width - used - 2)
                    self.assertIn("builder" if width < 26 else "builder strong ×2", root["fm_l2"])
                    self.assertNotIn("explorer", root["fm_l2"])
                    if width < sidebar.NARROW_COST:
                        self.assertIsNone(root["fm_l3"])
                        self.assertIsNone(root["fm_cost"])
                    elif width < sidebar.NARROW_COUNTS:
                        self.assertIsNone(root["fm_l3"])
                        self.assertTrue(root["fm_cost"].startswith("$0.47"))
                    else:
                        self.assertEqual(root["fm_l3"], "↑341k ↓2.3k")
                        self.assertTrue(root["fm_cost"].startswith("$0.47"))
                        self.assertTrue(root["fm_cost"].endswith("✓1"))

    def test_row3_steps_down_below_20(self):
        root = sidebar.compose(snapshot(), 18)["w1:p1"]
        self.assertIsNone(root["fm_l3"])
        self.assertIsNone(root["fm_cost"])

    def test_tree_sort_and_late_blocked(self):
        out = sidebar.compose(snapshot(), 34)
        self.assertNotIn("fm_pre", out["w1:p1"])
        self.assertTrue(out["w1:p1"]["fm_l1"].startswith("› refactor"))
        self.assertTrue(out["w1:p2"]["fm_l1"].startswith("├─ › fix-parser"))
        self.assertTrue(out["w1:p3"]["fm_l1"].startswith("└─ › docs-pass"))
        self.assertEqual(out["w1:p2"]["fm_sym"], "⏳")
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

    def test_lines_fit_budget_and_keep_age(self):
        gap, inset = sidebar.GAP, sidebar.INSET
        for lead in (0, 1, 2):
            for width in (24, 26, 28, 34, 40):
                out = sidebar.compose(snapshot(), width, lead=lead)
                for pane, t in out.items():
                    with self.subTest(lead=lead, width=width, pane=pane):
                        row1 = (inset + lead * (sidebar.LEAD_CELL_W + gap)
                                + sidebar.cell_width(t["fm_sym"]) + gap)
                        self.assertLessEqual(sidebar.cell_width(t["fm_l1"]), width - row1 - 2)
                        self.assertRegex(t["fm_l1"], r" \d+[smhd]$")
                        self.assertLessEqual(sidebar.cell_width(t["fm_l2"]), width - inset)
                        row3 = [v for v in (t["fm_l3"], t["fm_cost"]) if v]
                        cells = sum(sidebar.cell_width(v) for v in row3) + gap * (len(row3) - 1)
                        self.assertLessEqual(cells, width - inset)
        tight = sidebar.compose(snapshot(), 24)["w1:p2"]["fm_l1"]
        self.assertTrue(tight.startswith("├─ › ") and "…" in tight and tight.endswith("12s"), tight)

    def test_lead_precedence(self):
        class A:
            lead_cells = None
        a = A()
        self.assertEqual(sidebar.read_lead(a, {}), 1)
        self.assertEqual(sidebar.read_lead(a, {"HERDR_SIDEBAR_LEAD": "0"}), 0)
        a.lead_cells = 2
        self.assertEqual(sidebar.read_lead(a, {"HERDR_SIDEBAR_LEAD": "0"}), 2)

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
            self.assertEqual(sidebar.read_width(a, {}, os.path.join(tmp, "missing.toml")), 26)
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
        self.assertNotIn("$fm_pre", json.dumps(rows))
        sym_rules = rows[0][0]["rules"]
        self.assertEqual({r["equals"] for r in sym_rules if not r["equals"].endswith("!")}, glyphs)
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
        self.assertTrue(self.wait_for(lambda: any(r["pane_id"] == "p1" and r["tokens"].get("fm_l1")
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
        self.assertIn("fm_l1", json.loads(lines[1])["p1"])
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
