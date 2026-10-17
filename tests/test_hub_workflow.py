"""paths.hubWorkflow: the hub's `.workflow/` family lands in external_directory_read (read only); default changes nothing."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402
import permissions_gen as pg  # noqa: E402

OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}


class HubWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.agent = Path(self.tmp.name) / "agent"
        self.agent.mkdir()

    def render(self, hub=None):
        return pg.render({}, self.agent, owned=OWNED, hub=hub)["permission"]

    def test_default_is_empty_and_changes_nothing(self):
        self.assertEqual(fc.read_json(ROOT / "config" / "foreman.defaults.json")["paths"], {"hubWorkflow": []})
        self.assertEqual(self.render([]), self.render())
        self.assertNotIn("/hub/.workflow", self.render([])["external_directory_read"])

    def test_list_and_string_add_read_patterns_only(self):
        for hub in (["/hub", "/other/hub/"], "/hub"):
            p = self.render(hub)
            self.assertEqual(p["external_directory_read"]["/hub/.workflow"], "allow")
            self.assertEqual(p["external_directory_read"]["/hub/.workflow/*"], "allow")
            self.assertNotIn("/hub/.workflow/*", p["external_directory"])

    def test_unsafe_entries_are_dropped(self):
        p = self.render(["rel/hub", "/a/../b", "", 3, "/"])
        self.assertEqual([k for k in p["external_directory_read"] if ".workflow" in k], [])

    def test_symlinked_hub_renders_the_realpath_spelling_too(self):
        real = Path(self.tmp.name).resolve() / "realhub"
        (real / ".workflow").mkdir(parents=True)
        link = Path(self.tmp.name).resolve() / "linkhub"
        link.symlink_to(real)
        r = self.render([str(link)])["external_directory_read"]
        for base in (link.as_posix(), real.as_posix()):
            self.assertEqual(r[base + "/.workflow"], "allow")
            self.assertEqual(r[base + "/.workflow/*"], "allow")
        self.assertNotIn(real.as_posix(), r)

    def test_foreign_absolute_hub_gets_no_cwd_relative_realpath_key(self):
        # a Windows-style entry on a POSIX host (or vice versa) is not absolute there: realpath would anchor it at the cwd
        r = self.render(["C:/hub"])["external_directory_read"]
        keys = sorted(k for k in r if ".workflow" in k)
        self.assertEqual(keys, ["C:/hub/.workflow", "C:/hub/.workflow/*"])

    def test_project_layer_cannot_set_it(self):
        (self.agent / "foreman.json").write_text(json.dumps({"paths": {"hubWorkflow": ["/user/hub"]}}))
        proj = Path(self.tmp.name) / "proj"
        (proj / ".pi").mkdir(parents=True)
        (proj / ".pi" / "foreman.json").write_text(json.dumps({"paths": {"hubWorkflow": ["/evil"]}}))
        res = fc.load_config(str(self.agent), project_dir=str(proj), trusted_project=True)
        self.assertEqual(res["config"]["paths"]["hubWorkflow"], ["/user/hub"])


if __name__ == "__main__":
    unittest.main()
