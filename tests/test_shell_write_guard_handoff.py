"""Item 3: the session's own handoff dir is writable for the allow-list names only (shell_write_guard handoff carve-out)."""
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402



class HandoffCarveOut(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-ho-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.ws = os.path.join(base, "ws").replace(os.sep, "/")
        # forward slashes: bash would eat the backslashes of a native Windows path
        self.h = os.path.join(base, "agent", "handoffs", "h1").replace(os.sep, "/")
        os.makedirs(self.ws)
        os.makedirs(os.path.join(self.h, "work"))
        self.owned = [os.path.join(base, "agent", "handoffs")]

    def d(self, cmd, owned=True, handoff=True):
        return swg.decide(cmd, self.ws, self.ws, "bash", None, None, self.owned if owned else None,
                          self.h if handoff else None)

    def test_allowed_names(self):
        for name in ("plan.md", "result.md", "ask.md", "ask-3.md", ".ask", ".seen", ".steer-last-read.json", "work/x/y.txt"):
            with self.subTest(name=name):
                self.assertIsNone(self.d(f"echo x > {self.h}/{name}"))

    def test_variable_spelling(self):
        self.assertIsNone(self.d('echo x > "$PI_FOREMAN_HANDOFF_DIR/result.md"'))
        self.assertIsNone(self.d('cp a.txt "$PI_FOREMAN_HANDOFF_DIR/work/"'))
        self.assertIsNotNone(self.d('echo x > "$PI_FOREMAN_HANDOFF_DIR/ruling.md"'))

    def test_parent_owned_names_refused(self):
        for name in ("brief.md", "ruling-1.md", "steer.md", "close.json", "parent", "child", "other.txt"):
            with self.subTest(name=name):
                self.assertIsNotNone(self.d(f"echo x > {self.h}/{name}"))
                self.assertIsNotNone(self.d(f'echo x > "$PI_FOREMAN_HANDOFF_DIR/{name}"'))

    def test_traversal_and_dest_dir(self):
        self.assertIsNotNone(self.d(f"echo x > {self.h}/work/../ruling.md"))
        self.assertIsNotNone(self.d(f"cp brief.md {self.h}/"))
        self.assertIsNone(self.d(f"cp result.md {self.h}/"))

    def test_mv_rm_ln_of_protected_names(self):
        for cmd in (f"rm {self.h}/brief.md", f"mv a {self.h}/steer.md", f"ln -s x {self.h}/close.json",
                    f"tar -xf a.tar -C {self.h} brief.md"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(self.d(cmd))

    def test_symlink_escape_refused(self):
        outside = os.path.join(os.path.dirname(self.h), "other")
        os.makedirs(outside)
        link = os.path.join(self.h, "work", "lnk")
        real = os.path.realpath

        def fake(p, *a, **k):  # simulate a symlink work/lnk -> outside, on any platform
            p = str(p).replace(os.sep, "/")
            if p == link.replace(os.sep, "/") or p.startswith(link.replace(os.sep, "/") + "/"):
                p = outside + p[len(link):]
            return real(p, *a, **k)

        with mock.patch("os.path.realpath", fake):
            self.assertIsNotNone(self.d(f"echo x > {self.h}/work/lnk/brief.md"))

    def test_handoff_flag_only_when_all_refusals_are_handoff(self):
        hit = self.d(f"echo x > {self.h}/brief.md")
        self.assertTrue(hit.handoff)
        mixed = self.d(f"echo x > {self.h}/brief.md; echo y > {self.ws}/a.py")
        self.assertFalse(mixed.handoff)

    def test_no_handoff_dir_means_todays_rules(self):
        # outside the workspace and no allow dir: not a project write, so nothing is refused (unchanged)
        self.assertIsNone(self.d(f"echo x > {self.h}/work/a", owned=False, handoff=False))


if __name__ == "__main__":
    unittest.main()
