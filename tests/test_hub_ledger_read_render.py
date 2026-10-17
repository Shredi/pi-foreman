"""R11 P1b item 2: a plain session's `<hub>/.workflow/LEDGER-*.md` read against the real rendered permission config (permissions_gen.render).

Cause, by trace of the rule evaluation below: rendered without `hub=` (paths.hubWorkflow unset), no external_directory_read key matches the
ledger path, so the last matching rule is the bare `external_directory["*"] = "ask"` catch-all. With hub set, `<hub>/.workflow/*` matches.
The evaluation mirrors the permission system: the bare `external_directory` keys expand onto `external_directory_read` first, the explicit
read keys append after them (a redefined key moves to its explicit spot), and the last matching key wins; `*` matches any run of characters.
"""
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import permissions_gen as pg  # noqa: E402

OWNED = {"scratchRoot": "/tmpx/pi-foreman-scratch", "npmRoot": "/opt/npm/lib/node_modules"}


def read_decision(permission, value):
    """(winning key, action) of a proven read of `value` on external_directory_read."""
    bare = permission.get("external_directory")
    bare = {"*": bare} if isinstance(bare, str) else dict(bare or {})
    read = dict(permission.get("external_directory_read") or {})
    rules = [(k, v) for k, v in bare.items() if k not in read] + list(read.items())
    for key, action in reversed(rules):
        rx = "^" + ".*".join(re.escape(part).replace("\\?", ".") for part in key.split("*")) + "$"
        if re.match(rx, value, re.S):
            return key, action
    return None, permission.get("*", "ask")


@unittest.skipIf(os.name == "nt", "POSIX temp paths")
class PlainSessionLedgerRenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(os.path.realpath(self.tmp.name))
        self.agent = base / "agent"
        self.hub = base / "hub"
        self.foreign = base / "foreign"
        for d in (self.agent, self.hub / ".workflow", self.foreign / ".workflow"):
            d.mkdir(parents=True)
        self.ledger = (self.hub / ".workflow" / "LEDGER-r11.md").as_posix()

    def render(self, hub=None):
        return pg.render({}, self.agent, owned=OWNED, hub=hub)["permission"]

    def test_plain_session_workflow_ledger_read_tool_no_external_dir(self):
        p = self.render([str(self.hub)])
        self.assertEqual(read_decision(p, self.ledger), (self.hub.as_posix() + "/.workflow/*", "allow"))
        self.assertEqual(read_decision(p, (self.hub / ".workflow").as_posix()), (self.hub.as_posix() + "/.workflow", "allow"))

    def test_plain_session_outside_hub_workflow_still_asks(self):
        # the cause: rendered without hub, only the bare catch-all matches the ledger path
        self.assertEqual(read_decision(self.render(), self.ledger), ("*", "ask"))
        self.assertEqual(read_decision(self.render([]), self.ledger), ("*", "ask"))
        # with hub set: the hub root outside .workflow, a look-alike sibling and a foreign .workflow still ask
        p = self.render([str(self.hub)])
        for path in (self.hub / "notes.md", self.hub / ".workflow-old" / "LEDGER-r11.md", self.foreign / ".workflow" / "LEDGER-r11.md"):
            self.assertEqual(read_decision(p, path.as_posix()), ("*", "ask"), path)
        # read keys only: the write family is untouched
        self.assertNotIn(self.hub.as_posix() + "/.workflow/*", p["external_directory"])


if __name__ == "__main__":
    unittest.main()
