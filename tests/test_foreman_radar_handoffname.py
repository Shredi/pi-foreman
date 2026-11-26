"""scripts/foreman_radar.py: a session known only from its handoff dir (the first seconds of `foreman session open`: no registry entry, no
live file yet) is named by the handoff label (the dir name's slug), not by the raw intercom id."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_radar as fr

NOW = 1_800_000_000.0


def only(dn, child):
    ho = {"parent": "fm-top-111111", "child": child, "mtime": NOW - 1, "activity": NOW - 1, "path": "/h/" + dn, "piSessionId": None, "has": []}
    data = {"live": [], "registry": [], "handoffs": {dn: ho}, "trace": {}, "usage": {}}
    (root,) = [n for n in fr.build(data, NOW) if n["key"] == child]
    return fr.to_json_node(root, NOW, fr.load_symbols())


class HandoffOnlyName(unittest.TestCase):
    def test_named_by_the_handoff_label(self):
        js = only("20261009-115900-capture-two", "fm-capture-two-0ad045")
        self.assertEqual(js["key"], "fm-capture-two-0ad045")
        self.assertEqual(js["name"], "capture-two")

    def test_dir_without_a_label_keeps_the_id(self):
        js = only("odd-dir", "fm-odd-123456")
        self.assertEqual(js["name"], "fm-odd-123456")


if __name__ == "__main__":
    unittest.main()
