"""R13 leftover (e): the permissions renderer refuses a doubled `.workflow` hub key with one clean line, not a traceback."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "permissions_gen.py"


class RenderRefusalIsOneLine(unittest.TestCase):
    def test_render_refusal_prints_one_line_and_exits_2(self):
        with tempfile.TemporaryDirectory() as agent:
            Path(agent, "foreman.json").write_text(json.dumps({"paths": {"hubWorkflow": "/a/hub/.workflow"}}))
            proc = subprocess.run([sys.executable, str(SCRIPT), "render", "--agent-dir", agent], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertEqual(proc.stdout, "")
        self.assertEqual(proc.stderr, "paths.hubWorkflow /a/hub/.workflow ends in .workflow: hub ROOT, the renderer appends .workflow\n")
        self.assertNotIn("Traceback", proc.stderr)


if __name__ == "__main__":
    unittest.main()
