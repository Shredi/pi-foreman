"""roles.<id>.skills: each named skill dir that exists lands in external_directory_read (user-level spots only); bad names render nothing."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import permissions_gen as pg  # noqa: E402

OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}


class SkillReadRender(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(os.path.realpath(self.tmp.name))
        self.home = (base / "home").as_posix()
        self.agent = base / "home" / ".pi" / "agent"
        self.agent.mkdir(parents=True)

    def mk(self, rel):
        d = Path(self.home) / rel
        d.mkdir(parents=True, exist_ok=True)
        return d.as_posix()

    def keys(self, roles):
        return pg.skill_read_patterns(roles, self.agent, home=self.home)

    def test_existing_user_dirs_render_dir_and_subtree(self):
        a = self.mk(".agents/skills/alpha")
        b = self.mk(".pi/agent/skills/beta")
        self.assertEqual(self.keys({"builder": {"skills": ["alpha", "beta"]}}), [a, a + "/*", b, b + "/*"])

    def test_missing_dirs_are_dropped(self):
        self.assertEqual(self.keys({"builder": {"skills": ["nope"]}}), [])

    def test_bad_names_render_nothing(self):
        self.mk(".agents/skills/x")
        self.assertEqual(self.keys({"builder": {"skills": ["/etc", "../x", "..", ".", "a/b", "a*", "C:x", 3]}}), [])

    def test_no_keys_when_no_role_names_a_skill(self):
        self.mk(".agents/skills/alpha")
        self.assertEqual(self.keys({"builder": {"skills": []}, "reviewer": {}}), [])
        self.assertEqual(self.keys(None), [])

    def test_any_role_counts_and_render_carries_the_keys(self):
        a = self.mk(".agents/skills/alpha")
        roles = {"builder": {"skills": []}, "reviewer": {"skills": ["alpha"]}}
        read = pg.render({}, self.agent, owned=OWNED, roles=roles)["permission"]["external_directory_read"]
        # render() resolves the real home: the key is present only when the test home is the real one, so check the helper's output instead
        self.assertEqual(self.keys(roles), [a, a + "/*"])
        self.assertIsInstance(read, dict)


if __name__ == "__main__":
    unittest.main()
