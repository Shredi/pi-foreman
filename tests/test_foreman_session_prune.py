"""`foreman session prune`: only open/closing entries with process AND terminal provably gone become closed."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_session as fs  # noqa: E402
import foreman_radar as fr  # noqa: E402

NOW = 1_800_000_000.0


def entry(child, status="open", **over):
    return dict({"label": child, "child": child, "handoff": "/h/" + child, "status": status,
                 "hc": {"address": "t9-" + child, "parent": None}}, **over)


class Prune(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.adir = Path(self.tmp.name) / "agent"
        (self.adir / "pi-foreman" / "state" / "live").mkdir(parents=True)
        self.addCleanup(self.tmp.cleanup)

    def write(self, entries, lives=()):
        fs.write_registry(self.adir, {"sessions": entries})
        for i, d in enumerate(lives):
            (self.adir / "pi-foreman" / "state" / "live" / ("%d.json" % i)).write_text(json.dumps(d), "utf-8")

    def run_prune(self, hc, alive=lambda pid: False, extra=()):
        out = io.StringIO()
        with mock.patch.object(fs, "hc_terminal_addresses", return_value=hc), \
                mock.patch.object(fs, "herdr_pane_ids", return_value=None), \
                mock.patch.object(fs, "process_alive", side_effect=alive), redirect_stdout(out):
            code = fs.main(["prune", "--agent-dir", str(self.adir)] + list(extra))
        self.assertEqual(code, 0)
        return out.getvalue()

    def statuses(self):
        return {s["child"]: s["status"] for s in fs.read_registry(self.adir)["sessions"]}

    def test_gone_entry_is_closed_with_note(self):
        self.write([entry("a")])
        text = self.run_prune(set())
        self.assertEqual(self.statuses(), {"a": "closed"})
        self.assertIn("pruned: process and terminal gone", fs.read_registry(self.adir)["sessions"][0]["note"])
        self.assertIn("1 pruned", text)

    def test_live_process_untouched(self):
        self.write([entry("a")], [{"intercomId": "a", "pid": 4242}])
        self.run_prune(set(), alive=lambda pid: True)
        self.assertEqual(self.statuses(), {"a": "open"})

    def test_terminal_present_untouched(self):
        self.write([entry("a")])
        self.run_prune({"t9-a"})
        self.assertEqual(self.statuses(), {"a": "open"})

    def test_terminal_unknown_untouched(self):
        self.write([entry("a", "closing")])
        self.run_prune(None)
        self.assertEqual(self.statuses(), {"a": "closing"})

    def test_dry_run_writes_nothing(self):
        self.write([entry("a")])
        before = json.dumps(fs.read_registry(self.adir), sort_keys=True)
        text = self.run_prune(set(), extra=["--dry-run"])
        self.assertEqual(json.dumps(fs.read_registry(self.adir), sort_keys=True), before)
        self.assertIn("would prune", text)

    def test_radar_marks_gone_entries(self):
        reg = [entry("a"), entry("b")]
        with mock.patch.object(fr, "hc_terminal_addresses", return_value={"t9-b"}), \
                mock.patch.object(fr, "herdr_panes", return_value=None), \
                mock.patch.object(fs, "process_alive", return_value=False):
            out = fr.mark_gone(reg, [], NOW)
        self.assertEqual([bool(e.get("gone")) for e in out], [True, False])

    def test_mark_gone_skips_pane_listing_without_pane_records(self):
        with mock.patch.object(fr, "hc_terminal_addresses", return_value=set()), \
                mock.patch.object(fr, "herdr_panes") as panes, \
                mock.patch.object(fs, "process_alive", return_value=False):
            fr.mark_gone([entry("a")], [], NOW)
        panes.assert_not_called()

    def test_mark_gone_uses_short_hc_listing_timeout(self):
        with mock.patch.object(fr, "hc_terminal_addresses", return_value=set()) as hc, \
                mock.patch.object(fs, "process_alive", return_value=False):
            fr.mark_gone([entry("a")], [], NOW)
        hc.assert_called_once_with(fr.RADAR_LISTING_TIMEOUT)

    def test_build_renders_gone_entry_as_closed(self):
        e = dict(entry("a"), gone=True, opened="2027-01-15T07:00:00.000Z", parent=None)
        data = {"live": [], "registry": [e], "handoffs": {}, "usage": {}, "trace": {}}
        roots = fr.build(data, NOW)
        nodes = []
        stack = list(roots)
        while stack:
            n = stack.pop()
            nodes.append(n)
            stack.extend(n.get("children", []))
        a = [n for n in nodes if n.get("key") == "a"]
        self.assertEqual(len(a), 1)
        self.assertEqual(a[0]["state"], "closed")
        self.assertEqual(a[0]["glyph"], "idle")


if __name__ == "__main__":
    unittest.main()
