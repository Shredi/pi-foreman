"""Suite guard: point the agent dir at a per-run temp dir before any test runs, so retro/backlog/sync
code that falls back to the default never writes into the real ~/.pi/agent. Imported by every test
module that reaches scripts/ (and by tests/__init__.py)."""
import atexit
import os
import shutil
import tempfile

# A child sandbox or a running session leaks its own settings into the suite (git url rewrites,
# the session model, subagent markers); tests assume a clean environment.
# Only the variables a running session sets are scrubbed; test switches (PI_FOREMAN_LIVE_SMOKE,
# PI_FOREMAN_DOCS_ROOT, PI_FOREMAN_PYTHON, ...) survive.
SESSION_VARS = ("PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_STATE_DIR", "PI_FOREMAN_PARENT_INTERCOM",
                "PI_FOREMAN_PARENT_LABEL", "PI_FOREMAN_SESSION_MODEL", "PI_SUBAGENT_CHILD",
                "PI_SUBAGENT_PARENT_SESSION")
for _k in list(os.environ):
    if (_k.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")) or _k == "GIT_CONFIG_COUNT"
            or _k in SESSION_VARS):
        del os.environ[_k]

if not os.environ.get("PI_FOREMAN_TEST_AGENT_DIR"):
    _dir = tempfile.mkdtemp(prefix="pi_foreman_test_agent_")
    os.environ["PI_FOREMAN_TEST_AGENT_DIR"] = _dir
    os.environ["PI_CODING_AGENT_DIR"] = _dir
    atexit.register(shutil.rmtree, _dir, True)
AGENT_DIR = os.environ["PI_CODING_AGENT_DIR"]
