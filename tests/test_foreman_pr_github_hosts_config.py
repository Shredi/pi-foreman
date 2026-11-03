"""tools.prGithubHosts: no default, user or overlay layer only, 1 to 20 valid host names."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import test_foreman_config as tfc  # noqa: E402
import foreman_config as fc  # noqa: E402

KEY = "tools.prGithubHosts"


def semantic(hosts):
    return [m for _lvl, _path, m in fc.semantic_issues({"tools": {"prGithubHosts": hosts}})]


def schema_issues(hosts):
    issues = []
    schema = json.loads((Path(__file__).resolve().parent.parent / "config" / "foreman.schema.json").read_text("utf-8"))
    fc.validate_schema({"tools": {"prGithubHosts": hosts}}, schema, "", issues)
    return issues


class PrGithubHostsConfigTest(unittest.TestCase):
    setUp, _restore_env, l2, proj, load = (tfc.ConfigTest.setUp, tfc.ConfigTest._restore_env, tfc.ConfigTest.l2,
                                           tfc.ConfigTest.proj, tfc.ConfigTest.load)

    def test_there_is_no_default(self):
        self.assertNotIn("prGithubHosts", self.load()["config"].get("tools", {}))

    def test_user_layer_sets_it_and_project_layer_is_ignored(self):
        self.l2({"tools": {"prGithubHosts": ["ghe.example.test"]}})
        self.assertEqual(self.load()["config"]["tools"]["prGithubHosts"], ["ghe.example.test"])
        self.proj({"tools": {"prGithubHosts": ["evil.example.test"]}})
        res = self.load(trusted_project=True)
        self.assertEqual(res["config"]["tools"]["prGithubHosts"], ["ghe.example.test"])
        self.assertIn(KEY, "\n".join(res["warnings"]))

    def test_project_layer_alone_cannot_set_it(self):
        self.proj({"tools": {"prGithubHosts": ["evil.example.test"]}})
        self.assertNotIn("prGithubHosts", self.load(trusted_project=True)["config"].get("tools", {}))

    def test_valid_lists_pass_both_checks(self):
        for hosts in (["github.com"], ["ghe.example.test:8443", "github.com"], ["a"], ["h%d.example.test" % i for i in range(20)]):
            self.assertEqual(semantic(hosts), [], hosts)
            self.assertEqual(schema_issues(hosts), [], hosts)

    def test_empty_too_long_and_bad_names_are_flagged(self):
        self.assertEqual(semantic([]), [KEY + ": is empty"])
        self.assertEqual(semantic(["h%d.example.test" % i for i in range(21)]), [KEY + ": has more than 20 hosts"])
        for bad in ("-a.example.test", "a.example.test-", ".a", "a.", "a..b", "a b", "a/b", "", "a:b", "a:123456x", 5):
            self.assertEqual(semantic(["github.com", bad]), ["%s: %s is not a valid host name" % (KEY, bad)], bad)
            self.assertNotEqual(schema_issues(["github.com", bad]), [], bad)

    def test_a_trailing_newline_is_not_a_valid_host(self):
        self.assertEqual(semantic(["ghe.x\n"]), ["%s: ghe.x\n is not a valid host name" % KEY])


if __name__ == "__main__":
    unittest.main()
