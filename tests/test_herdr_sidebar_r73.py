"""Round 73: one source for the sidebar state and its spinner, a needs-you state for open asks, a tree rebuilt from persisted records."""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"
sys.path.insert(0, str(PLUGIN))
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _isolation  # noqa: E402,F401
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402
from test_herdr_sidebar import SYMS, node  # noqa: E402

G = dict(SYMS["unicode"], **{"needs-you": "❓"})
NOW = datetime.datetime(2026, 10, 27, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()
BLANK = sidebar.BLANK


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def header(root, children=(), glyphs=G, symbols="unicode", extra=None):
    """(tokens of the root row, header template or None) of one session root on pane w1:p1."""
    root = dict(root, children=list(children), **(extra or {}))
    snap = {"v": 1, "symbols": symbols, "recentRunSeconds": 8, "roots": [root]}
    tpl = {}
    out = sidebar.compose(snap, 40, {root["key"]: "w1:p1"}, tpl_out=tpl)
    return out["w1:p1"], tpl.get("w1:p1")


def session(sym, state="working", **kw):
    n = node("s1", "session", "job", sym, state, G, pane="w1:p1", sid="sid-1")
    n.update(kw)
    n.setdefault("waits", [])
    return n


class SpinnerFollowsStateTest(unittest.TestCase):
    def test_waiting_external_with_nothing_local_is_still(self):
        tokens, tpl = header(session("waiting-external"))
        self.assertIsNone(tpl, "no local work: no spinner")
        self.assertIn(G["waiting-external"], tokens["fm_hd"])
        self.assertEqual(tokens["fm_state"], "waiting-external")

    def test_idle_with_nothing_active_is_still(self):
        tokens, tpl = header(session("idle", "idle"))
        self.assertIsNone(tpl)
        self.assertIn(G["idle"], tokens["fm_hd"])
        self.assertEqual(tokens["fm_state"], "idle")

    def test_working_ticks(self):
        tokens, tpl = header(session("working"))
        self.assertIn("{spin}", tpl)

    def test_idle_session_ticks_for_each_kind_of_own_background_work(self):
        run = node("r1", "run", "builder", "working", "working", G, role="builder")
        live_kid = node("s2", "session", "kid", "working", "working", G, sid="sid-2")
        row_kid = node("s3", "session", "row", "working", "working", G, pane="w1:p3", sid="sid-3")
        ask_run = node("r2", "run", "builder", "asking", "ask", G, role="builder")
        cases = {
            "subagent run": dict(children=[run]),
            "live child without a pane": dict(children=[live_kid]),
            "live child with its own row": dict(children=[row_kid]),
            "forwarded child work": dict(children=[run, ask_run]),
            "bg_run task": dict(extra={"tasks": [{"id": "t1", "label": "build", "ageSeconds": 5}]}),
            "pr_watch": dict(extra={"waits": [{"id": "w", "kind": "pr", "note": "", "prs": [4], "age_s": 1, "left_s": 9}]}),
            "foreman_wait": dict(extra={"waits": [{"id": "w", "kind": "timer", "note": "n", "age_s": 1, "left_s": 9}]}),
            "foreman_bg": dict(extra={"waits": [{"id": "w", "kind": "pid", "note": "n", "bg": True, "age_s": 1, "left_s": 9}]}),
        }
        for name, kw in cases.items():
            for sym in ("idle", "waiting-external"):
                with self.subTest(name, sym=sym):
                    _, tpl = header(session(sym, "idle" if sym == "idle" else "working"), **kw)
                    self.assertIsNotNone(tpl, "ticks: %s" % name)

    def test_state_and_spinner_come_from_the_same_source(self):
        # the header is a template exactly when the state cell animates; both read the one node
        for sym in ("working", "waiting-external", "idle", "waiting", "needs-you", "blocked", "done", "lost"):
            n = session(sym, "done" if sym == "done" else "working")
            tokens, tpl = header(n)
            self.assertEqual(tokens["fm_state"], sym)
            self.assertEqual(tpl is not None, sym == "working", sym)


class NeedsYouHeaderTest(unittest.TestCase):
    def test_needs_you_shows_the_question_mark_not_the_spinner(self):
        run = node("r1", "run", "builder", "working", "working", G, role="builder")
        tokens, tpl = header(session("needs-you"), children=[run])
        self.assertIsNone(tpl)
        self.assertIn("❓", tokens["fm_hd"])
        self.assertEqual(tokens["fm_state"], "needs-you")

    def test_ascii_fallback_is_a_question_mark(self):
        g = dict(SYMS["ascii"], **{"needs-you": "?"})
        n = node("s1", "session", "job", "needs-you", "working", g, pane="w1:p1", sid="s")
        n["waits"] = []
        tokens, tpl = header(n, glyphs=g, symbols="ascii")
        self.assertIsNone(tpl)
        self.assertIn("?", tokens["fm_hd"])

    def test_slot_width_counts_the_needs_you_glyph(self):
        self.assertIn("needs-you", sidebar.STATE_KEYS)
        self.assertEqual(sidebar.aux_symbols("ascii")["needs-you"], "?")
        self.assertEqual(sidebar.aux_symbols("unicode")["needs-you"], "❓")


class World(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = os.path.join(self.tmp, "agent")
        self.live = os.path.join(self.adir, "pi-foreman", "state", "live")
        os.makedirs(self.live)
        self.sdir = os.path.join(self.tmp, "state")
        os.makedirs(self.sdir)

    def put(self, sid, **kw):
        d = {"v": 1, "sessionId": sid, "intercomId": "fm-" + sid, "parentIntercom": None, "handoff": None,
             "label": sid, "cwd": "/x/" + sid, "pid": 1, "paneId": "w1:p1", "startedAt": iso(600),
             "heartbeatAt": iso(1), "lastEventAt": iso(1), "state": "idle", "presence": "idle", "runs": []}
        d.update(kw)
        with open(os.path.join(self.live, sid + ".json"), "w", encoding="utf-8") as fh:
            json.dump(d, fh)

    def push(self, sid="sid-1", pane="w1:p1"):
        radar = sidebar._import_radar()
        args = type("A", (), {"session": sid, "pane": pane, "symbols": "unicode", "agent_dir": self.adir,
                              "width": 40, "lead_cells": None, "dry_run": True})()
        return sidebar.push_compose(radar, args, self.sdir, NOW)

    def run_of(self, state, ended=None):
        return {"launchId": "L1", "role": "builder", "rung": None, "state": state, "tokensIn": 0,
                "tokensOut": 0, "cost": 0, "endedAt": ended}


class NeedsYouSourcesTest(World):
    def test_child_permission_ask_forwarded_to_a_parent_whose_turn_ended(self):
        # the parent is idle (turn ended, no dialog of its own); its child run waits for the owner's answer
        self.put("sid-1", state="idle", presence="idle", runs=[self.run_of("ask")])
        tokens, tpl = self.push()
        self.assertEqual(tokens["fm_state"], "needs-you")
        self.assertIn("❓", tokens["fm_hd"])
        self.assertIsNone(tpl, "needs-you takes precedence over the spinner")
        self.assertIn("ask", tokens["fm_a3"])
        # answered: the child works again, the parent shows the ordinary state
        self.put("sid-1", state="idle", presence="working", runs=[self.run_of("working")])
        tokens, tpl = self.push()
        self.assertNotEqual(tokens["fm_state"], "needs-you")
        self.assertNotIn("❓", tokens["fm_hd"])
        # timed out: the run ended
        self.put("sid-1", state="idle", presence="idle", runs=[self.run_of("done", iso(1))])
        tokens, _ = self.push()
        self.assertNotEqual(tokens["fm_state"], "needs-you")

    def test_own_dialog(self):
        self.put("sid-1", state="blocked", presence="needs-you", blockedSince=iso(5))
        tokens, tpl = self.push()
        self.assertEqual(tokens["fm_state"], "needs-you")
        self.assertIn("❓", tokens["fm_hd"])
        self.assertIsNone(tpl)
        self.put("sid-1", state="idle", presence="idle")
        tokens, _ = self.push()
        self.assertNotEqual(tokens["fm_state"], "needs-you")

    def test_open_ask_file_without_a_ruling(self):
        self.put("sid-1", state="idle", presence="idle", asks=[{"n": 1, "topic": "which way"}])
        tokens, tpl = self.push()
        self.assertEqual(tokens["fm_state"], "needs-you")
        self.assertIn("❓", tokens["fm_hd"])
        self.assertIsNone(tpl)
        self.put("sid-1", state="idle", presence="idle")  # ruling-1.md seen: the presence file lists no ask
        tokens, _ = self.push()
        self.assertNotEqual(tokens["fm_state"], "needs-you")

    def test_a_finished_session_is_never_needs_you(self):
        self.put("sid-1", state="done", presence="done", asks=[{"n": 1, "topic": "t"}])
        tokens, _ = self.push()
        self.assertEqual(tokens["fm_state"], "done")

    def test_radar_symbol_table_has_the_key(self):
        for name, want in (("unicode", "❓"), ("emoji", "❓"), ("ascii", "?")):
            self.assertEqual(fr.load_symbols(name)["needs-you"], want)


class TreeAfterRestartTest(unittest.TestCase):
    def agents(self, pairs):
        return [{"pane_id": pane, "agent": "pi", "cwd": "/gone",
                 "agent_session": {"kind": "path", "value": "/s/2026-10-27T05-41-07-682Z_%s.jsonl" % sid}}
                for pane, sid in pairs]

    def test_four_children_with_changed_pane_ids_join_by_pi_session_id(self):
        kids = [node("k%d" % i, "session", "kid%d" % i, "working", "working", G, pane="w9:old%d" % i,
                     sid="sid-%d" % i, cwd="/same", pid=100 + i) for i in range(4)]
        parent = node("p", "session", "parent", "working", "working", G, pane="w1:p1", sid="sid-p", children=kids,
                      cwd="/same")
        agents = self.agents([("w1:p1", "sid-p")] + [("w1:q%d" % i, "sid-%d" % i) for i in range(4)])
        joins = sidebar.join([parent], agents)
        self.assertEqual(joins, dict({"p": "w1:p1"}, **{"k%d" % i: "w1:q%d" % i for i in range(4)}))
        snap = {"v": 1, "symbols": "unicode", "recentRunSeconds": 8, "roots": [parent]}
        out = sidebar.compose(snap, 40, joins)
        nested = [pane for pane in out if pane != "w1:p1"]
        self.assertEqual(len(nested), 4)
        for pane in nested:
            self.assertRegex(out[pane]["fm_hd"], "[├└]─")
        rows = sidebar.tree_rows([parent], joins)
        self.assertEqual([p["conn"] != "" for _, _, p in rows], [False, True, True, True, True])

    def test_a_live_child_without_a_pane_is_not_a_root_row(self):
        kid = node("k1", "session", "kid", "working", "working", G, sid="sid-1")  # no pane, no join
        parent = node("p", "session", "parent", "idle", "idle", G, pane="w1:p1", sid="sid-p", children=[kid])
        parent["waits"] = []
        snap = {"v": 1, "symbols": "unicode", "recentRunSeconds": 8, "roots": [parent]}
        tpl = {}
        out = sidebar.compose(snap, 40, {"p": "w1:p1"}, tpl_out=tpl)
        self.assertEqual(list(out), ["w1:p1"])
        self.assertIn("kid", out["w1:p1"]["fm_a1"])
        self.assertIn("w1:p1", tpl, "the parent spins while the unjoined live child runs")


class PersistedParentLinksTest(World):
    def put_handoff(self, name, **files):
        h = os.path.join(self.adir, "pi-foreman", "handoffs", name)
        os.makedirs(h, exist_ok=True)
        for fn, text in files.items():
            with open(os.path.join(h, fn), "w", encoding="utf-8") as fh:
                fh.write(text)
        return h

    def write_registry(self, entries):
        with open(os.path.join(self.adir, "pi-foreman", "state", "sessions.json"), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "sessions": entries}, fh)

    def test_children_recorded_under_the_parents_pi_session_id_nest_under_it(self):
        # after a restart the parent's intercom id changed; its Pi session id is what the registry still names
        self.put("sid-p", intercomId="fm-new", paneId="w1:p1")
        entries = []
        for i in range(4):
            h = self.put_handoff("20261027-110000-k%d" % i, child="old-%d\n" % i, parent="sid-p\n")
            entries.append({"label": "k%d" % i, "child": "old-%d" % i, "parent": "sid-p", "status": "open",
                            "opened": "2026-10-27T11:00:00", "handoff": h})
        self.write_registry(entries)
        roots = fr.snapshot(self.adir, NOW, 24.0)
        self.assertEqual([r["name"] for r in roots], ["sid-p"])
        self.assertEqual(len([c for c in roots[0]["children"] if c["kind"] == "session"]), 4)

    def test_registry_child_gets_its_pi_session_id_from_the_handoff_live_json(self):
        self.put("sid-p", paneId="w1:p1")
        h = self.put_handoff("20261027-110000-k0", child="fm-k0\n", parent="fm-sid-p\n",
                             **{"live.json": json.dumps({"intercomId": "fm-k0", "piSessionId": "pi-k0"})})
        self.write_registry([{"label": "k0", "child": "fm-k0", "parent": "fm-sid-p", "status": "open",
                              "opened": "2026-10-27T11:00:00", "handoff": h}])
        roots = fr.snapshot(self.adir, NOW, 24.0)
        (kid,) = [c for c in roots[0]["children"] if c["kind"] == "session"]
        self.assertEqual(kid["sid"], "pi-k0")

    def test_live_count_equals_nested_rows(self):
        # the count herdrmeta shows (registry entries pending/open/closing under the parent) is the number of child sessions
        self.put("sid-p", paneId="w1:p1")
        entries = []
        for i in range(4):
            h = self.put_handoff("20261027-110000-k%d" % i, child="fm-k%d\n" % i, parent="fm-sid-p\n")
            entries.append({"label": "k%d" % i, "child": "fm-k%d" % i, "parent": "fm-sid-p", "status": "open",
                            "opened": "2026-10-27T11:00:00", "handoff": h})
        self.write_registry(entries)
        roots = fr.snapshot(self.adir, NOW, 24.0)
        joins = {roots[0]["key"]: "w1:p1"}
        for i, c in enumerate(c for c in roots[0]["children"] if c["kind"] == "session"):
            joins[c["key"]] = "w1:q%d" % i
        snap = fr.json_doc(roots, NOW, "unicode", fr.load_symbols("unicode"))
        rows = sidebar.tree_rows(snap["roots"], joins)
        self.assertEqual(len(rows) - 1, len(entries))


if __name__ == "__main__":
    unittest.main()
