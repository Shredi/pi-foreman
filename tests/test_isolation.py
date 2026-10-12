"""tests/_isolation.py scrubs the running-session variables only; test switches survive."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROBE = "import os, tests._isolation; print(sorted(k for k in os.environ if k.startswith(('PI_FOREMAN_', 'PI_SUBAGENT_', 'GIT_CONFIG_'))))"


class TestIsolationScrub(unittest.TestCase):
    def test_session_vars_gone_switches_survive(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PI_FOREMAN_", "PI_SUBAGENT_", "GIT_CONFIG_"))}
        env.update({
            "PI_FOREMAN_LIVE_SMOKE": "1", "PI_FOREMAN_DOCS_ROOT": "/x",
            "PI_FOREMAN_STATE_DIR": "/s", "PI_FOREMAN_HANDOFF_DIR": "/h", "PI_FOREMAN_PARENT_INTERCOM": "p",
            "PI_FOREMAN_PARENT_LABEL": "l", "PI_FOREMAN_SESSION_MODEL": "m",
            "PI_SUBAGENT_CHILD": "1", "PI_SUBAGENT_PARENT_SESSION": "s",
            "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "k", "GIT_CONFIG_VALUE_0": "v",
        })
        out = subprocess.run([sys.executable, "-c", PROBE], cwd=str(ROOT), env=env, capture_output=True, text=True, check=True).stdout
        left = eval(out)  # a printed list of variable names
        self.assertIn("PI_FOREMAN_LIVE_SMOKE", left)
        self.assertIn("PI_FOREMAN_DOCS_ROOT", left)
        for gone in ("PI_FOREMAN_STATE_DIR", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "PI_FOREMAN_PARENT_LABEL",
                     "PI_FOREMAN_SESSION_MODEL", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_PARENT_SESSION",
                     "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"):
            self.assertNotIn(gone, left)


if __name__ == "__main__":
    unittest.main()
