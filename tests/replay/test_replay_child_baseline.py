"""Child permissions under the rules-first gate (delegation D4): bg_wait and contact_supervisor
run without an ask; a routine line (`cd` and a project command) runs under mode auto, a child's write outside its worktree
is refused by the child deny set (`child-write-outside`), and a dangerous line (an unreadable shell form, a network write)
goes to the parent's dialog, which the rig dismisses.
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
        # r79: the gate decides the seven lines, no review call stands in for them: a routine line runs (`mode:no-rule`), a write outside
        # the worktree is refused by the child deny set before any dialog, and a dangerous line (`{ cd "$D"; ls; }`: unbound variable;
        # `curl x`: network) is asked of the parent, whose dialog the rig dismisses. The package's own dialogs the rig still loads are not asserted.
        notice, recs = pi.wait_child_notify(timeout=120, answers=[{"confirmed": False}, {"value": "No"}, {"value": "No"}])
        pi.close()
        self.assertIn("builder child finished", notice)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        gate = [r for r in events if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "bash"]
        self.assertEqual([(r.get("decision"), r.get("rule")) for r in gate], [
            ("allowed", "mode:no-rule"),  # cd sub && cargo test
            ("blocked", "child-write-outside"),  # cd /usr && cargo test
            ("allowed", "mode:no-rule"),  # cd ../.. && ls (a read: only writes outside the worktree are refused)
            ("allowed", "mode:no-rule"),  # cd sub && cd ../.. && ls
            ("blocked", "danger-opaque"),  # { cd "$D"; ls; }: $D is unbound, the line cannot be read exactly
            ("allowed", "mode:no-rule"),  # cd nonexist/deeper; cd ../.. && ls
            ("blocked", "danger-net-write"),  # cd sub && curl x
        ], gate)
        sup = [r["decision"] for r in rig.traces()["trace-" + sid] if r.get("event") == "supervisor_request"]
        self.assertEqual(sup, ["open", "replied"])


if __name__ == "__main__":
    unittest.main()
