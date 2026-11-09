"""foreman_worktree.resolve_worktree_root / main_checkout and safe_ops.nested_checkout / list_gitlinks; the resolver reads the case table
tests/fixtures/worktree-root-cases.json that extensions/core-adapter/test/worktree-root.test.ts reads too."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "tests"))
import _isolation  # noqa: E402,F401
import _submodules  # noqa: E402
import foreman_worktree as fw  # noqa: E402
import safe_ops  # noqa: E402

TABLE = json.loads((ROOT / "tests" / "fixtures" / "worktree-root-cases.json").read_text("utf-8"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="wtroot_test_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def sub(self, s):
        return s.replace("{tmp}", self.tmp)


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class ResolverTable(Base):
    def test_case_table(self):
        for c in TABLE["cases"]:
            with self.subTest(c["name"]):
                sup = c.get("superproject")
                r = fw.resolve_worktree_root(self.sub(c.get("main", TABLE["main"])), None if c["setting"] is None else self.sub(c["setting"]),
                                             home=self.sub(TABLE["home"]), agent_dir=self.sub(TABLE["agentDir"]), tmp_root=self.sub(TABLE["tmpRoot"]),
                                             superproject=None if sup is None else self.sub(sup))
                e = c["expect"]
                self.assertEqual(r["spelled"], self.sub(e["spelled"]))
                self.assertEqual(r["custom"], e["custom"])
                self.assertEqual((r.get("error") or {}).get("code"), e.get("code"))
                self.assertEqual(r.get("requested"), self.sub(e["requested"]) if "requested" in e else None)

    def test_symlinked_root_keeps_spelled_and_resolves_real(self):
        real_roots, link = os.path.join(self.tmp, "real-roots"), os.path.join(self.tmp, "link-roots")
        os.mkdir(real_roots)
        os.symlink(real_roots, link)
        r = fw.resolve_worktree_root(os.path.join(self.tmp, "work", "proj"), os.path.join(link, "<repo>"), home=os.path.join(self.tmp, "home"),
                                     agent_dir=os.path.join(self.tmp, "home", ".pi", "agent"), tmp_root=os.path.join(self.tmp, "tmpdir"), superproject=None)
        self.assertEqual(r["spelled"], os.path.join(link, "proj"))
        self.assertEqual(r["real"], os.path.join(real_roots, "proj"))
        self.assertTrue(r["custom"])

    def test_convention_dirs_uses_the_resolved_root(self):
        main = os.path.join(self.tmp, "work", "proj")
        out = os.path.join(self.tmp, "elsewhere")
        os.makedirs(main)
        conv = fw.convention_dirs(main, {"close": {"worktreeDir": os.path.join(out, "<repo>")}})
        self.assertEqual(conv[0], os.path.join(out, "proj"))
        self.assertEqual(fw.convention_dirs(main, {})[0], os.path.join(self.tmp, "work", "proj.worktrees"))


@unittest.skipIf(os.name == "nt", "POSIX paths and symlinks")
class NestedCheckouts(Base):
    def setUp(self):
        super().setUp()
        self.rig = _submodules.build_rig(self.tmp)

    def test_nested_checkout(self):
        r, n = self.rig, safe_ops.nested_checkout
        self.assertTrue(n(r.tree, r.linked_sub), "(a) linked submodule worktree")
        self.assertTrue(n(r.tree, r.plain_sub), "(b) plain submodule checkout")
        self.assertFalse(n(r.tree, r.tree))
        self.assertFalse(n(r.tree, r.foreign), "foreign clone below an accepted checkout")
        self.assertFalse(n(r.tree, r.forged), "gitfile not named back")
        self.assertFalse(n(r.tree, r.stray_inner), "transitive: intermediate clone not accepted")
        self.assertFalse(n(r.tree, r.superproject))
        self.assertFalse(n(os.path.join(r.superproject, "libs", "a"), r.linked_sub))

    def test_main_superproject_accepts_its_submodules(self):
        sp = self.rig.superproject
        self.assertTrue(safe_ops.nested_checkout(sp, os.path.join(sp, "b")))
        self.assertTrue(safe_ops.nested_checkout(sp, os.path.join(sp, "libs", "a")))

    def test_symlinked_tree(self):
        link = os.path.join(self.tmp, "tree-link")
        os.symlink(self.rig.tree, link)
        self.assertTrue(safe_ops.nested_checkout(link, os.path.join(link, "libs", "a")))
        self.assertFalse(safe_ops.nested_checkout(link, os.path.join(link, "forged")))

    def test_main_checkout(self):
        r = self.rig
        self.assertEqual(fw.main_checkout(r.tree), r.superproject)
        self.assertEqual(fw.main_checkout(r.linked_sub), os.path.join(r.superproject, "libs", "a"))
        self.assertEqual(fw.main_checkout(r.plain_sub), r.plain_sub)
        self.assertIsNone(fw.main_checkout(os.path.dirname(self.tmp)))

    def test_list_gitlinks(self):
        self.assertEqual(sorted(safe_ops.list_gitlinks(self.rig.superproject)), ["b", "libs/a"])
        self.assertEqual(sorted(safe_ops.list_gitlinks(self.rig.tree)), ["b", "libs/a"])


if __name__ == "__main__":
    unittest.main()
