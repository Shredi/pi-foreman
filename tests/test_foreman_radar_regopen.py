"""scripts/foreman_radar.py: a node of a live file whose registry entry is `open` (not gone) carries `regOpen`, also while its
heartbeat is late (the lost glyph); a gone or closed entry sets no flag."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def live(child="fm-kid-33d451", handoff=None, hb_ago=300):
    return {"v": 1, "sessionId": "s-kid", "intercomId": child, "parentIntercom": None, "handoff": handoff, "label": "kid",
            "cwd": "/work/kid", "pid": 71302, "hcTerminal": "t52", "startedAt": iso(3600), "heartbeatAt": iso(hb_ago),
            "lastEventAt": iso(hb_ago), "state": "idle", "runs": []}


def entry(status, child="fm-kid-33d451", handoff="/h/20261009-115900-kid", **over):
    return dict({"label": "kid", "child": child, "handoff": handoff, "status": status, "opened": iso(3000),
                 "hc": {"address": "t52", "parent": "t1m"}}, **over)


def run(lv, reg):
    data = {"live": [lv], "registry": [reg], "handoffs": {}, "trace": {}, "usage": {}}
    (root,) = fr.build(data, NOW)
    return root, fr.to_json_node(root, NOW, fr.load_symbols())


class RegOpen(unittest.TestCase):
    def test_open_entry_with_late_heartbeat_flags_regopen(self):
        root, js = run(live(), entry("open"))
        self.assertEqual(root["glyph"], "lost")
        self.assertIs(js["regOpen"], True)

    def test_open_entry_matched_by_handoff_flags_regopen(self):
        root, js = run(live(child="fm-published-id", handoff="/h/20261009-115900-kid"), entry("open"))
        self.assertEqual(root["glyph"], "lost")
        self.assertIs(js["regOpen"], True)

    def test_gone_entry_sets_no_flag(self):
        _, js = run(live(), entry("open", gone=True))
        self.assertNotIn("regOpen", js)
        self.assertEqual(js["state"], "closed")

    def test_closed_entry_sets_no_flag(self):
        _, js = run(live(), entry("closed"))
        self.assertNotIn("regOpen", js)

    def test_gone_entry_on_merge_path_sets_no_flag(self):
        _, js = run(live(child="fm-published-id", handoff="/h/20261009-115900-kid"), entry("open", gone=True))
        self.assertNotIn("regOpen", js)


class RegOpenRegistryOnly(unittest.TestCase):
    def only(self, reg):
        data = {"live": [], "registry": [reg], "handoffs": {}, "trace": {}, "usage": {}}
        (root,) = fr.build(data, NOW)
        return root, fr.to_json_node(root, NOW, fr.load_symbols())

    def test_open_local_entry_without_live_file_flags_regopen(self):
        root, js = self.only(entry("open"))
        self.assertEqual(root["state"], "lost")
        self.assertIs(js["regOpen"], True)

    def test_gone_registry_only_entry_sets_no_flag(self):
        _, js = self.only(entry("open", gone=True))
        self.assertNotIn("regOpen", js)
        self.assertEqual(js["state"], "closed")

    def test_remote_open_entry_sets_no_flag(self):
        _, js = self.only(entry("open", machine="box"))
        self.assertNotIn("regOpen", js)


if __name__ == "__main__":
    unittest.main()
