"""Replay rig determinism: a rig without its own pressure fixture never samples the live host (SEC-fix-2 G5).

The rig env points PI_FOREMAN_PRESSURE_FIXTURE at an ok host sample, so scripts/foreman_pressure.py classifies
that file instead of the loaded machine; a case that passes its own fixture (test_replay_pressure) overrides it.
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

CONFIG = {"resources": {"sampleSeconds": 5}}


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRigPressureDefault(ReplayCase):
    def test_env_defaults_to_an_ok_host_and_a_case_can_override(self):
        rig = self.rig("pressure-default-env", load_fixture("pressure"), config=CONFIG)
        fx = Path(rig.env()["PI_FOREMAN_PRESSURE_FIXTURE"])
        self.assertTrue(fx.is_file())
        host = json.loads(fx.read_text("utf-8"))
        self.assertLess(host["loadPerCore"], 1.0)
        self.assertEqual(rig.env({"PI_FOREMAN_PRESSURE_FIXTURE": "/x/own.json"})["PI_FOREMAN_PRESSURE_FIXTURE"], "/x/own.json")

    def test_a_rig_without_a_fixture_never_reports_a_non_ok_level(self):
        rig = self.rig("pressure-default-ok", load_fixture("pressure"), config=CONFIG)
        rig.start()
        path = rig.state_dir / "pressure.json"
        deadline = time.time() + 40
        seen = None
        while time.time() < deadline and seen is None:
            try:
                seen = json.loads(path.read_text("utf-8"))
            except (OSError, ValueError):
                time.sleep(0.25)
        self.assertIsNotNone(seen, "the sampler never wrote pressure.json")
        self.assertEqual(seen.get("level"), "ok", seen)


if __name__ == "__main__":
    unittest.main()
