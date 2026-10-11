"""docs/features.md: the curated map covers the schema and commands, and the file is current.

FOREMAN_DOCS_UPDATE=1 rewrites docs/features.md from the generator instead of failing.
"""
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import foreman_docs as fd  # noqa: E402
from test_docs import anchors  # noqa: E402


class FeatureMap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.map = fd.load_features()
        cls.features = cls.map["features"]
        cls.leaves = fd.load_leaves()
        cls.defaults = fd.load_defaults()

    def test_ids_unique(self):
        ids = [f["id"] for f in self.features]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_leaf_in_exactly_one_feature(self):
        bad = {}
        for leaf in self.leaves:
            owners = [f["id"] for f in self.features if leaf in fd.feature_leaves(f, [leaf])]
            if len(owners) != 1:
                bad[".".join(leaf)] = owners
        self.assertEqual(bad, {}, "schema leaves with no or several features")

    def test_every_pattern_matches_a_leaf(self):
        dead = ["%s: %s" % (f["id"], p) for f in self.features for p in f["keys"]
                if not any(fd.pattern_matches(p, l) for l in self.leaves)]
        self.assertEqual(dead, [])

    def test_quick_start_names_known_features(self):
        ids = {f["id"] for f in self.features}
        unknown = [q["feature"] for q in self.map["overlayQuickStart"] if q["feature"] not in ids]
        self.assertEqual(unknown, [])

    def test_every_command_in_exactly_one_feature(self):
        known = fd.enumerated_commands()
        self.assertIn("foreman setup", known)
        listed = [(f["id"], c) for f in self.features for c in f["commands"]]
        bad = {c: [i for i, x in listed if x == c] for c in sorted(known)}
        bad = {c: owners for c, owners in bad.items() if len(owners) != 1}
        self.assertEqual(bad, {}, "commands with no or several features")
        stray = [c for _, c in listed if c not in known and not any(c.startswith(k + " ") for k in known)]
        self.assertEqual(stray, [], "listed commands that extend no known command")

    def test_doc_links_resolve(self):
        bad = []
        for f in self.features:
            path, _, frag = f["doc"].partition("#")
            dest = ROOT / path
            if not dest.is_file() or (frag and frag not in anchors(dest)):
                bad.append("%s: %s" % (f["id"], f["doc"]))
        self.assertEqual(bad, [])

    def test_state_matches_switch_on_defaults(self):
        bad = []
        for f in self.features:
            want = fd.expected_state(f, self.defaults)
            if want is None:
                ok = f["state"] in ("on", "opt-in")
            else:
                ok = f["state"] == want
            if not ok:
                bad.append("%s: %s, expected %s" % (f["id"], f["state"], want))
        self.assertEqual(bad, [])

    def test_dormant_on_defaults(self):
        want = [f["id"] for f in self.features if f.get("switch") and f["state"] != "on"]
        self.assertEqual(fd.dormant(self.map, self.defaults), want)

    def test_install_lines_verbatim(self):
        text = (ROOT / "docs" / "install.md").read_text(encoding="utf-8")
        missing = [l for l in self.map["install"] if l not in text]
        self.assertEqual(missing, [])

    def test_layer_rules_from_code(self):
        self.assertEqual(fd.layer_order(), ["L1", "L3", "L2", "project", "session"])
        self.assertEqual(fd.layer_rule(("safety", "children", "mayPush")), "tighten-only (only false is accepted)")
        self.assertTrue(fd.layer_rule(("retro", "repoBacklog")).startswith("not in project/session"))
        self.assertEqual(fd.layer_rule(("quiet",)), "any layer")

    def test_generated_file_current(self):
        path = ROOT / "docs" / "features.md"
        text = fd.render()
        if os.environ.get("FOREMAN_DOCS_UPDATE") == "1":
            with open(str(path), "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
        self.assertEqual(path.read_text(encoding="utf-8"), text,
                         "docs/features.md is stale; run python scripts/foreman_docs.py features")


if __name__ == "__main__":
    unittest.main()
