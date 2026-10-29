"""Child permissions under the installer baseline (delegation D4): bg_wait and contact_supervisor
run without an ask, `cd` is allowed per part but a child may cd only inside the workspace.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildBaseline(ReplayCase):
    def baseline_rig(self, name):
        rig = self.rig(name, load_fixture("child_baseline"), permissions="baseline",
                       config={"safety": {"permissions": {"projectCommands": ["cargo test*"]}}, "gate": {"childAsk": "parent"}})
        (rig.project / "sub").mkdir()
        return rig

    def test_foreman_bg_wait_allowed(self):
        pi = self.baseline_rig("cb-main").start()
        res = tool_results(pi.prompt("[[replay:f1]] go", timeout=60))
        pi.close()
        self.assertEqual([n for n, _, _ in res], ["bg_wait"])
        self.assertNotIn("permission", res[0][2].lower(), res)

    def test_child_tools_and_cd(self):
        rig = self.baseline_rig("cb-child")
        pi = rig.start()
        sid = pi.session_id()
        pi.prompt("[[replay:b1]] go", timeout=60)
        # item 23: the overlay's cd denies (5) and the single curl ask are retired; the gate sends every one of the
        # seven lines to review (review-allow in the rig). The package's external-directory dialogs the rig still loads are not asserted.
        notice, recs = pi.wait_child_notify(timeout=120, answers=[{"confirmed": False}, {"value": "No"}, {"value": "No"}])
        pi.close()
        self.assertIn("builder child finished", notice)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        gate = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "bash"]
        self.assertEqual([r.get("decision") for r in gate], ["allowed"] * 7, gate)
        sup = [r["decision"] for r in rig.traces()["trace-" + sid] if r.get("event") == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])


if __name__ == "__main__":
    unittest.main()
