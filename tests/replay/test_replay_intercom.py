"""pi-intercom 0.16.1 through the real permission system and the adapter guard (Phase 4, ledger items 4, 22, 23).

Run:  FOREMAN_REPLAY_CACHE=<dir> python -m unittest discover -s tests/replay -v
Installs pi-intercom into the replay cache on first use. Its broker runs in the rig's agent dir
and stops on its own once no session is connected.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestIntercom(ReplayCase):
    def test_list_allowed_open_pane_and_remote_refused(self):
        rig = self.rig("intercom", load_fixture("intercom"), permissions="baseline", intercom=True)
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:ic1]] go", timeout=90))
        pi.close()
        self.assertEqual([n for n, _, _ in res], ["intercom"] * 4, res)
        status, listed, pane, remote = res
        for _, _, text in (status, listed):
            self.assertNotIn("pi-foreman", text)
            self.assertNotIn("denied by the permission policy", text)
        self.assertFalse(listed[1], listed)
        self.assertIn("Current session", listed[2])
        self.assertTrue(pane[1])
        self.assertIn("launch outside the role allowlist", pane[2])
        self.assertTrue(remote[1])
        self.assertIn("name@machine", remote[2])
        guard = [r.get("decision") for recs in rig.traces().values() for r in recs if r.get("guard") == "intercom"]
        self.assertEqual(guard, ["allowed", "allowed", "blocked", "blocked"])


if __name__ == "__main__":
    unittest.main()
