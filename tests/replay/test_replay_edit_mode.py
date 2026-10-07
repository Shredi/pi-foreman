"""Replay: edit mode (ceremony.foremanEdits, ledger items 1-8, 13, 24) on the fake provider.

Per mode, the foreman triages trivial and then tries: an edit in src/, a write in .workflow/, a
write in the scratch dir (`notes/`, outside .workflow so readonly and scratchpad differ), and the
same two through bash. readonly refuses all but .workflow/, scratchpad also allows the scratch
dir, bounded keeps today's chain (the trivial bound; bash may write .workflow/ only). A refusal in
readonly/scratchpad raises trivial to standard (`triage_escalated {reason: edit_mode}`) and
traces `foreman_edit_refused {mode, kind}`; the finish gate then wants a builder and a reviewer,
which the foreman can still launch (no deadlock). Scratch-only work stays trivial. A scratch dir
that resolves outside the workspace is a config error and is not writable.

Run: python -m unittest discover -s tests/replay -v (same prerequisites as test_replay.py).
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, notifications, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def script(scratch="notes"):
    return json.loads(json.dumps(load_fixture("edit_mode")).replace("{{SCRATCH}}", scratch))


def events(foreman, name):
    return [r for r in foreman if r.get("event") == name]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestEditMode(ReplayCase):
    def run_matrix(self, mode, scratch="notes", setup=None):
        rig = self.rig("edit-" + mode, script(scratch), permissions="baseline",
                       config={"ceremony": {"foremanEdits": mode, "scratchDir": scratch}})
        (rig.project / "src").mkdir()
        (rig.project / "src" / "a.txt").write_text("alpha\n", "utf-8")
        if setup:
            setup(rig)
        pi = rig.start()
        recs = pi.prompt("[[replay:matrix]] go", answers=[{"confirmed": True}] * 4, timeout=90)
        pi.close()
        return rig, recs, tool_results(recs), trace_of(rig.traces(), "foreman")

    def test_readonly(self):
        rig, _, res, foreman = self.run_matrix("readonly")
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", True), ("write", False),
                                                        ("write", True), ("bash", True), ("bash", True)])
        self.assertIn("foreman edits are readonly: delegate to a builder", res[1][2])
        self.assertIn("The tier is now standard", res[1][2])
        self.assertEqual((rig.project / "src" / "a.txt").read_text("utf-8"), "alpha\n")
        self.assertTrue((rig.project / ".workflow" / "n.md").is_file())
        self.assertFalse((rig.project / "notes").exists())
        self.assertFalse((rig.project / "src" / "f").exists())
        self.assertEqual([(r.get("mode"), r.get("kind")) for r in events(foreman, "foreman_edit_refused")],
                         [("readonly", "edit"), ("readonly", "write"), ("readonly", "shell"), ("readonly", "shell")])
        self.assertEqual([r.get("mode") for r in events(foreman, "shell_write_refused")], ["readonly", "readonly"])
        self.assertEqual([(r.get("from"), r.get("to"), r.get("reason")) for r in events(foreman, "triage_escalated")],
                         [("trivial", "standard", "edit_mode")])

    def test_scratchpad(self):
        rig, _, res, foreman = self.run_matrix("scratchpad")
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", True), ("write", False),
                                                        ("write", False), ("bash", True), ("bash", False)])
        self.assertIn("foreman edits are scratchpad: delegate to a builder (scratch: notes", res[1][2])
        self.assertEqual((rig.project / "notes" / "s.md").read_text("utf-8"), "scratch\n")
        self.assertEqual((rig.project / "notes" / "n.md").read_text("utf-8").strip(), "x")
        self.assertFalse((rig.project / "src" / "f").exists())
        self.assertEqual([(r.get("mode"), r.get("kind")) for r in events(foreman, "foreman_edit_refused")],
                         [("scratchpad", "edit"), ("scratchpad", "shell")])
        self.assertEqual([r.get("reason") for r in events(foreman, "triage_escalated")], ["edit_mode"])

    def test_bounded_keeps_the_trivial_bound(self):
        rig, _, res, foreman = self.run_matrix("bounded")
        # the edit passes at trivial; the new scratch file crosses newFiles 0; bash writes .workflow/ only
        self.assertEqual([(n, e) for n, e, _ in res], [("foreman_triage", False), ("edit", False), ("write", False),
                                                        ("write", True), ("bash", True), ("bash", True)])
        self.assertEqual((rig.project / "src" / "a.txt").read_text("utf-8"), "beta\n")
        self.assertFalse((rig.project / "notes" / "s.md").exists())
        self.assertEqual([(r.get("mode"), r.get("kind")) for r in events(foreman, "foreman_edit_refused")],
                         [("bounded", "shell"), ("bounded", "shell")])
        self.assertEqual([r.get("reason") for r in events(foreman, "triage_escalated")], [None])

    def test_scratch_dir_escaping_the_workspace(self):
        def link(rig):
            (rig.root / "outside").mkdir()
            try:
                os.symlink(str(rig.root / "outside"), str(rig.project / "escape"), target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("no symlinks")
        rig, recs, res, _ = self.run_matrix("scratchpad", "escape", link)
        self.assertEqual([(n, e) for n, e, _ in res][3:], [("write", True), ("bash", True), ("bash", True)])
        self.assertTrue(any("ceremony.scratchDir" in n for n in notifications(recs)), notifications(recs))
        self.assertEqual(list((rig.root / "outside").iterdir()), [])

    def test_untriaged_refusal_makes_a_later_trivial_triage_standard(self):
        rig = self.rig("edit-late", script())
        (rig.project / "src").mkdir()
        (rig.project / "src" / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:late]] go", timeout=90))
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in res], [("edit", True), ("foreman_triage", False)])
        self.assertIn("Recorded as standard, not trivial", res[1][2])
        foreman = trace_of(rig.traces(), "foreman")
        self.assertEqual([r.get("tier") for r in events(foreman, "triage")], ["standard"])
        self.assertEqual([r.get("reason") for r in events(foreman, "triage_escalated")], ["edit_mode"])

    def test_escalation_then_builder_and_reviewer_finish(self):
        rig = self.rig("edit-chain", script())
        (rig.project / "src").mkdir()
        (rig.project / "src" / "a.txt").write_text("alpha\n", "utf-8")
        pi = rig.start()
        recs = pi.prompt("[[replay:chain]] go", timeout=90)
        self.assertEqual([(n, e) for n, e, _ in tool_results(recs)],
                         [("foreman_triage", False), ("edit", True), ("write", False), ("subagent", False)], tool_results(recs))
        _, built = pi.wait_child_notify(timeout=180)
        notice, reviewed = pi.wait_child_notify(timeout=180)
        pi.close()
        self.assertIn("verdict: PASS", notice)
        foreman = trace_of(rig.traces(), "foreman")
        self.assertEqual([(r.get("tier"), r.get("missing")) for r in events(foreman, "finish_refused")], [("standard", "builder,reviewer")])
        self.assertEqual(events(foreman, "ceremony_incomplete"), [])

    def test_scratch_only_trivial_work_finishes_without_builder(self):
        rig = self.rig("edit-scratch", script())
        pi = rig.start()
        recs = pi.prompt("[[replay:scratchonly]] draft it", timeout=90)
        pi.close()
        self.assertEqual([(n, e) for n, e, _ in tool_results(recs)], [("foreman_triage", False), ("write", False), ("bash", False)])
        self.assertTrue((rig.project / ".workflow" / "scratch" / "commit-msg.txt").is_file())
        foreman = trace_of(rig.traces(), "foreman")
        for name in ("foreman_edit_refused", "triage_escalated", "finish_refused", "ceremony_incomplete"):
            self.assertEqual(events(foreman, name), [], name)
        self.assertEqual([r.get("tier") for r in events(foreman, "tier")][-1:], ["trivial"])


if __name__ == "__main__":
    unittest.main()
