// pi-subagents 0.89 aborts a child before its first model call when a tool its role allowlists is registered but missing from the request.
// Systemic check (childtools.ts): for each default child role with a setup-style allowlist (tool_search, searchable names, the git and PR packs),
// packs on and off, every allowlisted tool the child has registered is declared in its request (active and not hidden by any prepareLoadout).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { GIT_PACK_TOOL_NAMES, PACK_ENV, PR_TOOL_NAMES } from "../gitpack.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup; PI_OFFLINE makes that return null without starting npm.
const savedOffline = process.env.PI_OFFLINE;
before(() => {
  process.env.PI_OFFLINE = "1";
});
after(() => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

type Def = { name: string; prepareLoadout?: (l: { declared: { name: string }[] }) => { hiddenDeclarations?: string[] } | undefined };

const BASE = ["read", "bash", "tool_search", "codemode", "fusion_reason", "foreman_move", "foreman_copy"];
const ALLOW: Record<string, string[]> = {
  explorer: ["read", "bash", "tool_search", "foreman_move", "fusion_reason"],
  builder: ["read", "bash", "edit", "write", "codemode", "tool_search", "foreman_move", "foreman_copy", "fusion_reason", ...GIT_PACK_TOOL_NAMES, ...PR_TOOL_NAMES],
  reviewer: ["read", "bash", "tool_search", "fusion_reason", ...GIT_PACK_TOOL_NAMES, ...PR_TOOL_NAMES],
};

test("child with no MCP and nothing searchable keeps tool_search in its request", async (t) => {
  const saved = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": { foremanSession: "fs-1", workspace: "/w", role: "explorer", launchId: "L1", kind: "first", model: null } });
  t.after(() => {
    if (saved === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved;
  });
  let active = ["read", "bash", "tool_search"];
  await r11Rig(t, {}, {
    child: true,
    deps: { mcpChild: { resolveRoot: () => null } },
    config: { roles: { explorer: { tools: ["read", "bash", "tool_search"] } } },
    ctx: { sessionManager: { getSessionId: () => "cd-2", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } },
    piExtra: {
      getActiveTools: () => [...active],
      getAllTools: () => active.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
      setActiveTools: (n: string[]) => { active = [...n]; },
    },
  });
  assert.ok(active.includes("tool_search"), "the child's tool_search switch-off removed an allowlisted tool");
});

for (const role of ["explorer", "builder", "reviewer"]) {
  for (const packs of [true, false]) {
    test(`child ${role}, packs ${packs ? "on" : "off"}: every registered allowlisted tool is declared in its request`, async (t) => {
      const saved = { bindings: process.env.PI_SUBAGENT_EXTENSION_BINDINGS, packs: process.env[PACK_ENV] };
      process.env.PI_SUBAGENT_EXTENSION_BINDINGS = JSON.stringify({ "pi-foreman/1": { foremanSession: "fs-1", workspace: "/w", role, launchId: "L1", kind: "first", model: null } });
      if (packs) process.env[PACK_ENV] = "git,pr";
      else delete process.env[PACK_ENV];
      t.after(() => {
        if (saved.bindings === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
        else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = saved.bindings;
        if (saved.packs === undefined) delete process.env[PACK_ENV];
        else process.env[PACK_ENV] = saved.packs;
      });
      const registered = new Map<string, Def>();
      const allowed = ALLOW[role];
      let active = [...allowed];
      const all = [...new Set([...BASE, ...allowed, ...GIT_PACK_TOOL_NAMES, ...PR_TOOL_NAMES, "edit", "write"])];
      await r11Rig(t, {}, {
        child: true,
        config: { roles: { [role]: { tools: allowed, searchable: ["foreman_move", "foreman_copy"] } }, tools: { git: true, pr: true, deferred: ["fusion_*"] } },
        ctx: { sessionManager: { getSessionId: () => "cd-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } },
        piExtra: {
          registerTool: (d: Def) => void registered.set(d.name, d),
          getActiveTools: () => [...active],
          getAllTools: () => all.map((name) => ({ name, description: `${name} tool`, parameters: { type: "object", properties: {} }, exposure: "direct" })),
          setActiveTools: (n: string[]) => { active = [...n]; },
        },
      });
      const hidden = new Set<string>();
      for (const def of registered.values()) for (const n of def.prepareLoadout?.({ declared: active.map((name) => ({ name })) })?.hiddenDeclarations ?? []) hidden.add(n);
      const declared = new Set(active.filter((n) => !hidden.has(n)));
      const missing = allowed.filter((n) => all.includes(n) && !declared.has(n));
      assert.deepEqual(missing, [], `allowlisted tools missing from the request: ${missing.join(", ")}`);
      assert.ok(declared.has("tool_search"));
    });
  }
}
