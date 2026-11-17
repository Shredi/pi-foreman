"""The radar keeps a live record while a pane note (state/panes/<terminal>.json) names its session (restart after a crash), for at most 14 days."""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def iso(ago):
    import datetime
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def record(sid, state="done", hb_ago=3600, ended_by=None, intercom=None):
    d = {"v": 1, "sessionId": sid, "intercomId": intercom or "fm-" + sid, "label": sid, "cwd": "/w", "pid": 1, "mode": "tui",
         "startedAt": iso(hb_ago + 600), "heartbeatAt": iso(hb_ago), "lastEventAt": iso(hb_ago), "state": state, "runs": [],
         "hcTerminal": "t1"}
    if ended_by:
        d["endedBy"] = ended_by
    return d


class PaneNoteKeepsLiveRecord(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.adir = Path(self.tmp) / "agent"
        self.state = self.adir / "pi-foreman" / "state"

    def put(self, d):
        p = self.state / "live" / (d["sessionId"] + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(d), "utf-8")
        return p

    def note(self, sid, terminal="t1"):
        p = self.state / "panes" / (terminal + ".json")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"v": 1, "sessionId": sid, "terminal": terminal}), "utf-8")

    def snap(self, ttl=0.0):
        with mock.patch.object(fr, "pid_dead", return_value=True), mock.patch.object(fr, "herdr_panes", return_value=set()):
            return fr.snapshot(self.adir, NOW, 24.0, None, ttl, closed=fr.provably_closed)

    def test_done_signal_record_named_by_a_note_survives_ttl_zero(self):
        p = self.put(record("s-sig", ended_by="signal"))
        self.note("s-sig")
        self.snap()
        self.assertTrue(p.exists())

    def test_done_signal_record_without_a_note_is_pruned_as_today(self):
        p = self.put(record("s-sig", ended_by="signal"))
        self.snap()
        self.assertFalse(p.exists())

    def test_crash_record_of_a_closed_child_named_by_a_note_survives(self):
        p = self.put(record("s-kid", state="working", intercom="fm-kid-33d451"))
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "sessions.json").write_text(json.dumps({"sessions": [{"status": "closed", "child": "fm-kid-33d451"}]}), "utf-8")
        self.note("s-kid")
        self.snap()
        self.assertTrue(p.exists())

    def test_crash_record_of_a_closed_child_without_a_note_is_pruned(self):
        p = self.put(record("s-kid", state="working", intercom="fm-kid-33d451"))
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "sessions.json").write_text(json.dumps({"sessions": [{"status": "closed", "child": "fm-kid-33d451"}]}), "utf-8")
        self.snap()
        self.assertFalse(p.exists())

    def test_a_note_naming_another_session_keeps_nothing(self):
        p = self.put(record("s-one"))
        self.note("s-other")
        self.snap()
        self.assertFalse(p.exists())

    def test_the_keep_ends_after_fourteen_days(self):
        p = self.put(record("s-old", hb_ago=15 * 86400))
        self.note("s-old")
        self.snap()
        self.assertFalse(p.exists())

    def test_an_unreadable_note_keeps_nothing(self):
        p = self.put(record("s-bad"))
        (self.state / "panes").mkdir(parents=True, exist_ok=True)
        (self.state / "panes" / "t1.json").write_text("{not json", "utf-8")
        self.snap()
        self.assertFalse(p.exists())


if __name__ == "__main__":
    unittest.main()
