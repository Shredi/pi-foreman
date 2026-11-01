"""claude-bridge presets: 1 h TTL row, keep-alive on with away ticks, and a sonnet-class idle rung."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402

P = "claude-bridge"
NAMES = ("claude-bridge", "claude-bridge-sonnet-reviewer")


class PresetCacheTest(unittest.TestCase):
    def test_values(self):
        for name in NAMES:
            prov = json.loads((ROOT / "config" / "presets" / (name + ".json")).read_text())["providers"][P]
            self.assertNotIn("byModel", prov["cache"], name)  # the TTL is derived from bridge.promptCacheTtl
            self.assertNotIn("ttlSeconds", prov["cache"], name)  # an explicit value would shadow the derived one
            self.assertEqual(prov["cache"]["keepalive"], {"enabled": True, "awayTicks": 2}, name)
            idle = prov["roles"]["foreman"]["idle"]
            self.assertIn("sonnet", idle["model"], name)
            self.assertEqual(idle["model"], prov["roles"]["explorer"]["model"], name)

    def test_policy(self):
        for name in NAMES:
            preset = json.loads((ROOT / "config" / "presets" / (name + ".json")).read_text())
            pol = fc.warm_policy(preset, P, "claude-opus-5-5", 3600)
            self.assertEqual((pol["ttlSeconds"], pol["enabled"], pol["awayTicks"], pol["selfWarm"]), (3600, True, 2, True), name)

    def test_dry_run_valid(self):
        for name in NAMES:
            with tempfile.TemporaryDirectory() as tmp:
                out, err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    rc = fc.main(["apply-preset", name, "--dry-run", "--agent-dir", tmp])
                self.assertEqual(rc, 0, err.getvalue())
                self.assertEqual(json.loads(out.getvalue())["providers"][P]["roles"]["foreman"]["idle"]["thinking"], "medium")
                self.assertEqual(list(Path(tmp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
