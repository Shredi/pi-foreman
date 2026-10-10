"""scripts/foreman_radar.py: the model (load, build tree, render) with a fixed clock, and --once output."""
from __future__ import annotations

import contextlib
import datetime
import io
import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import foreman_radar as fr  # noqa: E402

NOW = datetime.datetime(2026, 10, 9, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def local_iso(ago):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(NOW - ago))


def live(sid, label, intercom, parent=None, state="working", hb=5, last=12, runs=(), handoff=None, started=3600):
    return {"v": 1, "sessionId": sid, "intercomId": intercom, "parentIntercom": parent, "handoff": handoff,
            "label": label, "cwd": "/work/x", "pid": 1, "mode": "tui", "startedAt": iso(started),
            "heartbeatAt": iso(hb), "lastEventAt": iso(last), "state": state, "runs": list(runs)}


def run(launch, role, state="working", rung=None, tin=0, tout=0, cost=0):
    return {"launchId": launch, "role": role, "rung": rung, "state": state, "tokensIn": tin, "tokensOut": tout,
            "cost": cost}


def use(launch, i, o, c, **extra):
    row = {"launchId": launch, "input": i, "cacheRead": 0, "cacheWrite": 0, "output": o, "cost": {"total": c}}
    row.update(extra)
    return row


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.base = self.adir / "pi-foreman"

    def put_live(self, d):
        p = self.base / "state" / "live" / (d["sessionId"] + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d), "utf-8")

    def put_usage(self, sid, rows):
        p = self.base / "state" / "usage" / (sid + ".jsonl")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(json.dumps(r) + "\n" for r in rows), "utf-8")

    def put_registry(self, entries):
        p = self.base / "state" / "sessions.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"version": 1, "sessions": entries}), "utf-8")

    def snap(self, since=24.0):
        return fr.snapshot(self.adir, NOW, since)

    def three_levels(self):
        self.put_live(live("s-top", "top", "fm-top", runs=[run("L1", "builder", rung="strong"),
                                                          run("L2", "reviewer", "ask"), run("L3", "explorer", "done")]))
        self.put_live(live("s-docs", "docs-fix", "fm-docs", parent="fm-top",
                           runs=[run("L4", "builder", tin=10, tout=5, cost=0.5)], started=3000))
        self.put_live(live("s-api", "api", "fm-api", parent="fm-docs", state="blocked", started=2000))
        self.put_usage("s-top", [use("L1", 1000, 100, 0.25), use("L2", 500, 50, 0.25)])
        self.put_usage("s-api", [use(None, 200, 20, 0.25, cacheRead=300, cacheWrite=100)])


