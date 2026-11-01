"""ceremony-fixes-2 item 1: a worktree child's git write never lands in the foreman's checkout (child git guard).

The root comes from the launch environment (FOREMAN_CHECKOUT), never from the command text. The case table is
tests/fixtures/foreman-checkout-cases.json, shared with extensions/core-adapter/test/floors-foreman-checkout.test.ts."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import git_guard as gg  # noqa: E402

TABLE = json.loads((ROOT / "tests" / "fixtures" / "foreman-checkout-cases.json").read_text("utf-8"))
LEVEL = {gg.ALLOW: "allow", gg.ASK: "ask", gg.DENY: "deny"}
WHY = "the foreman's checkout"


class ForemanCheckoutTest(unittest.TestCase):
    def setUp(self):
        base = tempfile.mkdtemp(prefix="pf-gg-fc-")
        self.addCleanup(shutil.rmtree, base, True)
        self.root = os.path.realpath(base) + "/foreman"
        self.wt = os.path.realpath(base) + "/foreman-wt"
        self.nested = self.root + "/.worktrees/child"
        for d in (self.root, self.wt):
            os.makedirs(d)
            subprocess.run(["git", "init", "-q", d], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.makedirs(self.root + "/.workflow/scratch")
        os.makedirs(self.root + "/src")
        subprocess.run(["git", "init", "-q", self.nested], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.env = dict(os.environ, FOREMAN_CHECKOUT=self.root)

    def sub(self, s):
        return s.replace("{root}", self.root).replace("{wt}", self.wt).replace("{nested}", self.nested)

    def decide(self, line, cwd, env=None):
        d = gg.decide(line, "child", cwd=cwd, env=self.env if env is None else env)
        return LEVEL[d.level], d.reason

    def test_table(self):
        for c in TABLE["shell"]:
            if c["guard"] is None:
                continue
            with self.subTest(case=c["name"]):
                got, reason = self.decide(self.sub(c["line"]), self.sub(c.get("cwd", "{wt}")))
                if c["guard"] == "deny":
                    self.assertEqual(got, "deny", reason)
                    self.assertIn(WHY, reason)
                    self.assertIn("this child runs in its own worktree", reason)
                else:
                    self.assertEqual((got, reason), ("allow", ""))

    def test_the_root_comes_from_the_environment_only(self):
        env = {k: v for k, v in self.env.items() if k != "FOREMAN_CHECKOUT"}
        got, reason = self.decide("git -C %s add f" % self.root, self.wt, env)
        self.assertNotIn(WHY, reason)
        # a command-text rebind changes nothing
        got, reason = self.decide("FOREMAN_CHECKOUT=/nowhere git -C %s add f" % self.root, self.wt)
        self.assertIn(WHY, reason)

    def test_main_mode_is_not_fenced(self):
        d = gg.decide("git -C %s add f" % self.root, "main", cwd=self.wt, env=self.env)
        self.assertNotIn(WHY, d.reason)


if __name__ == "__main__":
    unittest.main()
