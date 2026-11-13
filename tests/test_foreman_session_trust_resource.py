"""The `remote_untrusted` refusal of `session remote open` names the first project resource that triggered it."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_session_remote import RemoteBase, foreman_trust, fsn  # noqa: E402


class TrustResourceTest(RemoteBase):
    def refusal(self, **over):
        rc, reply = self.remote("open", self.open_params(**over))
        self.assertEqual((rc, reply["ok"], reply.get("code")), (1, False, "remote_untrusted"), reply)
        return reply["error"]

    def test_each_trigger_kind_is_named(self):
        for kind in (".pi", ".agents", "extensions", "skills"):
            with self.subTest(kind=kind):
                (self.rproj / kind).mkdir()
                self.assertIn("(first: %s)" % kind, self.refusal())
                (self.rproj / kind).rmdir()

    def test_an_ancestor_match_is_relative_and_never_absolute(self):
        (self.tmp / ".pi").mkdir()
        error = self.refusal()
        self.assertIn("(first: ../.pi)", error)
        self.assertNotIn(str(self.tmp / ".pi"), error)
        self.assertNotIn("(first: /", error)

    def test_an_ancestor_agents_dir_is_named(self):
        (self.tmp / ".agents").mkdir()
        self.assertIn("(first: ../.agents)", self.refusal())

    def test_the_search_order_is_kept(self):
        (self.rproj / ".agents").mkdir()
        (self.tmp / ".pi").mkdir()
        self.assertIn("(first: .agents)", self.refusal())  # the folder before its ancestors
        (self.rproj / ".pi").mkdir()
        self.assertIn("(first: .pi)", self.refusal())  # .pi before .agents
        (self.rproj / ".pi").rmdir()
        (self.rproj / ".agents").rmdir()
        (self.rproj / "skills").mkdir()
        self.assertIn("(first: ../.pi)", self.refusal())  # an ancestor's .pi before the folder's skills

    def test_the_stored_refusal_names_the_resource_too(self):
        (self.rproj / "skills").mkdir()
        self.radir.mkdir(exist_ok=True)
        (self.radir / "trust.json").write_text(json.dumps({str(self.rproj): False}), "utf-8")
        error = self.refusal(trust=True)
        self.assertIn("a stored decision refuses it", error)
        self.assertIn("(first: skills)", error)

    def test_a_trusted_folder_and_no_resource_are_not_refused(self):
        self.assertEqual(self.remote("open", self.open_params())[0], 0)
        (self.rproj / ".pi").mkdir()
        self.assertEqual(self.remote("open", self.open_params(trust=True))[0], 0)
        self.assertIs(foreman_trust.decision(self.radir, self.rproj), True)
        self.assertEqual(self.remote("open", self.open_params())[0], 0)

    def test_a_managed_worktree_is_not_refused(self):
        (self.rproj / ".pi").mkdir()
        with mock.patch.object(fsn, "managed_worktree", return_value=True):
            self.assertEqual(self.remote("open", self.open_params())[0], 0)


class ResourceLabelTest(unittest.TestCase):
    def test_label_is_relative_with_forward_slashes(self):
        cwd = Path("/work/proj/sub")
        self.assertEqual(fsn.resource_label(cwd, cwd / ".pi"), ".pi")
        self.assertEqual(fsn.resource_label(cwd, cwd.parent / ".agents"), "../.agents")

    def test_label_has_no_control_characters_and_is_capped(self):
        cwd = Path("/work/proj")
        label = fsn.resource_label(cwd, cwd.parent / ".pi\x1b[2J\x07\x9b")
        self.assertEqual(label, "../.pi[2J")
        self.assertEqual(len(fsn.resource_label(cwd, cwd / ("a" * 500))), 200)


if __name__ == "__main__":
    unittest.main()
