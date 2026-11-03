"""Replay: loading pi-foreman prints no extension-package or built-in-replacement warning, and /reload keeps the registered set.

pi-foreman's `tool_search` replaces Pi's built-in `tool-search`; `foreman setup` writes `-builtin:tool-search` into the settings so Pi
leaves the built-in out silently. The rig writes the same entry. Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_replay import REASON, ReplayCase  # noqa: E402

WARNINGS = ("Host-provided extension packages", "was not loaded")


class TestLoadWarnings(ReplayCase):
    def commands(self, pi):
        return sorted((c.get("name"), c.get("source")) for c in pi.request({"type": "get_commands"}, 30).get("commands", []))

    def test_no_load_warnings_and_stable_set_across_reload(self):
        rig = self.rig("load-warn", [], settings={"extensions": ["-builtin:tool-search"]})
        log = rig.root / "frozen.log"
        pi = rig.start(env={"FOREMAN_FAKE_FROZEN": "1", "FOREMAN_FAKE_FROZEN_LOG": str(log)})
        pi.session_id(timeout=90)
        before = self.commands(pi)
        pi.prompt("[[replay:a1]] go", timeout=60)
        pi.prompt("/reload", timeout=60)
        pi.session_id(timeout=90)
        after = self.commands(pi)
        pi.prompt("[[replay:a2]] go", timeout=60)
        pi.close()
        declared = {d["tag"]: d["tools"] for d in (json.loads(l) for l in log.read_text("utf-8").splitlines())}
        self.assertIn("tool_search", declared.get("a1", []), declared)
        self.assertIn("tool_search", declared.get("a2", []), declared)
        self.assertEqual(sorted(declared["a1"]), sorted(declared["a2"]))
        err = "\n".join(pi.stderr)
        for w in WARNINGS:
            self.assertNotIn(w, err, err)
        self.assertTrue(any(name == "foreman" for name, _ in before), before)
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
