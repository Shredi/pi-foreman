"""Item 3 / item 8: the handoff carve-out on Windows path flavours, emulated with ntpath on any host
(same fake-os pattern as test_shell_write_guard.test_windows_path_flavour)."""
import ntpath
import os
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402

WS = "C:\\Users\\u\\proj"
H = "C:\\Users\\u\\.pi\\agent\\handoffs\\h1"
HF = H.replace("\\", "/")
OWNED = ["C:\\Users\\u\\.pi\\agent\\handoffs"]


class HandoffNt(unittest.TestCase):
    def setUp(self):
        fake = types.SimpleNamespace(**{k: getattr(os, k) for k in dir(os) if not k.startswith("__")})
        fake.name, fake.path, fake.sep, fake.altsep = "nt", ntpath, "\\", "/"
        self._saved = (swg.os, swg.sys, swg._NT)
        swg.os, swg.sys, swg._NT = fake, types.SimpleNamespace(platform="win32"), True
        self.addCleanup(self._restore)

    def _restore(self):
        swg.os, swg.sys, swg._NT = self._saved

    def d(self, cmd, handoff=H):
        return swg.decide(cmd, WS, WS, "bash", None, None, OWNED, handoff)

    def test_scope_marks_nt(self):
        self.assertTrue(swg.Scope(WS, None, None, OWNED, H).handoff_nt)

    def test_allowed_names_in_forward_slash_and_msys_forms(self):
        for base in (HF, "/c/Users/u/.pi/agent/handoffs/h1"):
            for name in ("result.md", "RESULT.MD", "plan.md", "ask-2.md", "work/a/b.txt"):
                with self.subTest(base=base, name=name):
                    self.assertIsNone(self.d(f"echo x > {base}/{name}", handoff=H if base == HF else "/c/Users/u/.pi/agent/handoffs/h1"))

    def test_parent_owned_names_refused(self):
        for name in ("brief.md", "ruling.md", "close.json", "steer.md"):
            with self.subTest(name=name):
                self.assertIsNotNone(self.d(f"echo x > {HF}/{name}"))

    def test_trailing_dots_fold_to_the_name(self):
        self.assertIsNone(self.d(f"echo x > {HF}/result.md."))
        self.assertIsNotNone(self.d(f"echo x > {HF}/ruling.md."))
        self.assertIsNotNone(self.d(f"echo x > {HF}/work."))

    def test_alternate_data_stream_refused(self):
        self.assertIsNotNone(self.d(f"echo x > {HF}/result.md:evil"))
        self.assertIsNotNone(self.d(f"echo x > {HF}/work/a:s"))

    def test_short_name_refused(self):
        self.assertIsNotNone(self.d(f"echo x > {HF}/RESULT~1.MD"))
        self.assertIsNotNone(self.d(f"echo x > {HF}/BRIEF~1.MD"))

    def test_bare_work_entry_refused(self):
        self.assertIsNotNone(self.d(f"rm -rf {HF}/work"))

    def test_native_backslash_dir_and_subst_form(self):
        self.assertEqual(swg.subst_form(H), HF)
        self.assertEqual(swg.subst_form("C:/x/y"), "C:/x/y")
        self.assertIsNone(self.d('echo x > "$PI_FOREMAN_HANDOFF_DIR/result.md"'))
        self.assertIsNotNone(self.d('echo x > "$PI_FOREMAN_HANDOFF_DIR/ruling.md"'))


if __name__ == "__main__":
    unittest.main()
