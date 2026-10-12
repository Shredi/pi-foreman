"""Ledger item 3: a pi child in another Herdr workspace than its Claude parent still gets its row (label and state icon).

The `agent.list` (herdr pane list) entries use the R3 shape with generic paths: the parent Claude pane in workspace
w3 (`agent: "claude"`), the pi child pane in workspace w7 with `display_agent` "claude › round-x" and an
`agent_session` path. The child's presence file names its pane. The test runs the real radar snapshot, its JSON
document, the sidebar join and compose. Temp dirs only; nothing is spawned and no socket is opened.
"""
from __future__ import annotations

import datetime
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "integrations" / "herdr" / "pi-foreman-sidebar"))
import foreman_radar as fr  # noqa: E402
import sidebar  # noqa: E402

NOW = datetime.datetime(2026, 10, 9, 12, 0, 0, tzinfo=datetime.timezone.utc).timestamp()
WIDTH = 26


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def presence(sid, label, intercom, pane, parent=None, cwd="/work/proj", pid=1):
    return {"v": 1, "sessionId": sid, "intercomId": intercom, "parentIntercom": parent, "handoff": None,
            "label": label, "cwd": cwd, "pid": pid, "mode": "tui", "startedAt": iso(3600),
            "heartbeatAt": iso(5), "lastEventAt": iso(12), "state": "working", "runs": [], "paneId": pane}


class CrossWorkspaceChildRowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.live = self.adir / "pi-foreman" / "state" / "live"
        self.live.mkdir(parents=True)

    def put_live(self, d):
        (self.live / (d["sessionId"] + ".json")).write_text(json.dumps(d), "utf-8")

    def test_cross_workspace_child_row_has_label_and_icon(self):
        self.put_live(presence("s-top", "refactor", "fm-top", "w3:p1"))
        self.put_live(presence("s-kid", "round-x", "fm-kid", "w7:p2", parent="fm-top",
                               cwd="/work/proj.worktrees/round-x", pid=202))
        agents = [
            {"pane_id": "w3:p1", "workspace_id": "w3", "agent": "claude", "display_agent": "claude",
             "cwd": "/work/proj", "agent_session": "/agents/claude/main.jsonl"},
            {"pane_id": "w7:p2", "workspace_id": "w7", "agent": "pi", "display_agent": "claude › round-x",
             "cwd": "/work/proj.worktrees/round-x", "agent_session": "/agents/pi/child.jsonl"},
        ]
        # the radar's JSON document, as the sidebar reads it from the wire
        snap = json.loads(json.dumps(fr.json_doc(fr.snapshot(self.adir, NOW, 24.0), NOW, "unicode",
                                                 fr.load_symbols("unicode"))))
        joins = sidebar.join(snap["roots"], agents)
        self.assertEqual(sorted(joins.values()), ["w3:p1", "w7:p2"])
        out = sidebar.compose(snap, WIDTH, joins)
        child = out["w7:p2"]
        # the label: the child's row 1 names it under the tree prefix
        self.assertIsNotNone(child["fm_l1"])
        self.assertTrue(child["fm_l1"].endswith("› round-x") or "› round-x " in child["fm_l1"], child["fm_l1"])
        self.assertLessEqual(sidebar.cell_width(child["fm_l1"]), WIDTH - sidebar.INSET - sidebar.STATE_ICON_W)
        # the icon: a working child shows the static working glyph in fm_sym (lane 7g) and fm_state carries the state
        self.assertEqual(child["fm_state"], "working")
        self.assertEqual(child["fm_sym"], "⏳")

    def _stale_setup(self, kid_pane):
        # an ended session of an earlier round left its presence file (pid gone, state done, hours old: inside the radar window) naming the pane id
        # Herdr has since handed to the live child
        gone = presence("s-old", "round-old", "fm-old", "w7:p2", parent="fm-top", cwd="/work/proj.worktrees/round-x", pid=999)
        gone.update({"state": "done", "heartbeatAt": iso(2 * 3600), "lastEventAt": iso(2 * 3600), "startedAt": iso(5 * 3600)})
        self.put_live(gone)
        self.put_live(presence("s-top", "refactor", "fm-top", "w3:p1"))
        self.put_live(presence("s-kid", "round-x", "fm-kid", kid_pane, parent="fm-top", cwd="/work/proj.worktrees/round-x", pid=202))
        agents = [
            {"pane_id": "w3:p1", "workspace_id": "w3", "agent": "claude", "display_agent": "claude", "cwd": "/work/proj"},
            {"pane_id": "w7:p2", "workspace_id": "w7", "agent": "pi", "display_agent": "claude › round-x", "cwd": "/work/proj.worktrees/round-x"},
        ]
        snap = json.loads(json.dumps(fr.json_doc(fr.snapshot(self.adir, NOW, 24.0), NOW, "unicode", fr.load_symbols("unicode"))))
        return snap, agents

    def test_stale_presence_with_reused_pane_id_does_not_blank_child_row(self):
        # the live child's presence file has no pane id yet; its pid is the pane's foreground pid
        snap, agents = self._stale_setup(None)
        joins = sidebar.join(snap["roots"], agents, {"w7:p2": 202})
        out = sidebar.compose(snap, WIDTH, joins)
        child = out["w7:p2"]
        self.assertIn("› round-x", child["fm_l1"] or "")
        self.assertEqual(child["fm_state"], "working")
        # the live file also wins when both name the pane
        snap, agents = self._stale_setup("w7:p2")
        out = sidebar.compose(snap, WIDTH, sidebar.join(snap["roots"], agents))
        self.assertIn("› round-x", out["w7:p2"]["fm_l1"] or "")
        self.assertEqual(out["w7:p2"]["fm_state"], "working")

    def test_finished_session_does_not_join_pi_pane_when_live_child_has_no_pane_or_pid(self):
        # the live child has neither a pane id nor a Herdr pid (proc=None, kidpane=None): the finished session's presence
        # still names the reused pane id, and the pane has no agent_session naming that session, so it stays unjoined
        snap, agents = self._stale_setup(None)
        joins = sidebar.join(snap["roots"], agents)
        old = [n for n in sidebar.walk(snap["roots"]) if n.get("sid") == "s-old"][0]
        kid = [n for n in sidebar.walk(snap["roots"]) if n.get("sid") == "s-kid"][0]
        self.assertNotIn(old["key"], joins)
        self.assertEqual(joins.get(kid["key"]), "w7:p2")
        self.assertEqual(sidebar.compose(snap, WIDTH, joins)["w7:p2"]["fm_state"], "working")
        # a pane whose agent_session names the finished session is its own and joins
        agents[1]["agent_session"] = "/agents/pi/s-old.jsonl"
        joins = sidebar.join(snap["roots"], agents)
        self.assertEqual(joins.get(old["key"]), "w7:p2")
        # a pane naming a different live session never takes it
        agents[1]["agent_session"] = "/agents/pi/s-kid.jsonl"
        self.assertNotIn(old["key"], sidebar.join(snap["roots"], agents))


if __name__ == "__main__":
    unittest.main()
