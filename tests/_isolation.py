"""Suite guard: point the agent dir at a per-run temp dir before any test runs, so retro/backlog/sync
code that falls back to the default never writes into the real ~/.pi/agent. Imported by every test
module that reaches scripts/ (and by tests/__init__.py)."""
import atexit
import json
import os
import shutil
import tempfile
from pathlib import Path

# A child sandbox or a running session leaks its own settings into the suite (git url rewrites,
# the session model, subagent markers); tests assume a clean environment.
# The session variables and prefix families come from session-env.json, the list the node preload
# also reads. Test switches (PI_FOREMAN_LIVE_SMOKE, PI_FOREMAN_DOCS_ROOT, PI_FOREMAN_PYTHON, ...) survive.
# PI_CODING_AGENT_DIR is not scrubbed here: the guard below sets it.
_SPEC = json.loads((Path(__file__).resolve().parent.parent / "extensions" / "core-adapter" / "test" / "session-env.json").read_text("utf-8"))
SESSION_VARS = tuple(k for k in _SPEC["keys"] if k != "PI_CODING_AGENT_DIR")
SESSION_PREFIXES = tuple(_SPEC["prefixes"])
for _k in list(os.environ):
    if (_k.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", *SESSION_PREFIXES)) or _k == "GIT_CONFIG_COUNT"
            or _k in SESSION_VARS):
        del os.environ[_k]

if not os.environ.get("PI_FOREMAN_TEST_AGENT_DIR"):
    _dir = tempfile.mkdtemp(prefix="pi_foreman_test_agent_")
    os.environ["PI_FOREMAN_TEST_AGENT_DIR"] = _dir
    os.environ["PI_CODING_AGENT_DIR"] = _dir
    atexit.register(shutil.rmtree, _dir, True)
AGENT_DIR = os.environ["PI_CODING_AGENT_DIR"]
