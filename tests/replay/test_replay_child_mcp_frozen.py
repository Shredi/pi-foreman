"""r72: an MCP tool loaded by tool_search is callable in a child on a provider that fixes its tool list per turn.

The fake provider runs in frozen mode (FOREMAN_FAKE_FROZEN=1), like pi-claude-bridge: it records the tool names the
turn's first request declares and answers a later call to any other name with `No such tool available: <name>`
without Pi executing it. roles.builder.mcp lists the fixture server `fx` (exposure deferred); a second server `gx`
(exposure direct) is outside the ceiling. The builder runs tool_search, which loads `mcp__fx__echo`, then calls it.

r68's replays (test_replay_child_mcp_scope.py) missed this because the plain fake provider reads `context.tools` on
every request, so a tool loaded mid-turn is always callable there. With `mcp.directProviders` naming the provider the
ceiling's deferred tools are loaded before the first prompt, are declared at the first request and the call works. Without it (the provider is not listed) the
call fails: the dependence on the provider is the point. A tool of `gx` is never registered in the child, so it is
uncallable either way; the per-call `mcp_scope` guard is a second line that this rig cannot reach (see
test_replay_child_mcp_scope.py) and is covered by mcp-scope-hook.test.ts.
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
CHILD_PROVIDER = "foreman-fake"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % (REASON,))
class TestChildMcpFrozenToolList(ReplayCase):
    def run_child(self, name, config):
        rig = self.rig(name, load_fixture("child_mcp_frozen"), config=config)
        # `echo` is not a read name, so an MCP call of it is the dangerous class `danger-mcp-act` (asked of the parent); this case is about
        # the frozen tool list, so a user allow rule lets the call through
        self.user_permissions(rig, {"allow": ["mcp__fx__echo"]})
        servers = {}
        for key in ("fx", "gx"):
            args = [str(FIXTURE_SERVER), str(rig.root / (key + "-started")), str(rig.root / (key + "-exited"))]
            servers[key] = {"command": "node", "args": args, "exposure": "deferred" if key == "fx" else "direct"}
        (rig.agent / "mcp.json").write_text(json.dumps({"mcpServers": servers}), "utf-8")
        frozen_log = rig.root / "frozen.log"
        pi = rig.start(env={"FOREMAN_FAKE_FROZEN": "1", "FOREMAN_FAKE_FROZEN_LOG": str(frozen_log)})
        pi.prompt("[[replay:b1]] go", timeout=60)
        notice, _recs = pi.wait_child_notify(timeout=120)
        pi.close()
        self.assertIsNotNone(notice)
        results, texts = {}, []
        for p in rig.root.rglob("run-0/session.jsonl"):
            for line in p.read_text("utf-8").splitlines():
                m = json.loads(line).get("message", {})
                if m.get("role") == "toolResult":
                    results[m.get("toolName")] = (m.get("isError"), "".join(c.get("text", "") for c in m.get("content", [])))
                elif m.get("role") == "assistant":
                    texts.extend(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
        declared = [json.loads(l) for l in frozen_log.read_text("utf-8").splitlines()] if frozen_log.exists() else []
        events = [r for recs_ in rig.traces().values() for r in recs_]
        return rig, results, texts, declared, events

    def test_loaded_tool_is_callable_when_the_provider_is_listed(self):
        config = {"roles": {"builder": {"mcp": ["fx"]}}, "mcp": {"directProviders": [CHILD_PROVIDER]}}
        rig, results, texts, declared, events = self.run_child("child-mcp-frozen", config)
        self.assertEqual(results.get("mcp__fx__echo"), (False, "hello"), (results, texts))
        self.assertTrue((rig.root / "fx-started").exists())
        # outside the ceiling: never declared in the child (the foreman session starts every server itself), uncallable
        [turn] = [d for d in declared if d["tag"] == "bld"]
        self.assertIn("mcp__fx__echo", turn["tools"])  # declared in the first request, before tool_search runs
        self.assertEqual([t for t in turn["tools"] if t.startswith("mcp__gx__")], [])
        self.assertIn("No such tool available: mcp__gx__echo", texts)
        self.assertNotIn("mcp__gx__echo", results)
        direct = [r for r in events if r.get("event") == "mcp_child_direct"]
        self.assertEqual([(r.get("provider"), r.get("servers"), r.get("count")) for r in direct], [(CHILD_PROVIDER, "fx", 2)], events)

    def test_loaded_tool_is_not_callable_when_the_provider_is_not_listed(self):
        config = {"roles": {"builder": {"mcp": ["fx"]}}}
        _rig, results, texts, _declared, events = self.run_child("child-mcp-frozen-unlisted", config)
        self.assertNotIn("mcp__fx__echo", results, results)
        self.assertIn("No such tool available: mcp__fx__echo", texts)
        self.assertEqual([r for r in events if r.get("event") == "mcp_child_direct"], [])


if __name__ == "__main__":
    unittest.main()
