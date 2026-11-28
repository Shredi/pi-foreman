"""`attach` of pr_create and the op pr_attach of scripts/pr_ops.py: gh `--attach=<path>[#caption]` per file, the one-line degrade for an old gh or a non-GitHub host
(the PR opens without images and the body names the files), later attach to an open PR as one comment."""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_safe_ops_pr as pr_base
from test_safe_ops import safe_ops

URL = "https://github.com/own/repo/pull/5"


class AttachTest(pr_base.PrCase):
    def run_op(self, op, args, version="gh version 2.99.0 (2026-01-01)", pr_host="gh"):
        import pr_ops
        seen = []
        bodies = []

        def fake(argv, root, subst=()):
            seen.append(list(argv))
            if argv[1:2] == ["--version"]:
                return (0, version + "\n", "")
            if "--body-file" in argv:
                bodies.append(Path(argv[argv.index("--body-file") + 1]).read_text(encoding="utf-8"))
            return (0, URL + "\n", "")

        self.hosts("gh")
        if not getattr(self, "_ready", False):
            self.ready()
            self._ready = True
        with mock.patch.object(pr_ops, "run_host", fake):
            res = safe_ops.handle({"op": op, "args": args, "cwd": self.repo, "config": {"prHost": pr_host}})
        return res, seen, bodies

    def test_multiple_files_become_repeated_attach_flags(self):
        res, seen, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png", "d/b.jpg#Second"]})
        self.assertTrue(res["ok"], res)
        argv = [x for x in seen if x[1:3] == ["pr", "create"]][0]
        self.assertIn("--attach=a.png", argv)
        self.assertIn("--attach=d/b.jpg#Second", argv)
        self.assertEqual(res["attached"], 2)

    def test_old_gh_opens_without_images_and_body_names_the_files(self):
        res, seen, bodies = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"]}, version="gh version 2.98.9 (x)")
        self.assertTrue(res["ok"], res)
        self.assertIn("2.98.9", res["attach_degraded"])
        argv = [x for x in seen if x[1:3] == ["pr", "create"]][0]
        self.assertFalse([x for x in argv if x.startswith("--attach")])
        self.assertIn("`a.png`", bodies[0])

    def test_body_that_names_the_path_is_left_alone_when_degraded(self):
        _, _, bodies = self.run_op("pr_create", {"title": "T", "body": "x a.png y", "attach": ["a.png"]}, version="gh version 2.1.0")
        self.assertEqual(bodies[0], "x a.png y")

    def test_degrade_reason_of_the_ts_side(self):
        res, seen, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": ["a.png"], "attach_degrade": "host git.example.test is not github.com"})
        self.assertIn("git.example.test", res["attach_degraded"])
        self.assertFalse([x for x in seen if any(a.startswith("--attach") for a in x)])

    def test_bad_paths_are_refused(self):
        for bad in (["/etc/x.png"], ["../x.png"], ["a\nb.png"], [], "a.png", ["a.png"] * 11):
            res, _, _ = self.run_op("pr_create", {"title": "T", "body": "b", "attach": bad})
            self.assertEqual(res.get("precondition"), "bad_request", bad)

    def test_pr_attach_posts_one_comment(self):
        res, seen, bodies = self.run_op("pr_attach", {"number": 5, "attach": ["a.png", "b.webp#cap"], "caption": "Shots"})
        self.assertTrue(res["ok"], res)
        argv = [x for x in seen if x[1:3] == ["pr", "comment"]][0]
        self.assertEqual(argv[3], "5")
        self.assertIn("--attach=b.webp#cap", argv)
        self.assertEqual(bodies, ["Shots"])
        self.assertEqual(res["attached"], 2)

    def test_pr_attach_old_gh_posts_nothing(self):
        res, seen, _ = self.run_op("pr_attach", {"number": 5, "attach": ["a.png"]}, version="gh version 2.50.0")
        self.assertTrue(res["ok"], res)
        self.assertIn("2.50.0", res["attach_degraded"])
        self.assertFalse([x for x in seen if x[1:3] == ["pr", "comment"]])

    def test_pr_attach_needs_attach(self):
        res, _, _ = self.run_op("pr_attach", {"number": 5})
        self.assertEqual(res.get("precondition"), "bad_request")


if __name__ == "__main__":
    unittest.main()