class TreeTests(Fixture):
    def test_three_levels_with_runs(self):
        self.three_levels()
        (top,) = self.snap()
        self.assertEqual([c["name"] for c in top["children"]], ["builder/strong", "reviewer", "explorer", "docs-fix"])
        docs = top["children"][3]
        self.assertEqual([c["name"] for c in docs["children"]], ["builder", "api"])
        self.assertEqual([c["glyph"] for c in top["children"][:3]], ["working", "blocked", "idle"])

    def test_subtree_sums(self):
        self.three_levels()
        (top,) = self.snap()
        docs = top["children"][3]
        api = docs["children"][1]
        self.assertEqual(api["tot"], [600, 20, 0.25, 300])  # in = input + cacheRead + cacheWrite, out, cost, uncached
        self.assertEqual(top["own"], [1500, 150, 0.5, 1500])
        self.assertEqual(docs["tot"], [610, 25, 0.75, None])  # live-file run values stand in; uncached unknown
        self.assertEqual(top["tot"], [2110, 175, 1.25, None])

    def test_glyphs(self):
        self.put_live(live("a", "working", "fm-a"))
        self.put_live(live("b", "blocked", "fm-b", state="blocked"))
        self.put_live(live("c", "idle", "fm-c", state="idle"))
        self.put_live(live("d", "stale", "fm-d", hb=200))
        self.put_live(live("e", "fin", "fm-e", state="done", hb=200))
        self.put_registry([
            {"label": "pend", "child": "fm-p", "parent": "", "opened": local_iso(1000), "status": "pending"},
            {"label": "young", "child": "fm-y", "parent": "", "opened": local_iso(30), "status": "open"},
            {"label": "old", "child": "fm-o", "parent": "", "opened": local_iso(600), "status": "open"},
            {"label": "shut", "child": "fm-s", "parent": "", "opened": local_iso(600), "status": "closed"},
        ])
        g = {n["name"]: n["glyph"] for n in self.snap()}
        self.assertEqual(g, {"working": "working", "blocked": "blocked", "idle": "idle", "stale": "lost", "fin": "idle",
                             "pend": "starting", "young": "starting", "old": "lost", "shut": "idle"})

    def test_registry_and_handoff_parent_links(self):
        self.put_live(live("s-top", "top", "fm-top"))
        h = self.base / "handoffs" / "20261009-110000-kid"
        h.mkdir(parents=True)
        (h / "parent").write_text("fm-top\n", "utf-8")
        (h / "child").write_text("fm-kid\n", "utf-8")
        self.put_registry([{"label": "kid", "child": "fm-kid", "parent": "", "opened": local_iso(900), "status": "open",
                            "handoff": "C:\\Users\\x\\pi\\handoffs\\20261009-110000-kid"}])
        self.put_live(live("s-kid", "kid", "fm-kid", hb=3))
        (top,) = self.snap()
        self.assertEqual([c["name"] for c in top["children"]], ["kid"])
        self.assertEqual(fr.leaf("C:\\a\\b\\handoffs\\x\\"), "x")

    def test_since_hides_old_finished_and_lost(self):
        self.put_live(live("a", "fresh", "fm-a", state="done", hb=200, last=600))
        self.put_live(live("b", "old-done", "fm-b", state="done", hb=200, last=3 * 3600))
        self.put_live(live("c", "old-lost", "fm-c", hb=5 * 3600, last=5 * 3600))
        self.put_live(live("d", "old-parent", "fm-d", state="done", hb=200, last=5 * 3600))
        self.put_live(live("e", "kid", "fm-e", parent="fm-d", last=5))
        self.assertEqual(sorted(n["name"] for n in self.snap(since=2)), ["fresh", "old-parent"])
        self.assertEqual(len(self.snap(since=24)), 4)

    def test_corrupt_and_missing_tolerated(self):
        self.assertEqual(self.snap(), [])
        live_dir = self.base / "state" / "live"
        live_dir.mkdir(parents=True)
        (live_dir / "bad.json").write_text("{nope", "utf-8")
        (live_dir / "list.json").write_text("[1]", "utf-8")
        self.put_live(dict(live("ok", "ok", "fm-ok"), runs=["x", {"role": 5, "state": 7}], heartbeatAt="garbage"))
        (self.base / "state" / "sessions.json").write_text("not json", "utf-8")
        (self.base / "state" / "usage").mkdir()
        (self.base / "state" / "usage" / "ok.jsonl").write_text('{"input": 5}\nbroken\n[1]\n', "utf-8")
        (top,) = self.snap()
        self.assertEqual((top["name"], top["glyph"], top["own"][0]), ("ok", "lost", 5))

    def test_usage_cache_reads_appended_lines_only(self):
        self.put_usage("s", [{"launchId": "a", "input": 1, "output": 1}])
        cache = fr.UsageCache()
        path = self.base / "state" / "usage" / "s.jsonl"
        self.assertEqual(cache.read(path)["tot"][0], 1)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"launchId": "a", "input": 2}) + "\n" + '{"input": 9')  # partial last line
        self.assertEqual(cache.read(path)["tot"][0], 3)

    def test_cycle_does_not_hang(self):
        self.put_live(live("a", "a", "fm-a", parent="fm-b"))
        self.put_live(live("b", "b", "fm-b", parent="fm-a"))
        self.assertEqual(len(fr.rows(self.snap())), 2)


