"""r68: MCP tools on demand in a real Pi child, narrowed by the launch (replay fixture child_mcp_scope).

roles.builder.mcp lists the fixture server `fx`; the launch narrows it to `fx/echo` (`mcp` on subagent). The builder
loads `mcp__fx__echo` through `tool_search` and calls it (the server runs and answers); `mcp__fx__shout`, outside the launch
scope, is never registered in the child, so the call fails as an unknown tool before any hook. The per-call `mcp_scope`
guard is a second line behind that and is covered by the adapter tests (mcp-scope-hook.test.ts); no `mcp_scope` block
and no `mcp_child_unsupported` is traced here.
A second case (fixture child_mcp_scope_codemode) runs the same narrowing through a codemode script in an explorer child:
`tools.mcp__fx__shout` does not exist there either, so the script fails before any hook runs.
Same prerequisites and skips as test_replay.py."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import REPO, load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

FIXTURE_SERVER = REPO / "extensions" / "core-adapter" / "test" / "fixtures" / "mcp-fixture-server.mjs"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildMcpScope(ReplayCase):
    def test_launch_narrowed_mcp_loads_on_demand(self):
        rig = self.rig("child-mcp-scope", load_fixture("child_mcp_scope"), config={"roles": {"builder": {"mcp": ["fx"]}}})
        # `echo` is not a read name, so an MCP call of it is the dangerous class `danger-mcp-act` (asked of the parent); this case is about
        # the scope, so a user allow rule lets the call through
        self.user_permissions(rig, {"allow": ["mcp__fx__echo"]})
        server = {"command": "node", "args": [str(FIXTURE_SERVER), str(rig.root / "fx-started"), str(rig.root / "fx-exited")]}
        (rig.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"fx": server}}), "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, _recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIsNotNone(notice)
        results = {}
        for p in rig.root.rglob("run-0/session.jsonl"):
            for line in p.read_text("utf-8").splitlines():
                m = json.loads(line).get("message", {})
                if m.get("role") == "toolResult":
                    results[m.get("toolName")] = (m.get("isError"), "".join(c.get("text", "") for c in m.get("content", [])))
        self.assertIn("Loaded 1 tool", results["tool_search"][1], results)
        self.assertEqual(results["mcp__fx__echo"], (False, "hello"), results)
        self.assertEqual(results["mcp__fx__shout"], (True, "Tool mcp__fx__shout not found"), results)
        self.assertTrue((rig.root / "fx-started").exists())
        events = [r for recs_ in rig.traces().values() for r in recs_]
        self.assertEqual([r for r in events if r.get("event") == "mcp_child_unsupported" or r.get("guard") == "mcp_scope"], [])

    def test_codemode_cannot_reach_a_tool_outside_launch_scope(self):
        # an `mcp_scope` block cannot be driven end to end: a tool outside the launch scope is never registered, so even a
        # codemode script (explorer, ceiling `fx`, launch fx/echo) finds `tools.mcp__fx__shout` missing before any hook runs.
        # The block itself is covered by mcp-scope-hook.test.ts.
        config = {"roles": {"explorer": {"mcp": ["fx"], "denyTools": []}}}
        rig = self.rig("child-mcp-scope-codemode", load_fixture("child_mcp_scope_codemode"), config=config)
        server = {"command": "node", "args": [str(FIXTURE_SERVER), str(rig.root / "fx-started"), str(rig.root / "fx-exited")]}
        (rig.agent / "mcp.json").write_text(json.dumps({"mcpServers": {"fx": server}}), "utf-8")
        pi = rig.start()
        pi.prompt("[[replay:c1]] go", timeout=60)
        notice, _recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIsNotNone(notice)
        results = {}
        for p in rig.root.rglob("run-0/session.jsonl"):
            for line in p.read_text("utf-8").splitlines():
                m = json.loads(line).get("message", {})
                if m.get("role") == "toolResult":
                    results[m.get("toolName")] = (m.get("isError"), "".join(c.get("text", "") for c in m.get("content", [])))
        events = [r for recs_ in rig.traces().values() for r in recs_]
        self.assertIn("tools.mcp__fx__shout does not exist", results["codemode"][1], results)
        self.assertEqual([r for r in events if r.get("guard") == "mcp_scope"], [])


if __name__ == "__main__":
    unittest.main()
