"""A local child that never published a live file and whose process and terminal are provably gone is hidden;
a launch still in progress, an unknown terminal listing, a live process and a remote session stay shown."""
import datetime
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import foreman_radar as fr  # noqa: E402
import foreman_session as fs  # noqa: E402

NOW = 1_800_000_000.0


def iso(ago):
    return datetime.datetime.fromtimestamp(NOW - ago, datetime.timezone.utc).isoformat()


def entry(child, status="open", ago=7200, **over):
    return dict({"label": child, "child": child, "handoff": "/h/" + child, "status": status, "opened": iso(ago),
                 "hc": {"address": "t9-" + child, "parent": None}}, **over)


def gone(reg, hc, alive=False, live=()):
    with mock.patch.object(fr, "hc_terminal_addresses", return_value=hc), \
            mock.patch.object(fr, "herdr_panes", return_value=None), \
            mock.patch.object(fs, "process_alive", return_value=alive):
        return [bool(e.get("gone")) for e in fr.mark_gone(reg, list(live), NOW)]


class DeadChild(unittest.TestCase):
    def test_hidden_when_never_registered_and_terminal_unlisted(self):
        self.assertEqual(gone([entry("a")], set()), [True])

    def test_old_pending_launch_is_hidden(self):
        self.assertEqual(gone([entry("a", "pending")], set()), [True])

    def test_recent_pending_launch_is_kept(self):
        self.assertEqual(gone([entry("a", "pending", ago=30)], set()), [False])

    def test_kept_when_terminal_listing_unknown(self):
        self.assertEqual(gone([entry("a")], None), [False])

    def test_kept_when_terminal_listed(self):
        self.assertEqual(gone([entry("a")], {"t9-a"}), [False])

    def test_kept_when_process_alive(self):
        live = [{"intercomId": "a", "pid": 4242}]
        self.assertEqual(gone([entry("a")], set(), alive=True, live=live), [False])

    def test_remote_untouched(self):
        self.assertEqual(gone([entry("a", machine="m1")], set()), [False])


if __name__ == "__main__":
    unittest.main()