class DoneTtlTests(Fixture):
    def path(self, sid):
        return self.base / "state" / "live" / (sid + ".json")

    def snap_ttl(self, ttl=30.0):
        return fr.snapshot(self.adir, NOW, 24.0, None, ttl)

    def test_done_older_than_ttl_hidden_and_file_deleted(self):
        self.put_live(live("a", "gone", "fm-a", state="done", hb=3600, last=3600))
        self.assertEqual(self.snap_ttl(), [])
        self.assertFalse(self.path("a").exists())

    def test_done_inside_ttl_shown_and_kept(self):
        self.put_live(live("a", "recent", "fm-a", state="done", hb=600, last=600))
        self.assertEqual([n["name"] for n in self.snap_ttl()], ["recent"])
        self.assertTrue(self.path("a").exists())

    def test_working_old_with_fresh_heartbeat_kept(self):
        self.put_live(live("a", "long", "fm-a", hb=5, last=10 * 3600, started=11 * 3600))
        (n,) = self.snap_ttl()
        self.assertEqual((n["state"], self.path("a").exists()), ("working", True))

    def test_stale_heartbeat_labelled_not_deleted(self):
        self.put_live(live("a", "quiet", "fm-a", hb=1200, last=1200))
        self.put_live(live("b", "lostish", "fm-b", hb=300, last=300))
        states = {n["name"]: n["state"] for n in self.snap_ttl()}
        self.assertEqual(states, {"quiet": "stale", "lostish": "lost"})
        self.assertTrue(self.path("a").exists())

    def test_blocked_old_kept(self):
        self.put_live(live("a", "wait", "fm-a", state="blocked", hb=5, last=5 * 3600))
        self.assertEqual([n["name"] for n in self.snap_ttl()], ["wait"])
        self.assertTrue(self.path("a").exists())

    def test_unparseable_file_never_deleted(self):
        p = self.path("bad")
        p.parent.mkdir(parents=True)
        p.write_text("{nope", "utf-8")
        self.assertEqual(self.snap_ttl(), [])
        self.assertTrue(p.exists())

    def test_config_key_and_cli_override(self):
        self.assertEqual(fr.config_done_ttl(self.adir), 30.0)
        (self.adir).mkdir(parents=True)
        (self.adir / "foreman.json").write_text(json.dumps({"radar": {"doneTtlMinutes": 5}}), "utf-8")
        self.assertEqual(fr.config_done_ttl(self.adir), 5.0)
        self.put_live(live("a", "old", "fm-a", state="done", hb=3600, last=3600))
        with mock.patch.object(fr.time, "time", return_value=NOW):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                fr.main(["--once", "--agent-dir", str(self.adir), "--done-ttl", "120"])
            self.assertIn(" old ", out.getvalue())
            with contextlib.redirect_stdout(io.StringIO()) as out:
                fr.main(["--once", "--agent-dir", str(self.adir)])
            self.assertIn("no sessions", out.getvalue())


ANSI = __import__("re").compile(r"\x1b\[[0-9;]*m")


