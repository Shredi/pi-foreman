"""More cases of `attach` in scripts/pr_ops.py: the gh version parse (2.100.1 is newer than 2.99.0, garbage degrades), a glab host degrades without any attach flag,
and every `--attach` value reaches `subst` (run_host's check of a `.cmd`/`.bat` gh)."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base
from test_safe_ops import safe_ops

URL = "https://github.com/own/repo/pull/5"


class AttachMoreTest(pr_base.PrCase):
    def run_op(self, op, args, version="gh version 2.99.0 (2026-01-01)", kinds=("gh",), pr_host="gh"):
        import pr_ops
        seen = []
        substs = []
        bodies = []

        def fake(argv, root, subst=()):
            seen.append(list(argv))
            substs.append(list(subst))
            if argv[1:2] == ["--version"]:
                return (0, version + "\n", "")
            if "--body-file" in argv:
                bodies.append(Path(argv[argv.index("--body-file") + 1]).read_text(encoding="utf-8"))
            if "--input" in argv:
                bodies.append(json.loads(Path(argv[argv.index("--input") + 1]).read_text(encoding="utf-8"))["description"])
                return (0, json.dumps({"iid": 4, "web_url": "https://gitlab.example/o/r/-/merge_requests/4", "source_branch": "feat", "target_branch": "main"}), "")
            return (0, URL + "\n", "")

        self.hosts(*kinds)
        if not getattr(self, "_ready", False):
            self.ready()
            self._ready = True
        with mock.patch.object(pr_ops, "run_host", fake):
            res = safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": pr_host}})
        return res, seen, substs, bodies

    def create_argv(self, seen):
        found = [x for x in seen if x[1:3] == ["pr", "create"]]
        return found[0] if found else None

    def test_version_2_100_1_is_newer_than_2_99_0(self):
        res, seen, _, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, version="gh version 2.100.1 (2027-03-01)")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["attached"], 1)
        self.assertIn("--attach=a.png", self.create_argv(seen))

    def test_version_2_99_0_is_enough_and_2_98_9_is_not(self):
        ok, seen_ok, _, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, version="gh version 2.99.0 (x)")
        self.assertNotIn("attach_degraded", ok)
        self.assertIn("--attach=a.png", self.create_argv(seen_ok))
        low, seen_low, _, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, version="gh version 2.98.9 (x)")
        self.assertIn("2.98.9", low["attach_degraded"])
        self.assertFalse([a for a in self.create_argv(seen_low) if a.startswith("--attach")])

    def test_unparsable_version_degrades(self):
        for garbage in ("", "gh", "version two", "gh version x.y.z"):
            res, seen, _, bodies = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, version=garbage)
            self.assertTrue(res["ok"], (garbage, res))
            self.assertIn("could not be read", res["attach_degraded"], garbage)
            self.assertFalse([a for a in self.create_argv(seen) if a.startswith("--attach")], garbage)
            self.assertIn("`a.png`", bodies[0])

    def test_pr_attach_with_garbage_version_posts_nothing(self):
        res, seen, _, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png"]}, version="nonsense")
        self.assertIn("could not be read", res["attach_degraded"])
        self.assertFalse([x for x in seen if x[1:3] == ["pr", "comment"]])

    def test_glab_degrades_without_attach_flag_and_names_the_files(self):
        res, seen, _, bodies = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png#c"]}, kinds=("glab",), pr_host="glab")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["attach_degraded"], "not GitHub")
        self.assertIn("kept locally", bodies[0])
        self.assertIn("`a.png`", bodies[0])
        self.assertFalse([a for argv in seen for a in argv if "--attach" in a])
        self.assertFalse([x for x in seen if x[1:2] == ["--version"]], "no gh version probe on glab")

    def test_pr_attach_on_glab_posts_nothing(self):
        res, seen, _, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png"]}, kinds=("glab",), pr_host="glab")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["attach_degraded"], "not GitHub")
        self.assertFalse(seen)

    def test_attach_values_reach_subst(self):
        _, seen, substs, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png", "d/b.jpg#Second"]})
        i = [k for k, x in enumerate(seen) if x[1:3] == ["pr", "create"]][0]
        self.assertIn("a.png", substs[i])
        self.assertIn("d/b.jpg#Second", substs[i])
        _, seen2, substs2, _ = self.run_op("pr_attach", {"number": 5, "attach": ["x.webp#cap"]})
        j = [k for k, x in enumerate(seen2) if x[1:3] == ["pr", "comment"]][0]
        self.assertIn("x.webp#cap", substs2[j])

    def test_pr_attach_without_a_number_uses_the_current_branch(self):
        res, seen, _, _ = self.run_op("pr_attach", {"attach": ["a.png"]})
        self.assertTrue(res["ok"], res)
        argv = [x for x in seen if x[1:3] == ["pr", "comment"]][0]
        self.assertEqual(argv[3], "--body-file")


if __name__ == "__main__":
    unittest.main()
