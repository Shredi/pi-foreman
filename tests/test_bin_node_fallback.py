"""bin/foreman: with no `node` on PATH the Node subcommands use the Node recorded in <agent dir>/pi-foreman/state/node-path (written by Pi sessions)."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipIf(sys.platform == "win32", "POSIX launcher")
class NodeFallback(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="pf-nodefb-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bindir = self.tmp / "bin"
        self.bindir.mkdir()
        os.symlink(shutil.which("dirname"), self.bindir / "dirname")  # the launcher's only external command on this path
        self.agent = self.tmp / "agent"

    def fake_node(self):
        d = self.tmp / "nvm" / "bin"
        d.mkdir(parents=True)
        node = d / "node"
        node.write_text('#!/bin/sh\necho "FAKE-NODE $*"\n')
        node.chmod(0o755)
        return node

    def record(self, text):
        f = self.agent / "pi-foreman" / "state" / "node-path"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)

    def run_foreman(self):
        env = {"PATH": str(self.bindir), "HOME": str(self.tmp), "PI_CODING_AGENT_DIR": str(self.agent)}
        return subprocess.run(["/bin/sh", str(ROOT / "bin" / "foreman"), "prs", "poll"], env=env, capture_output=True, text=True, timeout=30)

    def test_recorded_node_runs_prs(self):
        node = self.fake_node()
        self.record(f"{node}\n")
        r = self.run_foreman()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("FAKE-NODE", r.stdout)
        self.assertIn("prs-cli.ts", r.stdout)

    def test_no_record_keeps_the_old_message(self):
        r = self.run_foreman()
        self.assertEqual(r.returncode, 1)
        self.assertIn("foreman prs needs Node >= 22.6", r.stderr)

    def test_record_of_a_missing_file_is_ignored(self):
        self.record(f"{self.tmp}/gone/node\n")
        r = self.run_foreman()
        self.assertEqual(r.returncode, 1)
        self.assertIn("needs Node", r.stderr)

    def test_record_of_a_binary_not_named_node_keeps_the_old_message(self):
        node = self.fake_node()
        other = node.parent / "bun"
        other.write_text('#!/bin/sh\necho "FAKE-BUN"\n')
        other.chmod(0o755)
        node.unlink()
        self.record(f"{other}\n")
        r = self.run_foreman()
        self.assertEqual(r.returncode, 1)
        self.assertIn("foreman prs needs Node >= 22.6", r.stderr)


if __name__ == "__main__":
    unittest.main()
