"""tests/_isolation.py clears the shared session list (session-env.json, also read by the node preload) and its prefix families."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = json.loads((ROOT / "extensions/core-adapter/test/session-env.json").read_text("utf-8"))
# every key of the shared list plus one name per prefix family, so a key dropped from the JSON fails this test
# PI_CODING_AGENT_DIR is not scrubbed by tests/_isolation.py: its guard sets it to the temp agent dir
SESSION = {k: "x" for k in SHARED["keys"] if k != "PI_CODING_AGENT_DIR"}
SESSION.update({p + "EXTRA": "x" for p in SHARED["prefixes"]})
SESSION["PI_SUBAGENT_EXTENSION_BINDINGS"] = json.dumps({"pi-foreman/1": {"foremanSession": "f", "workspace": "/w"}})
SESSION["PI_SUBAGENT_CHILD"] = "1"
PROBE = "import json, os, tests._isolation; print(json.dumps(sorted(os.environ)))"


class TestSharedSessionScrub(unittest.TestCase):
    def test_shared_session_vars_gone_python_switch_kept(self):
        env = dict(os.environ)
        env.update(SESSION)
        env["PI_FOREMAN_PYTHON"] = sys.executable
        run = subprocess.run([sys.executable, "-c", PROBE], cwd=str(ROOT), env=env, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        left = json.loads(run.stdout)
        for gone in SESSION:
            self.assertNotIn(gone, left)
        for gone in ("PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "HERDR_ENV", "PI_SUBAGENT_EXTENSION_BINDINGS", "PI_SUBAGENT_CHILD"):
            self.assertIn(gone, SESSION)
            self.assertNotIn(gone, left)
        self.assertIn("PI_FOREMAN_PYTHON", left)


if __name__ == "__main__":
    unittest.main()
