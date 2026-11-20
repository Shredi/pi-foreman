"""scripts/foreman_radar.py: a node carries `restartable` when `foreman session restart` accepts its registry entry and its Pi is not running."""
import datetime
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_radar as fr
import foreman_session as fsn

NOW = 1_800_000_000.0


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def entry(cwd, **over):
    return dict({"label": "kid", "child": "fm-kid-33d451", "handoff": "/h/20261009-115900-kid", "status": "open", "opened": iso(3000),
                 "cwd": cwd, "parent": "fm-parent-1", "hc": {"address": "t52", "parent": "t1"}}, **over)


def build(*regs, live=()):
    data = {"live": list(live), "registry": list(regs), "handoffs": {}, "trace": {}, "usage": {}}
    roots = fr.build(data, NOW)
    flat = []
    def walk(ns):
        for n in ns:
            flat.append(fr.to_json_node(n, NOW, fr.load_symbols()))
            walk(n["children"])
    walk(roots)
    return flat


class Restartable(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = self.tmp.name

    def only(self, *regs, **kw):
        (js,) = build(*regs, **kw)
        return js

    def test_radar_gone_open_entry(self):
        js = self.only(entry(self.cwd, gone=True))
        self.assertEqual(js["state"], "closed")
        self.assertIs(js["restartable"], True)

    def test_prune_closed_entry(self):
        self.assertIs(self.only(entry(self.cwd, status="closed", closedBy="prune"))["restartable"], True)

    def test_entry_pruned_before_the_change_is_known_by_its_note(self):
        self.assertIs(self.only(entry(self.cwd, status="closed", note=fsn.PRUNE_NOTE))["restartable"], True)

    def test_close_flow_closed_entry_is_not(self):
        self.assertNotIn("restartable", self.only(entry(self.cwd, status="closed")))

    def test_missing_cwd_is_not(self):
        self.assertNotIn("restartable", self.only(entry(os.path.join(self.cwd, "nope"), gone=True)))

    def test_remote_machines_own_entry_is_not(self):
        self.assertNotIn("restartable", self.only(entry(self.cwd, gone=True, parent="fm-up-1@alpha")))

    def test_plain_open_young_entry_is_not(self):
        self.assertNotIn("restartable", self.only(entry(self.cwd, opened=iso(5))))

    def test_remote_finished_terminal_is_restartable(self):
        e = entry(self.cwd, machine="alpha", hc={"address": "alpha/t7"}, remoteLive={"state": "lost", "seenAt": iso(10), "address": "alpha/t7"})
        js = self.only(e)
        self.assertEqual(js["state"], "finished")
        self.assertIs(js["restartable"], True)

    def test_remote_live_terminal_is_not(self):
        e = entry(self.cwd, machine="alpha", hc={"address": "alpha/t7"}, remoteLive={"state": "idle", "seenAt": iso(10), "address": "alpha/t7"})
        self.assertNotIn("restartable", self.only(e))

    def test_remote_lost_with_open_entry_is_not(self):
        e = entry(self.cwd, machine="alpha", hc={"address": "alpha/t7"})  # no terminal state seen: lost glyph, entry still open
        js = self.only(e)
        self.assertEqual(js["state"], "lost")
        self.assertNotIn("restartable", js)


if __name__ == "__main__":
    unittest.main()
