"""One list of child-written handoff names: the script's built-in fallback equals tests/fixtures/handoff-names.json (the TypeScript list is compared
with it in handoff-names-fixture.test.ts), and no parent-written name is on it."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "handoff-names.json").read_text("utf-8"))


class HandoffNamesFixture(unittest.TestCase):
    def test_builtin_list_equals_the_fixture(self):
        self.assertEqual(sorted(swg.HANDOFF_CHILD_NAMES), sorted(FIXTURE["childWritten"]))

    def test_no_parent_written_name_is_on_the_list(self):
        for n in FIXTURE["parentWritten"]:
            self.assertNotIn(n, swg.HANDOFF_CHILD_NAMES, n)
        for prefix in ("ruling", "brief", "steer", "parent", "child", "close.json", "live.json", "launch.txt", "notice-seq.lock"):
            self.assertFalse([n for n in swg.HANDOFF_CHILD_NAMES if n.startswith(prefix)], prefix)

    def test_the_fixture_list_is_well_formed_for_the_payload(self):
        self.assertEqual(swg._payload_handoff_names(FIXTURE["childWritten"]), tuple(FIXTURE["childWritten"]))


if __name__ == "__main__":
    unittest.main()
