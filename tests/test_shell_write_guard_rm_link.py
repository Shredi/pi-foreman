"""shell_write_guard.py: plain rm / unlink / rmdir of a symlink is judged on the link (A6). Here a "hit" is a project write
(the foreman guard): removing a link that lives outside the workspace and points into it removes only the link;
`rm -r link`, `rm link/` and a path through the link keep the target's judgement; a link inside the workspace stays a project write.
Decisions over command STRINGS only, nothing is run (the symlinks are created in a temp dir)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import shell_write_guard as swg  # noqa: E402


@unittest.skipIf(os.name == "nt", "symlinks need privileges on Windows")
class RmLinkTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name).resolve()
        self.ws = str(base / "ws")
        self.out = base / "outside"
        (base / "ws" / "sub").mkdir(parents=True)
        self.out.mkdir()
        Path(self.ws, "sub", "f").write_text("x\n")
        os.symlink(self.ws + "/sub/f", str(self.out / "flink"))
        os.symlink(self.ws + "/sub", str(self.out / "dlink"))
        os.symlink(self.ws + "/sub", os.path.join(self.ws, "inlink"))

    def hit(self, line):
        return swg.decide(line, self.ws, self.ws)

    def test_plain_removal_of_an_outside_link_is_no_project_write(self):
        for line in ("rm %s/flink", "rm -f %s/flink", "rm %s/dlink", "unlink %s/flink", "unlink %s/dlink", "rm -f -- %s/dlink", "rmdir %s/dlink"):
            with self.subTest(line=line):
                self.assertIsNone(self.hit(line % self.out))

    def test_recursive_trailing_slash_and_paths_through_the_link_keep_the_target_judgement(self):
        for line in ("rm -r %s/dlink", "rm -rf %s/dlink", "rm -R %s/dlink", "rm %s/dlink/", "rm -f %s/dlink/", "rm %s/dlink/f"):
            with self.subTest(line=line):
                self.assertEqual(self.hit(line % self.out)[0], "delete")

    def test_a_link_inside_the_workspace_and_real_paths_are_unchanged(self):
        self.assertEqual(self.hit("rm inlink")[0], "delete")
        self.assertEqual(self.hit("rm sub/f")[0], "delete")
        self.assertIsNone(self.hit("rm %s/none" % self.out))


if __name__ == "__main__":
    unittest.main()
