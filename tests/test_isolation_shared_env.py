"""tests/_isolation.py clears the shared session list (session-env.json, also read by the node preload) and its prefix families."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SESSION = {"PI_SUBAGENT_CHILD": "1", "PI_SUBAGENT_EXTENSION_BINDINGS": json.dumps({"pi-foreman/1": {"foremanSession": "f", "workspace": "/w"}}),
           "PI_FOREMAN_PARENT_LABEL": "l", "PI_FOREMAN_PRESSURE_FIXTURE": "/p", "PI_INTERCOM_STABLE_ID": "fm-x",
           "PI_FOREMAN_PLAN_PHASE": "1", "HERDR_PANE_ID": "w1:p1", "HC_SESSION": "hc"}
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
        self.assertIn("PI_FOREMAN_PYTHON", left)


if __name__ == "__main__":
    unittest.main()
