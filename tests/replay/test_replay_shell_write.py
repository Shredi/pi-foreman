"""Replay: the foreman's bash may not write project files at any tier (plan D3, ledger 5, 6, 23).

At trivial and at standard a here-doc / python write into the project is refused before the
shell runs (the files never appear) and traced as `shell_write_refused {kind}` without
command text; a write under `.workflow/` goes through. A builder child's bash write is not
checked by this guard.

Run: python -m unittest discover -s tests/replay -v (same prerequisites as test_replay.py).
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results, trace_of  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

REFUSAL = "shell write into project files refused: use the edit/write tools (measured by the trivial bound) or delegate to a builder"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestShellWriteGuard(ReplayCase):
    def test_foreman_shell_writes_refused_at_trivial_and_standard(self):
        rig = self.rig("shellwrite", load_fixture("shell_write"))
        pi = rig.start()
        trivial = [(n, e) for n, e, _ in tool_results(pi.prompt("[[replay:trivial]] add the test", timeout=60))]
        standard = tool_results(pi.prompt("[[replay:standard]] change the router", timeout=60))
        pi.close()
        self.assertEqual(trivial, [("foreman_triage", False), ("bash", True), ("bash", False)])
        self.assertEqual([(n, e) for n, e, _ in standard], [("foreman_triage", False), ("bash", True)])
        self.assertIn(REFUSAL, standard[1][2])
        self.assertFalse((rig.project / "cors_test.go").exists(), "the trivial-tier here-doc write reached the shell")
        self.assertFalse((rig.project / "router.go").exists(), "the standard-tier write reached the shell")
        self.assertEqual((rig.project / ".workflow" / "notes.md").read_text("utf-8").strip(), "note")
        foreman = trace_of(rig.traces(), "foreman")
        refused = [r for r in foreman if r.get("event") == "shell_write_refused"]
        self.assertEqual([r.get("kind") for r in refused], ["redirect", "python"])
        self.assertNotIn("cors_test", json.dumps(foreman))

    def test_child_builder_bash_write_not_affected(self):
        rig = self.rig("shellwritechild", load_fixture("shell_write"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:child]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("child: write finished", notice)
        self.assertTrue([p for p in rig.root.rglob("built.txt") if p.is_file()], "the builder's bash write did not run")
        child = trace_of(rig.traces(), "child")
        self.assertIsNotNone(child, "adapter did not load in the child")
        self.assertNotIn("shell_write_refused", [r.get("event") for r in child])


if __name__ == "__main__":
    unittest.main()