class RenderTests(Fixture):
    def lines(self, color=False, **kw):
        return fr.render(self.snap(), NOW, 80, color, **kw)

    def test_render_plain_rows(self):
        self.three_levels()
        text = "\n".join(self.lines())
        self.assertNotIn("\x1b", text)
        self.assertIn("\u23f3 top", text)
        self.assertRegex(text, r"\u270b api +blocked +\d+s +\u2191600 \u219320 \$0\.25")

    def test_header_plain(self):
        self.three_levels()
        l1, l2 = self.lines()[:2]
        self.assertTrue(l1.startswith("pi-foreman radar"))
        self.assertIn("\u23f3 4  \u23f8 0  ? 1  \u270b 1  \u2713 1  \u2717 0", l1)
        self.assertTrue(l1.endswith(time.strftime("%H:%M:%S", time.localtime(NOW))))
        self.assertEqual(fr.cell_width(l1), 80)
        self.assertNotIn("agent", l1)
        self.assertEqual(l2, "3 sessions \u00b7 1 tree \u00b7 \u21912.1k \u2193175 \u00b7 $1.25 \u00b7 oldest block 12s")

    def test_header_without_blocked_omits_oldest_and_plural_trees(self):
        self.put_live(live("a", "a", "fm-a"))
        self.put_live(live("b", "b", "fm-b"))
        l2 = self.lines()[1]
        self.assertEqual(l2, "2 sessions \u00b7 2 trees \u00b7 \u21910 \u21930 \u00b7 $0.00")

    def test_header_color_zero_counts_dim_nonzero_state_color(self):
        self.three_levels()
        l1, l2 = self.lines(color=True)[:2]
        self.assertIn("\x1b[1mpi-foreman radar\x1b[0m", l1)
        self.assertIn("\x1b[32m\u23f3 4\x1b[0m", l1)
        self.assertIn("\x1b[33m\u270b 1\x1b[0m", l1)
        self.assertIn("\x1b[2m\u23f8 0\x1b[0m", l1)
        self.assertIn("\x1b[2m\u2717 0\x1b[0m", l1)
        self.assertEqual(ANSI.sub("", l1), self.lines()[0])
        self.assertIn("\x1b[34m$1.25\x1b[0m", l2)
        self.assertIn("\x1b[33m12s\x1b[0m", l2)

    def test_blocked_age_thresholds(self):
        def age_code(state, secs):
            self.setUp()
            self.put_live(live("a", "a", "fm-a", state=state, last=secs, hb=5))
            row = fr.render(self.snap(), NOW, 80, True)[3]
            return [c for c in ("31", "33") if "\x1b[%sm%4s" % (c, fr.fmt_age(secs)) in row]
        self.assertEqual(age_code("blocked", 240), [])
        self.assertEqual(age_code("blocked", 360), ["33"])
        self.assertEqual(age_code("blocked", 960), ["31"])
        self.assertEqual(age_code("working", 960), [])

    def test_cost_blue_in_rows_and_toggle_hides_it(self):
        self.three_levels()
        self.assertIn("\x1b[34m$0.25\x1b[0m", self.lines(color=True)[-1])
        off = self.lines(show_cost=False)
        self.assertNotIn("$", "\n".join(off))
        self.assertIn("\u2191600 \u219320", "\n".join(off))

    def test_lost_row_dim_with_red_glyph(self):
        self.put_live(live("d", "stale", "fm-d", hb=200))
        row = self.lines(color=True)[3]
        self.assertIn("\x1b[31m\u2717\x1b[0m", row)
        self.assertIn("\x1b[2mstale\x1b[0m", row)
        self.assertIn("\x1b[2mlost     \x1b[0m", row)

    def test_selected_row_is_inverted_band(self):
        self.three_levels()
        lines = fr.render(self.snap(), NOW, 80, True, True, 1)
        self.assertTrue(lines[4].startswith("\x1b[7m") and lines[4].endswith("\x1b[0m"))
        self.assertEqual(fr.cell_width(ANSI.sub("", lines[4])), 80)
        self.assertFalse(lines[3].startswith("\x1b[7m"))
        self.assertNotIn("\x1b", "\n".join(fr.render(self.snap(), NOW, 80, False, True, 1)))

    def test_footer_plain_and_colored(self):
        want = "q quit \u00b7 r refresh \u00b7 c cost on/off \u00b7 \u2191\u2193 select \u00b7 enter show session path"
        self.assertEqual(fr.render_footer(), want)
        col = fr.render_footer(True)
        self.assertEqual(ANSI.sub("", col), want)
        self.assertIn("\x1b[1mq\x1b[0m\x1b[2m quit\x1b[0m\x1b[2m \u00b7 \x1b[0m", col)

    def test_decode_key(self):
        cases = {"q": "quit", "\x03": "quit", "r": "refresh", "c": "cost", "\x1b[A": "up", "\x1b[B": "down",
                 "\r": "enter", "\n": "enter", "\xe0H": "up", "\x00P": "down", "\xe0P": "down", "H": None, "": None}
        for seq, act in cases.items():
            self.assertEqual(fr.decode_key(seq), act, repr(seq))

    def test_node_path_prefers_cwd_and_falls_back(self):
        self.put_live(live("a", "a", "fm-a", handoff="/h/x"))
        (a,) = self.snap()
        self.assertEqual((a["path"], fr.node_path(a)), ("/work/x", "/work/x"))
        self.assertEqual(fr.node_path({"path": ""}), "no path")

    def test_age_and_tokens(self):
        self.assertEqual([fr.fmt_age(x) for x in (12, 240, 7300, 200000, None)], ["12s", "4m", "2h", "2d", "-"])
        self.assertEqual([fr.fmt_tok(x) for x in (5, 1500, 2500000)], ["5", "1.5k", "2.5M"])

    def test_base_name_handles_win32_paths(self):
        self.assertEqual(fr.base_name("C:\\Users\\someone\\.pi\\agent", "win32"), "agent")
        self.assertEqual(fr.base_name("/home/someone/.pi/agent/", "linux"), "agent")

    def test_main_once_prints_plain_snapshot(self):
        self.three_levels()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--once", "--agent-dir", str(self.adir)]), 0)
        text = out.getvalue()
        self.assertNotIn("\x1b", text)
        self.assertIn("docs-fix", text)
        self.assertIn("1 tree", text)
        self.assertIn("q quit", text)
        self.assertNotIn(self.tmp, text)

    def test_main_without_tty_acts_like_once(self):
        out = io.StringIO()  # StringIO.isatty() is False
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir)]), 0)
        self.assertIn("no sessions", out.getvalue())


