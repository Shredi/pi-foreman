// The protected-target handler as index.ts wires it: the away derivation, an accepted allow's gate-log record, the foreman shell-write refusal ahead of
// the check, a POST fetch to a protected host, and the protectEntry confirm dialog (`/foreman perms protect`). Neutral fixtures.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { sampleAway } from "../protected.ts";
import { Presence } from "../presence.ts";

const HOST = "prod-1.example.net";
const PERMS = { protected: [{ host: "prod-*.example.net" }] };
const WRITE_ALLOW = JSON.stringify({ verdict: "allow", effect: "write", confidence: "high", entry: null, reason: "restarts the service" });
const READ_ALLOW = JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "only reads" });

interface RigOpts {
  child?: boolean;
  hasUI?: boolean;
  /** The owner's presence sample the stubbed Presence reports; absent = presence disabled in config. */
  sample?: "present" | "stale" | "away" | "none" | "fail";
  replies?: string[];
  confirm?: () => Promise<boolean>;
  perms?: Record<string, unknown> | null;
}
async function rig(t: Parameters<typeof r11Rig>[0], o: RigOpts = {}) {
  const calls: string[] = [];
  const replies = o.replies ?? [WRITE_ALLOW];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, c: { messages: { content: string }[] }) => {
      calls.push(c.messages[0].content);
      return { content: [{ type: "text", text: replies[Math.min(calls.length - 1, replies.length - 1)] }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const notes: string[] = [];
  const ui = { notify: (m: string) => void notes.push(m), confirm: o.confirm ?? (async () => false), select: async () => undefined, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const cmds = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: o.sample !== undefined } };
  if (o.sample) {
    const s = o.sample;
    const at = Date.now() - (s === "stale" ? 30 * 60_000 : 1000);
    t.after(() => mock.restoreAll());
    mock.method(Presence.prototype, "sample", () => (s === "none" || s === "fail" ? null : { outcome: s === "away" ? "away" : "present", idleSeconds: 1, at }));
    mock.method(Presence.prototype, "away", () => false);
    mock.method(Presence.prototype, "refresh", async () => { if (s === "fail") throw new Error("probe failed"); });
  }
  const perms = o.perms === null ? {} : { [RIG_PERMISSIONS]: o.perms ?? PERMS };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, hasUI: o.hasUI ?? true, ...perms }, config, child: o.child, piExtra: { registerCommand: (n: string, d: never) => void cmds.set(n, d) } });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  const slash = (args: string): Promise<void> => cmds.get("foreman")!.handler(args, r.ctx);
  return { ...r, calls, notes, log, slash };
}
const SSH = { command: `ssh ${HOST} uptime` };
const userFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "permissions.json");

test("sampleAway: a fresh present sample is the only way to be present", () => {
  const now = 10_000_000;
  assert.equal(sampleAway({ outcome: "present", at: now - 60_000 }, false, 11, now), false);
  assert.equal(sampleAway(null, false, 11, now), true, "no sample");
  assert.equal(sampleAway({ outcome: "present", at: now - 12 * 60_000 }, false, 11, now), true, "stale sample");
  assert.equal(sampleAway({ outcome: "unknown", at: now }, false, 11, now), true);
  assert.equal(sampleAway({ outcome: "away", at: now }, false, 11, now), true);
  assert.equal(sampleAway({ outcome: "present", at: now }, true, 11, now), true);
});

test("a present owner: the write verdict is allowed, with a gate-log record naming layer, rule and the model's reason; the trace keeps command and globs", async (t) => {
  const r = await rig(t, { sample: "present" });
  assert.equal(await r.call("bash", SSH), undefined);
  const pc = r.events("protected_check");
  assert.equal(pc.length, 1);
  assert.deepEqual([pc[0].accepted, pc[0].away, pc[0].rule, pc[0].globs], ["allow", false, "protected:P1", "prod-*.example.net"]);
  assert.match(String(pc[0].command), /^ssh /);
  const rec = r.log().find((x) => x.layer === "protected");
  assert.ok(rec, "a protected record");
  assert.deepEqual([rec.verdict, rec.rule, rec.reason], ["allow", "protected:P1", "restarts the service"]);
});

test("away fails closed: probe says away, probe fails, presence off, headless and child all ask for a write verdict", async (t) => {
  const cases: [string, RigOpts][] = [
    ["probe away", { sample: "away" }],
    ["probe failed", { sample: "fail" }],
    ["no sample", { sample: "none" }],
    ["stale sample", { sample: "stale" }],
    ["presence disabled", {}],
    ["headless", { hasUI: false, sample: "present" }],
    ["child", { child: true, hasUI: false, sample: "present" }],
  ];
  for (const [name, o] of cases) {
    const r = await rig(t, o);
    const res = await r.call("bash", SSH);
    const pc = r.events("protected_check");
    assert.equal(pc.length, 1, name);
    assert.deepEqual([pc[0].away, pc[0].accepted], [true, "ask"], name);
    assert.ok(res && res.block, `${name}: not run`);
    assert.equal(r.log().some((x) => x.layer === "protected" && x.verdict === "allow"), false, name);
  }
});

test("a read verdict on a read call is allowed even while away (the read allow needs no presence)", async (t) => {
  const r = await rig(t, { replies: [READ_ALLOW] });
  assert.equal(await r.call("bash", SSH), undefined);
  assert.deepEqual([r.events("protected_check")[0].accepted, r.events("protected_check")[0].away], ["allow", true]);
});

