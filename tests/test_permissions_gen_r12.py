"""R12 item 6: the setup renderer refuses a doubled `.workflow/.workflow` hub key."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import permissions_gen as pg  # noqa: E402


class DoubledWorkflow(unittest.TestCase):
    def test_setup_renderer_refuses_doubled_workflow(self):
        for hub in ("/a/hub/.workflow", ["/a/hub/.workflow/"]):
            with self.assertRaises(ValueError) as cm:
                pg.hub_read_patterns(hub)
            self.assertIn("hub ROOT, the renderer appends .workflow", str(cm.exception))
        self.assertEqual(pg.hub_read_patterns(["/a/hub"])[:2], ["/a/hub/.workflow", "/a/hub/.workflow/*"])


if __name__ == "__main__":
    unittest.main()
