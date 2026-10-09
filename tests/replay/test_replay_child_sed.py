"""Child bash asks under the baseline plus a deferring review model (frugal-roles D4).

A read-only `cd sub; sed -n ..; sed -n ..` chain runs without any ask; a write command hits
`*: ask`, is forwarded to the foreman, the review model defers, and with no human (`review.headless`)
the child gets a deny that names the allowed forms and the foreman traces `review_defer_headless`.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import PROVIDER_A, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildSed(ReplayCase):
    def test_sed_chain_allowed_and_headless_defer_denied_with_forms(self):
        rig = self.rig("child-sed", load_fixture("child_sed"), permissions="baseline",
                       config={"providers": {PROVIDER_A: {"review": {"model": "%s/review-defer" % PROVIDER_A}}},
                               "review": {"headless": True}})
        sub = rig.project / "sub"
        sub.mkdir()
        (sub / "f.go").write_text("package f\n" * 30, "utf-8")
        (sub / "g.go").write_text("package g\n" * 30, "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIn("sed child finished", notice)
        dialogs = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") in ("select", "confirm")]
        self.assertEqual(dialogs, [], dialogs)
        events = [r for recs_ in rig.traces().values() for r in recs_]
        reviews = [r for r in events if r.get("event") == "review"]
        # only the write command was reviewed; the sed chain never asked
        self.assertEqual([r.get("decision") for r in reviews], ["defer"], reviews)
        headless = [r for r in events if r.get("event") == "review_defer_headless"]
        self.assertEqual(len(headless), 1, headless)
        self.assertEqual(headless[0].get("role"), "builder")
        self.assertIn("touch made.txt", headless[0].get("cmd", ""))
        self.assertFalse((rig.project / "made.txt").exists())
        text = "\n".join(p.read_text("utf-8", "replace") for p in rig.agent.rglob("*.jsonl"))
        self.assertIn("no human is available", text)
        self.assertIn("sed -n", text)


if __name__ == "__main__":
    unittest.main()
