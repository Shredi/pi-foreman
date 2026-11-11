"""scripts/foreman_radar.py: a live file that went lost or stale whose registry entry is `closed` makes a closed node, and is
deleted under the rule of a done file (past the TTL, provably closed). A fresh heartbeat wins over the registry."""
import datetime
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def live(state="working", hb_ago=70000):
    return {"v": 1, "sessionId": "s-kid", "intercomId": "fm-kid-33d451", "label": "kid", "cwd": "/work/kid", "pid": 71302,
            "startedAt": iso(80000), "heartbeatAt": iso(hb_ago), "lastEventAt": iso(hb_ago), "state": state, "runs": []}


def entry(status):
    return {"label": "kid", "child": "fm-kid-33d451", "handoff": "/h/20261009-115900-kid", "status": status, "opened": iso(80000)}


def node(lv, reg):
    data = {"live": [lv], "registry": [reg], "handoffs": {}, "trace": {}, "usage": {}}
    (root,) = fr.build(data, NOW)
    return fr.to_json_node(root, NOW, fr.load_symbols())


class ClosedState(unittest.TestCase):
    def test_dead_working_file_with_closed_entry_is_closed(self):
        js = node(live(), entry("closed"))
        self.assertEqual(js["state"], "closed")
        self.assertNotEqual(js["sym"], "waiting")

    def test_open_entry_keeps_the_lost_or_stale_state(self):
        js = node(live(), entry("open"))
        self.assertEqual(js["state"], "stale")

    def test_fresh_heartbeat_wins_over_closed_entry(self):
        js = node(live(hb_ago=10), entry("closed"))
        self.assertEqual(js["state"], "working")


class Prune(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.state = self.adir / "pi-foreman" / "state"

    def put(self, lv, status):
        p = self.state / "live" / "s-kid.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(lv), "utf-8")
        (self.state / "sessions.json").write_text(json.dumps({"sessions": [entry(status)]}), "utf-8")
        return p

    def snap(self, dead=True, panes=()):
        with mock.patch.object(fr, "pid_dead", return_value=dead), mock.patch.object(fr, "herdr_panes", return_value=set(panes)):
            return fr.snapshot(self.adir, NOW, 24.0, None, 30.0, closed=fr.provably_closed)

    def test_dead_file_of_closed_session_is_deleted_when_provably_closed(self):
        p = self.put(live(), "closed")
        self.snap()
        self.assertFalse(p.exists())

    def test_kept_when_the_closed_predicate_fails(self):
        p = self.put(live(), "closed")
        self.snap(dead=False)
        self.assertTrue(p.exists())

    def test_kept_within_the_ttl(self):
        p = self.put(live(hb_ago=600), "closed")
        self.snap()
        self.assertTrue(p.exists())

    def test_kept_when_the_entry_is_open(self):
        p = self.put(live(), "open")
        self.snap()
        self.assertTrue(p.exists())

    def test_closed_entry_without_child_never_matches_a_null_intercom_id(self):
        lv = live()
        lv["intercomId"] = None
        p = self.put(lv, "closed")
        reg = json.loads((self.state / "sessions.json").read_text("utf-8"))
        del reg["sessions"][0]["child"]
        del reg["sessions"][0]["handoff"]
        (self.state / "sessions.json").write_text(json.dumps(reg), "utf-8")
        self.snap()
        self.assertTrue(p.exists())

    def test_done_file_is_pruned_as_before(self):
        p = self.put(live(state="done", hb_ago=3600), "open")
        self.snap()
        self.assertFalse(p.exists())


if __name__ == "__main__":
    unittest.main()