test("the foreman's shell-write refusal comes before the check", async (t) => {
  const r = await rig(t, { sample: "present" });
  const res = await r.call("bash", { command: `echo x > out.txt && ssh ${HOST} uptime` });
  assert.ok(res && res.block);
  assert.equal(r.calls.length, 0, "the model was never asked");
  assert.equal(r.events("protected_check").length, 0);
});

test("a POST fetch to a protected host matches; a read, high verdict does not allow it", async (t) => {
  const r = await rig(t, { replies: [READ_ALLOW], sample: "present" });
  const res = await r.call("fetch", { url: `https://${HOST}/api`, method: "POST", body: "x" });
  const pc = r.events("protected_check");
  assert.equal(pc.length, 1, "matched");
  assert.equal(pc[0].classes, "write-out");
  assert.equal(pc[0].accepted, "ask");
  assert.ok(res && res.block);
  assert.equal(await (await rig(t, { replies: [READ_ALLOW] })).call("fetch", { url: `https://${HOST}/api` }), undefined, "a plain GET never matches");
});

test("a check that throws asks and still leaves a protected_check record with cause exception and the cut error", async (t) => {
  const { ProtectedCache } = await import("../classifier.ts");
  t.after(() => mock.restoreAll());
  mock.method(ProtectedCache.prototype, "check", async () => { throw new Error(`boom ${"x".repeat(400)}`); });
  const r = await rig(t, { sample: "present" });
  const res = await r.call("bash", SSH);
  assert.ok(res && res.block, "not run");
  const pc = r.events("protected_check");
  assert.equal(pc.length, 1);
  assert.deepEqual([pc[0].accepted, pc[0].cause, pc[0].rule, pc[0].globs], ["ask", "exception", "protected:P1", "prod-*.example.net"]);
  assert.match(String(pc[0].command), /^ssh /);
  assert.match(String(pc[0].reason), /^boom x+$/);
  assert.ok(String(pc[0].reason).length <= 200);
});

test("/foreman perms protect: add and remove round trip through the dialog and show in perms list; duplicate and missing are refused", async (t) => {
  const r = await rig(t, { perms: null, confirm: async () => true });
  const add = "perms protect add host prod-*.example.net --note x --user";
  await r.slash(add);
  assert.match(r.notes.at(-1)!, /^pi-foreman: protected: host prod-\*\.example\.net/);
  await r.slash(add);
  assert.match(r.notes.at(-1)!, /not changed: .*already protected/);
  await r.slash("perms list");
  assert.match(r.notes.at(-1)!, /prod-\*\.example\.net/);
  await r.slash("perms protect remove host prod-*.example.net --user");
  assert.match(r.notes.at(-1)!, /no longer protected: host prod-/);
  await r.slash("perms protect remove host prod-*.example.net --user");
  assert.match(r.notes.at(-1)!, /not changed: .*not protected/);
  await r.slash("perms list");
  assert.doesNotMatch(r.notes.at(-1)!, /prod-\*\.example\.net/);
});

test("protectEntry: a yes writes the entry", async (t) => {
  const r = await rig(t, { perms: null, confirm: async () => true });
  await r.slash("perms protect add host staging-*.example.net --user");
  assert.match(r.notes.at(-1)!, /^pi-foreman: protected: host staging-/);
  assert.equal(JSON.parse(fs.readFileSync(userFile(r.agentDir), "utf8")).protected[0].host, "staging-*.example.net");
});

test("protectEntry: no, a dismissed dialog and an exception write nothing", async (t) => {
  const answers: [string, () => Promise<boolean>][] = [
    ["no", async () => false],
    ["dismissed", async () => undefined as unknown as boolean],
    ["exception", async () => { throw new Error("pane gone"); }],
  ];
  for (const [name, confirm] of answers) {
    const r = await rig(t, { perms: null, confirm });
    await r.slash("perms protect add host staging-*.example.net --user");
    assert.match(r.notes.at(-1)!, /not changed/, name);
    assert.equal(fs.existsSync(userFile(r.agentDir)), false, name);
  }
});

test("protectEntry: an unanswered dialog times out into a refusal", async (t) => {
  const r = await rig(t, { perms: null, confirm: () => new Promise<boolean>(() => undefined) });
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const p = r.slash("perms protect add host staging-*.example.net --user");
    for (let i = 0; i < 5; i++) await new Promise<void>((res) => setImmediate(res));
    mock.timers.tick(121_000);
    await p;
  } finally {
    mock.timers.reset();
  }
  assert.match(r.notes.at(-1)!, /not changed/);
  assert.equal(fs.existsSync(userFile(r.agentDir)), false);
});

test("protectEntry: a headless session and a child are refused and told the slash command", async (t) => {
  const headless = await rig(t, { perms: null, hasUI: false, confirm: async () => true });
  await headless.slash("perms protect add host staging-*.example.net --user");
  assert.match(headless.notes.at(-1)!, /not changed: .*\/foreman perms protect/);
  assert.equal(fs.existsSync(userFile(headless.agentDir)), false);
  const child = await rig(t, { perms: null, child: true, confirm: async () => true });
  await child.slash("perms protect add host staging-*.example.net --user");
  assert.match(child.notes.at(-1)!, /not changed: children never change .*\/foreman perms protect/);
  assert.equal(fs.existsSync(userFile(child.agentDir)), false);
});
