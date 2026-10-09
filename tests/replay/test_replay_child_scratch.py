"""Replay: programmatic child scratch (retro-harvest item 5).

A builder launch gets <TMPDIR>/pi-foreman-scratch/<session>/<launch> as $FOREMAN_SCRATCH. Its
`cp notes.txt $FOREMAN_SCRATCH/copy.txt` is asked by the permission system (cp is not
allowlisted), forwarded to the foreman and allowed by the review link without a model call
(`child-scratch`). When the run ends the foreman traces `child_scratch` and the dir is gone.

Run:  FOREMAN_REPLAY_CACHE=<dir> python -m unittest discover -s tests/replay -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, tool_results  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildScratch(ReplayCase):
    def test_scratch_write_allowed_then_removed_at_run_end(self):
        rig = self.rig("scratch", load_fixture("child_scratch"), permissions="baseline", config={"review": {"headless": True}})
        (rig.project / "notes.txt").write_text("hello\n", "utf-8")
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:s1]] go", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=120)
        self.assertIn("child: scratch used", notice)
        traces = rig.wait_trace(lambda t: any(r.get("event") == "child_scratch" for r in t.get("trace-" + sid, [])), timeout=30)
        pi.close()
        foreman = traces["trace-" + sid]
        reviews = [r for r in foreman if r.get("event") == "review"]
        self.assertTrue(any(r.get("decision") == "child-scratch" for r in reviews), reviews)
        [done] = [r for r in foreman if r.get("event") == "child_scratch"]
        self.assertEqual((done.get("role"), done.get("files"), done.get("bytes"), done.get("action")), ("builder", 1, 6, "removed"))
        root = rig.tmp / "pi-foreman-scratch"
        self.assertTrue(root.is_dir())
        self.assertEqual([p for p in root.rglob("*") if p.is_file()], [])


if __name__ == "__main__":
    unittest.main()
