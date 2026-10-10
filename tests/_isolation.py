"""Suite guard: point the agent dir at a per-run temp dir before any test runs, so retro/backlog/sync
code that falls back to the default never writes into the real ~/.pi/agent. Imported by every test
module that reaches scripts/ (and by tests/__init__.py)."""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("PI_FOREMAN_TEST_AGENT_DIR"):
    _dir = tempfile.mkdtemp(prefix="pi_foreman_test_agent_")
    os.environ["PI_FOREMAN_TEST_AGENT_DIR"] = _dir
    os.environ["PI_CODING_AGENT_DIR"] = _dir
    atexit.register(shutil.rmtree, _dir, True)
AGENT_DIR = os.environ["PI_CODING_AGENT_DIR"]
