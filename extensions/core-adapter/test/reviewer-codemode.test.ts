// Ledger 1 (D6): the reviewer gets codemode by default. A codemode script's inner calls (`<outer>/<n>`, gate-codemode-inner.test.ts) pass the same
// checks as a direct call of a reviewer in a round: the read-only round fence (no write into the round worktree) and the role's denyTools (`mcp__*`).
// The rig and the reviewer round setup follow gate-readonly-role.test.ts (its helpers are not exported).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup; PI_OFFLINE keeps the spawn guard quiet
process.env.PI_OFFLINE = "1";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
type T = Parameters<typeof r11Rig>[0];
type Block = { block?: boolean; reason?: string } | undefined;

test("defaults: the reviewer role has codemode on, the builder stays off", () => {
  const defaults = JSON.parse(fs.readFileSync(path.join(PKG, "config", "foreman.defaults.json"), "utf8"));
  assert.equal(defaults.roles.reviewer.codemode, true);
  assert.equal(defaults.roles.builder.codemode, false);
});

const ROLES = ["explorer", "builder", "reviewer"];
const config = { presence: { enabled: false }, providers: { fake: { roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });

/** A reviewer child of a round whose worktree is the project (the round manifest names it), as gate-readonly-role.test.ts rig() sets it up. */
async function reviewerInRound(t: T) {
  let judged = 0;
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => { judged++; return { content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const perms = { mode: "auto", allow: ["Bash(*)", "Write", "Edit", "mcp__*"] };
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const c = await r11Rig(t, {}, { ctx: { modelRegistry: registry, [RIG_PERMISSIONS]: perms }, config, child: true });
  const state = path.join(c.agentDir, "pi-foreman", "state", "sessions", "parent-session");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "manifest.json"), JSON.stringify({ entries: [{ path: c.project, kind: "worktree" }] }));
  /** An inner call of codemode script `cm1`, the id Pi gives a nested call. */
  const inner = async (toolName: string, input: Record<string, unknown>, n: number): Promise<Block> =>
    (await c.fire("tool_call", { toolName, toolCallId: `cm1/${n}`, input })) as Block;
  return { c, inner, judged: () => judged };
}

test("reviewer codemode: an inner write or bash write into the round worktree is refused, as the direct call is", async (t) => {
  const { c, inner, judged } = await reviewerInRound(t);
  const file = path.join(c.project, "a.txt");
  const direct = await c.call("write", { path: file, content: "x" });
  assert.match(String(direct?.reason), /child-readonly-write/);
  const write = await inner("write", { path: file, content: "x" }, 1);
  assert.equal(write?.block, true);
  assert.match(String(write?.reason), /child-readonly-write/);
  const bash = await inner("bash", { command: "echo x > f" }, 2);
  assert.equal(bash?.block, true);
  assert.match(String(bash?.reason), /child-readonly-write/);
  assert.equal(judged(), 0, "the classifier is not called for the fence");
  // beside it: an inner read of the same file is not refused by the fence
  const read = await inner("read", { path: file }, 3);
  assert.ok(!/child-readonly-write/.test(String(read?.reason)));
});

test("reviewer codemode: an inner mcp__ call is denied by the role's denyTools, as the direct call is", async (t) => {
  const { c, inner } = await reviewerInRound(t);
  const direct = await c.call("mcp__alpha__ping", {});
  assert.equal(direct?.block, true);
  assert.match(String(direct?.reason), /denied for role reviewer/);
  const nested = await inner("mcp__alpha__ping", {}, 1);
  assert.equal(nested?.block, true);
  assert.match(String(nested?.reason), /denied for role reviewer/);
});