class JsonTests(Fixture):
    def cli(self, *args, symbols=None):
        if symbols:
            self.adir.mkdir(parents=True, exist_ok=True)
            (self.adir / "foreman.json").write_text(json.dumps({"ui": {"symbols": symbols}}), "utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir)] + list(args)), 0)
        return out.getvalue()

    def test_json_shape_nesting_and_fields(self):
        self.three_levels()
        top = live("s-pres", "pres", "fm-pres", state="blocked", last=40)
        top.update(paneId="w1:p2", tokensIn=70, tokensOut=8, cost=0.125, blockedSince=iso(300), pid=4242)
        self.put_live(top)
        text = self.cli("--json")
        self.assertEqual(len(text.splitlines()), 1)
        d = json.loads(text)
        self.assertEqual((d["v"], d["now"], d["symbols"]), (1, "2026-10-09T12:00:00Z", "unicode"))
        pres = next(r for r in d["roots"] if r["key"] == "fm-pres")
        self.assertEqual((pres["kind"], pres["sym"], pres["glyph"], pres["paneId"], pres["pid"], pres["cwd"]),
                         ("session", "blocked", "\u270b", "w1:p2", 4242, "/work/x"))
        self.assertEqual((pres["blocked_s"], pres["age_s"]), (300, 40))
        self.assertEqual(pres["own"], {"in": 70, "out": 8, "cost": 0.125, "uncached": None})
        top = next(r for r in d["roots"] if r["key"] == "fm-top")
        self.assertEqual(top["done_children"], 1)
        self.assertEqual([c["name"] for c in top["children"]], ["builder/strong", "reviewer", "explorer", "docs-fix"])
        self.assertEqual((top["children"][0]["role"], top["children"][0]["rung"]), ("builder", "strong"))
        ask = top["children"][1]
        self.assertEqual((ask["sym"], ask["blocked_s"], ask["paneId"]), ("asking", 12, None))
        api = top["children"][3]["children"][1]
        self.assertEqual((api["blocked_s"], api["tot"]), (12, {"in": 600, "out": 20, "cost": 0.25, "uncached": 300}))
        self.assertEqual(set(api), {"key", "kind", "name", "role", "rung", "state", "sym", "glyph", "paneId", "pid",
                                    "cwd", "age_s", "blocked_s", "own", "tot", "done_children", "children", "sid"})

    def test_presence_tot_adds_runs_and_subsessions(self):
        top = live("s-p", "p", "fm-p", runs=[run("L1", "builder", tin=10, tout=5, cost=0.5)])
        top.update(tokensIn=100, tokensOut=20, cost=1.0)
        self.put_live(top)
        self.put_live(live("s-c", "c", "fm-c", parent="fm-p", runs=[run("L2", "builder", tin=1, tout=1, cost=0.25)]))
        (root,) = json.loads(self.cli("--json"))["roots"]
        self.assertEqual(root["own"], {"in": 100, "out": 20, "cost": 1.0, "uncached": None})
        self.assertEqual(root["tot"], {"in": 111, "out": 26, "cost": 1.75, "uncached": None})

    def test_uncached_from_usage_file_next_to_presence_totals(self):
        top = live("s-p", "p", "fm-p", runs=[run("L1", "builder", tin=10, tout=5, cost=0.5)])
        top.update(tokensIn=9000, tokensOut=20, cost=1.0)
        self.put_live(top)
        self.put_usage("s-p", [use(None, 100, 10, 0.5, cacheRead=8000, cacheWrite=50),
                               use("L1", 7, 5, 0.5, cacheRead=900, cacheWrite=3)])
        (root,) = json.loads(self.cli("--json"))["roots"]
        self.assertEqual(root["own"]["uncached"], 150)       # fresh input + cache writes, runs excluded
        self.assertEqual(root["tot"]["uncached"], 160)       # every call in the usage file
        self.assertEqual(root["children"][0]["tot"]["uncached"], 10)
        self.assertEqual(root["tot"]["in"], 9000 + 910)      # the raw total stays as before

    def test_run_end_and_recent_seconds_header(self):
        done = run("L1", "builder", "done")
        done["endedAt"] = iso(5)
        self.put_live(live("a", "a", "fm-a", runs=[done, run("L2", "explorer")]))
        d = json.loads(self.cli("--json"))
        self.assertEqual(d["recentRunSeconds"], 8)
        self.assertEqual([c["ended_s"] for c in d["roots"][0]["children"]], [5, None])
        self.assertEqual(d["roots"][0]["sid"], "a")
        (self.adir / "foreman.json").write_text(json.dumps({"radar": {"recentRunSeconds": 3}}), "utf-8")
        self.assertEqual(json.loads(self.cli("--json"))["recentRunSeconds"], 3)

    def test_only_builds_one_subtree_and_reads_its_usage(self):
        self.three_levels()
        self.put_live(live("s-other", "other", "fm-other"))
        reads = []
        cache = fr.UsageCache()
        orig = cache.read
        cache.read = lambda path: reads.append(Path(path).name) or orig(path)
        (docs,) = fr.snapshot(self.adir, NOW, 24.0, cache, only="s-docs")
        self.assertEqual((docs["key"], [c["name"] for c in docs["children"]]), ("fm-docs", ["builder", "api"]))
        self.assertEqual(sorted(reads), ["s-api.jsonl", "s-docs.jsonl"])
        self.assertEqual(fr.snapshot(self.adir, NOW, 24.0, only="missing"), [])

    def test_symbol_sets_from_config_and_no_ansi(self):
        self.put_live(live("a", "a", "fm-a", runs=[run("L1", "builder")]))
        uni = self.cli("--json")
        nerd = self.cli("--json", symbols="nerd")
        self.assertEqual(json.loads(uni)["roots"][0]["glyph"], "\u23f3")
        d = json.loads(nerd)
        self.assertEqual((d["symbols"], d["roots"][0]["glyph"]), ("nerd", "\uf252"))
        self.assertNotIn("\x1b", uni + nerd)
        self.assertIn("\uf252", self.cli("--once", symbols="nerd"))

    def test_follow_emits_one_line_per_tick(self):
        self.put_live(live("a", "a", "fm-a"))
        import subprocess
        r = subprocess.run([sys.executable, "-E", "-s", str(SCRIPTS / "foreman_radar.py"), "--json", "--follow",
                            "--interval", "0", "--max-ticks", "2", "--since", "1000000",  # fixtures use a fixed NOW
                            "--agent-dir", str(self.adir)],
                           capture_output=True, timeout=60, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.decode("utf-8").splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual([json.loads(x)["roots"][0]["key"] for x in lines], ["fm-a", "fm-a"])
        self.assertNotIn(b"\x1b", r.stdout)

    def test_wide_glyphs_align_columns(self):
        self.three_levels()
        self.assertEqual([fr.cell_width(x) for x in ("\u23f3", "\u270b", "?", "a\u0301", "\uf252")], [2, 2, 1, 1, 1])
        rows = self.lines_plain()[3:]
        cols = {fr.cell_width(r[:r.index("working" if "working" in r else "ask" if " ask " in r else "done" if "done" in r else "blocked")]) for r in rows}
        self.assertEqual(len(cols), 1)

    def lines_plain(self):
        return fr.render(self.snap(), NOW, 80)


if __name__ == "__main__":
    unittest.main()
