import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "bench"))
import test_foreman_bench  # noqa: E402,F401  (stubs the harbor modules)
import wait_session as ws  # noqa: E402
from bench import harbor_agent as ha  # noqa: E402


class DeadPi:
    """A Pi that exits at startup with an error on stderr."""

    def __init__(self, *a, **k):
        self.stderr = ["Error: extension failed to load", "  at startup"]

    def send(self, msg):
        pass

    def _next(self, deadline):
        raise EOFError("pi exited")

    def close(self):
        pass


class BenchStartupTest(unittest.TestCase):
    def test_pi_stderr_is_kept_next_to_rpc_jsonl(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            (tmp / "i.md").write_text("go")
            args = types.SimpleNamespace(out=str(tmp), work=str(tmp), cwd=str(tmp), instruction_file=str(tmp / "i.md"),
                                         cap_seconds=5, quiet_seconds=0)
            status = {}
            with mock.patch.object(ws, "PiRpc", DeadPi):
                ws.drive_rpc(args, {"model": "p/m"}, {"PI_SUBAGENTS_TEMP_ROOT": str(tmp / "s"), "PI_CODING_AGENT_DIR": str(tmp)}, status)
            self.assertEqual(status["status"], "pi_exited")
            self.assertIn("extension failed to load", (tmp / "pi-stderr.log").read_text("utf-8"))

    def test_repo_package_does_not_bring_its_own_subagents_or_intercom(self):
        pkgs = ha._BenchPi.packages(types.SimpleNamespace(KIND="foreman", fake=True))
        repo = [p for p in pkgs if isinstance(p, dict)][0]
        self.assertEqual(repo["source"], ha.R_REPO)
        self.assertEqual(sorted(repo["extensions"]), ["!node_modules/pi-intercom/**", "!node_modules/pi-subagents/**"])
        json.dumps(pkgs)  # lands in settings.json
        self.assertFalse(any("permission" in str(p) for p in pkgs))


if __name__ == "__main__":
    unittest.main()
