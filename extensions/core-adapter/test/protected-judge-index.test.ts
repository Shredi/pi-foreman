// The protected-target handler as index.ts wires it, for the judge change: the trace cause and mode, the per-entry check, the floor order and
// the `--check` flag of `/foreman perms protect` (neutral fixtures: prod-db).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { ProtectedCache } from "../classifier.ts";
import type { ProtectedCall } from "../classifier.ts";

const WRITE_ALLOW = JSON.stringify({ verdict: "allow", effect: "write", confidence: "high", entry: null, reason: "restarts the service" });
const READ_ALLOW = JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "only reads" });

async function rig(t: Parameters<typeof r11Rig>[0], o: { replies?: string[]; perms?: Record<string, unknown> | null; confirm?: () => Promise<boolean> } = {}) {
  const calls: string[] = [];
  const replies = o.replies ?? [READ_ALLOW];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, c: { messages: { content: string }[]; systemPrompt?: string }) => {
      // remote-asks: a protected allow on a line with a judge-first danger (ssh) goes on to the main judge, which this stub clears; `calls` holds the protected checks only
      if (c.systemPrompt?.includes("judge of pi-foreman's tool gate")) return { content: [{ type: "text", text: JSON.stringify({ verdict: "clear", reason: "stub" }) }], stopReason: "stop", usage: { input: 1, output: 1 } };
      calls.push(c.messages[0].content);
      return { content: [{ type: "text", text: replies[Math.min(calls.length - 1, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const notes: string[] = [];
  const confirms: string[] = [];
  const ui = { notify: (m: string) => void notes.push(m), confirm: async (_t: string, m: string) => { confirms.push(m); return (o.confirm ?? (async () => true))(); }, select: async () => undefined, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const cmds = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: false } };
  const perms = o.perms === null ? {} : { [RIG_PERMISSIONS]: o.perms ?? { protected: [{ host: "prod-db", note: "production" }] } };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, hasUI: true, ...perms }, config, piExtra: { registerCommand: (n: string, d: never) => void cmds.set(n, d) } });
  const slash = (args: string): Promise<void> => cmds.get("foreman")!.handler(args, r.ctx);
  return { ...r, calls, notes, confirms, slash };
}
const userFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "permissions.json");

test("the trace names the cause and the effective mode when the table turns a verdict into an ask", async (t) => {
  // remote-asks: a write verdict on a visible remote write is allowed in mode model now; a read verdict on it asks with remote_write
  const r = await rig(t, { replies: [READ_ALLOW] });
  const res = await r.call("bash", { command: "ssh prod-db 'vendorctl status > /etc/app.conf'" });
  assert.ok(res && res.block, "not run");
  const pc = r.events("protected_check");
  assert.equal(pc.length, 1);
  assert.deepEqual([pc[0].accepted, pc[0].cause, pc[0].mode], ["ask", "remote_write", "model"]);
});

test("a loop with a read verdict runs, an allow carries no cause", async (t) => {
  const r = await rig(t);
  assert.equal(await r.call("bash", { command: `ssh prod-db 'for q in a b; do vendorctl status "$q"; done'` }), undefined);
  const pc = r.events("protected_check");
  assert.deepEqual([pc[0].accepted, pc[0].cause ?? null, pc[0].opaque], ["allow", null, false]);
});

test("a transport-opaque call asks with remote_opaque", async (t) => {
  const r = await rig(t);
  const res = await r.call("bash", { command: "cat s.sh | ssh prod-db bash" });
  assert.ok(res && res.block);
  assert.deepEqual([r.events("protected_check")[0].accepted, r.events("protected_check")[0].cause], ["refuse", "remote_opaque"]);
});

test("an entry's check tightens: read-only refuses a write verdict, ask never asks the model", async (t) => {
  const ro = await rig(t, { replies: [WRITE_ALLOW], perms: { protected: [{ host: "prod-db", check: "read-only" }] } });
  const res = await ro.call("bash", { command: "ssh prod-db 'vendorctl restart'" });
  assert.ok(res && res.block);
  assert.deepEqual([ro.events("protected_check")[0].cause, ro.events("protected_check")[0].mode], ["read_only", "read-only"]);
  const ask = await rig(t, { perms: { protected: [{ host: "prod-db", check: "ask" }] } });
  const res2 = await ask.call("bash", { command: "ssh prod-db uptime" });
  assert.ok(res2 && res2.block);
  assert.equal(ask.calls.length, 0);
  assert.deepEqual([ask.events("protected_check")[0].cause, ask.events("protected_check")[0].mode], ["mode", "ask"]);
});

test("a hard floor on the line wins over the check; the model is never asked", async (t) => {
  const r = await rig(t);
  const res = await r.call("bash", { command: "ssh prod-db uptime; rm -rf /" });
  assert.ok(res && res.block);
  assert.equal(r.calls.length, 0);
  assert.equal(r.events("protected_check").length, 0);
});

test("a cached read allow is not served once the effective mode is ask", async () => {
  const cache = new ProtectedCache();
  let n = 0;
  const registry = { find: () => ({ id: "m" }), complete: async () => { n++; return { content: [{ type: "text", text: READ_ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  const entry = { id: "P1", kind: "host" as const, glob: "prod-db", source: "user" };
  const c = { prose: { allow: [], deny: [] }, registry: registry as never, config: { providers: { fake: { roles: { review: { model: "fake/m" } } } } }, provider: "fake", match: { entries: [entry], classes: ["read" as const], remoteClasses: ["unknown" as const], opaque: false, remoteOpaque: false, kinds: ["host"] }, task: "", denyEntries: [], checkMode: "model" as const, version: 1, away: false };
  const call: ProtectedCall = { tool: "bash", payload: "ssh prod-db uptime", kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", branch: "main", remotes: [] };
  assert.equal((await cache.check(call, c)).accepted, "allow");
  assert.equal((await cache.check(call, c)).cached, true);
  const strict = await cache.check(call, { ...c, checkMode: "ask" });
  assert.deepEqual([strict.accepted, strict.cause, strict.cached], ["ask", "mode", false]);
  assert.equal(n, 1);
});

test("/foreman perms protect --check writes the field; the confirm text names the mode", async (t) => {
  const r = await rig(t, { perms: null });
  await r.slash("perms protect add host prod-db --check read-only --note production, careful --user");
  assert.match(r.notes.at(-1)!, /^pi-foreman: protected: host prod-db/);
  assert.deepEqual(JSON.parse(fs.readFileSync(userFile(r.agentDir), "utf8")).protected, [{ host: "prod-db", note: "production, careful", check: "read-only" }]);
  assert.match(r.confirms.at(-1)!, /Check mode: read-only/);
  assert.match(r.confirms.at(-1)!, /remote writes the harness itself sees, which always ask/);
  await r.slash("perms protect add host prod-db --check ask --user");
  assert.match(r.notes.at(-1)!, /not changed: .*already protected.*remove it and add it again/);
});

test("/foreman perms protect: --check bogus and --check on remove are refused with the usage; nothing is written", async (t) => {
  const r = await rig(t, { perms: null });
  await r.slash("perms protect add host prod-db --check bogus --user");
  assert.match(r.notes.at(-1)!, /^Usage: \/foreman perms protect .*--check model\|read-only\|ask/);
  await r.slash("perms protect add host prod-db --check");
  assert.match(r.notes.at(-1)!, /^Usage:/);
  await r.slash("perms protect remove host prod-db --check ask --user");
  assert.match(r.notes.at(-1)!, /^Usage:/);
  assert.equal(fs.existsSync(userFile(r.agentDir)), false);
  assert.equal(r.confirms.length, 0);
});
