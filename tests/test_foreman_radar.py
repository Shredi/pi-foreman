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
        self.assertEqual(api["tot"], [600, 20, 0.25])  # input + cacheRead + cacheWrite, output, cost.total
        self.assertEqual(top["own"], [1500, 150, 0.5])
        self.assertEqual(docs["tot"], [610, 25, 0.75])  # live-file run values stand in without a usage file
        self.assertEqual(top["tot"], [2110, 175, 1.25])

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


class RenderTests(Fixture):
    def test_render_plain_and_color(self):
        self.three_levels()
        lines = fr.render(self.snap(), NOW, "agent")
        text = "\n".join(lines)
        self.assertNotIn("\x1b", text)
        self.assertIn("agent", lines[0])
        self.assertIn("\u25cf top", text)
        self.assertRegex(text, r"\u25d0 api +blocked +\d+s +\u2191600 \u219320 \$0\.25")
        self.assertIn("\x1b[", "\n".join(fr.render(self.snap(), NOW, "agent", color=True)))

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
        self.assertNotIn(self.tmp, text)

    def test_main_without_tty_acts_like_once(self):
        out = io.StringIO()  # StringIO.isatty() is False
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir)]), 0)
        self.assertIn("no sessions", out.getvalue())


if __name__ == "__main__":
    unittest.main()
