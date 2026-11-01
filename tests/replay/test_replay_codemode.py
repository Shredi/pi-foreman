"""Replay: codemode is allowlisted because every inner call is decided on its own (item 4).

The foreman's codemode script calls read, bash (.git read), bash (an unlisted command) and bash (a
secret read). The script itself needs no approval; each inner call passes through the overlay, the
guards and the permission system like a direct call: the .git and secret reads are denied by the
overlay, the unlisted command is asked by the permission system (and denied without a UI).

Run:  python -m unittest discover -s tests/replay -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


def ends(records):
    return [(r.get("toolName"), r.get("parentToolCallId"), bool(r.get("isError")),
             "\n".join(c.get("text", "") for c in (r.get("result") or {}).get("content") or [] if isinstance(c, dict)))
            for r in records if r.get("type") == "tool_execution_end"]


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestCodemodeInnerCalls(ReplayCase):
    def test_inner_calls_are_decided_individually(self):
        rig = self.rig("codemode", load_fixture("codemode"), permissions="baseline")
        (rig.project / ".env").write_text("TOKEN=not-a-real-secret\n", "utf-8")
        (rig.project / "notes.txt").write_text("hello\n", "utf-8")
        pi = rig.start()
        recs = pi.prompt("[[replay:cm1]] go", timeout=90)
        pi.close()
        dialogs = [str(r.get("title", "")) for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "select"]
        self.assertFalse([d for d in dialogs if "codemode" in d], dialogs)
        self.assertFalse(dialogs, dialogs)  # r79: `uname -s` is routine under mode auto (`mode:no-rule`): no dialog, no classifier call
        res = ends(recs)
        outer = [x for x in res if x[0] == "codemode"]
        inner = [x for x in res if x[1]]
        self.assertEqual(len(outer), 1)
        self.assertFalse(outer[0][2], outer[0][3])
        self.assertEqual([(n, e) for n, _, e, _ in inner], [("read", False), ("bash", True), ("bash", False), ("bash", True)], inner)
        self.assertTrue(all(p == inner[0][1] for _, p, _, _ in inner))
        # `cat .git/config` and the .env read are refused by the gate's secret-path floor; `uname -s` runs as routine
        self.assertIn("floor (secret-path)", inner[1][3])
        self.assertIn(".git/config", inner[1][3])
        self.assertIn("floor (secret-path)", inner[3][3])
        self.assertIn(".env", inner[3][3])
        self.assertNotIn("not-a-real-secret", outer[0][3])
        gate = [r.get("decision") for recs_ in rig.traces().values() for r in recs_ if r.get("event") == "guard" and r.get("guard") == "gate" and r.get("toolFamily") == "bash"]
        self.assertEqual(gate[:3], ["blocked", "allowed", "blocked"], gate)

        # headless (json mode): the script runs, the secret read is still refused
        _, out, _ = rig.run_print("[[replay:cm1]] json", mode="json", timeout=90)
        res = ends(out)
        self.assertFalse([x for x in res if x[0] == "codemode"][0][2])
        self.assertEqual([(n, e) for n, p, e, _ in res if p], [("read", False), ("bash", True), ("bash", False), ("bash", True)])


if __name__ == "__main__":
    unittest.main()
