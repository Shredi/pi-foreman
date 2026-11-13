// Pins the model calls of a child whose classifier escalates (the scenario of r18-child-auto-review.test.ts, "an escalating classifier is a child deny
// with the no-pane text"): with gate.readClear on there are two calls, today's classifier question first and the read question second; with
// gate.readClear false exactly one. The deny text is the same in both. A child's clear runs the line (same authority as an owner session).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { gateLogFile } from "../gatelog.ts";

const PROBE = "ls ~/.local/bin | head -3";
const ESCALATE = JSON.stringify({ verdict: "escalate", entry: null, reason: "unsure" });

/** `o.child` false: a headless session (no UI, no launch binding); `o.binding`: extra launch binding fields (an ask dir). */
async function childRig(t: Parameters<typeof r11Rig>[0], gate: Record<string, unknown>, o: { child?: boolean; binding?: Record<string, unknown>; noSentences?: boolean } = {}) {
  const prev = process.env[BINDINGS_ENV];
  if (o.child !== false) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "explorer", launchId: "L1", kind: "first", model: null, ...o.binding } });
  else delete process.env[BINDINGS_ENV];
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const prompts: string[] = [];
  const reply = { read: ESCALATE };
  const modelRegistry = {
    find: () => ({ id: "small" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: unknown, c: { systemPrompt: string }) => {
      prompts.push(c.systemPrompt);
      return { content: [{ type: "text", text: /^You are the read judge/.test(c.systemPrompt) ? reply.read : ESCALATE }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const perms = { classifier: o.noSentences ? {} : { allow: ["Read-only inspection"], deny: ["Never read secrets"] } };
  const r = await r11Rig(t, {}, {
    child: o.child !== false,
    deps: { spawner: inprocSpawner },
    ctx: { hasUI: false, mode: "json", modelRegistry, [RIG_PERMISSIONS]: perms },
    config: { gate: { reviewTimeoutMs: 2000, ...gate }, providers: { fake: { review: { model: "small" }, roles: { explorer: { model: "fake/explorer" } } } } },
  });
  return { ...r, prompts, reply };
}

test("a child's escalating classifier: two calls, the classifier question first and the read question second, then the no-pane deny", async (t) => {
  const c = await childRig(t, {});
  const r = await c.call("bash", { command: PROBE });
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /nobody is at this session \(no pane\)/);
  assert.equal(c.prompts.length, 2);
  assert.doesNotMatch(c.prompts[0], /^You are the read judge/);
  assert.match(c.prompts[1], /^You are the read judge/);

  // the same child session: an exact read answer clears the next line
  c.reply.read = JSON.stringify({ verdict: "read", check: { writes: "no", network: "no", runs: "no", secrets: "no", paths: "inside" }, reason: "lists a directory" });
  assert.equal(await c.call("bash", { command: "ls ~/.local/share | head -3" }), undefined);
  assert.equal(c.prompts.length, 4);

  // a child deny of an earlier step still wins over a model that answers read: no further call
  const denied = await c.call("bash", { command: "$(echo git) push origin x; grep x src/*.ts" });
  assert.equal(denied?.block, true);
  assert.equal(c.prompts.length, 4);
});

const READ_ANSWER = JSON.stringify({ verdict: "read", check: { writes: "no", network: "no", runs: "no", secrets: "no", paths: "inside" }, reason: "lists a directory" });

test("a headless session with an empty whitelist: the no_entries row and no first call, one read question; a non-clear is the no-pane deny, an exact read answer clears and follows the no_entries row", async (t) => {
  const c = await childRig(t, {}, { child: false, noSentences: true });
  const r = await c.call("bash", { command: PROBE });
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /nobody is at this session \(no pane\)/);
  assert.equal(c.prompts.length, 1, "no first call: the read question only");
  assert.match(c.prompts[0], /^You are the read judge/);
  c.reply.read = READ_ANSWER;
  assert.equal(await c.call("bash", { command: "ls ~/.local/share | head -3" }), undefined);
  assert.equal(c.prompts.length, 2);
  const rows = fs.readFileSync(gateLogFile(c.agentDir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const first = rows.filter((x) => x.rule === "no_entries").at(-1)!;
  const clear = rows.find((x) => x.rule === "read-clear")!;
  assert.ok(first?.id, JSON.stringify(rows));
  assert.equal(clear.follows, first.id);
});

// the loader keeps a non-boolean gate.readClear (it reports `gate.readClear: expected boolean`) and the adapter asks the read question only for the boolean true or an absent key
test("a child with gate.childAsk deny: a non-clear reads the child-asks-off text; the string \"false\" for gate.readClear is off: one call", async (t) => {
  const c = await childRig(t, { childAsk: "deny", readClear: "false" });
  const r = await c.call("bash", { command: PROBE });
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /child asks are off \(gate\.childAsk is "deny"\)/);
  assert.equal(c.prompts.length, 1);
  assert.doesNotMatch(c.prompts[0], /^You are the read judge/);
});

test("a child with gate.childAsk parent: a clear runs with no ask file; a non-clear writes ask.md for the parent's pane and is denied when none answers", async (t) => {
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-ask-"));
  t.after(() => fs.rmSync(askDir, { recursive: true, force: true }));
  const c = await childRig(t, { childAsk: "parent", askTimeoutMs: 300 }, { binding: { askDir } });
  c.reply.read = READ_ANSWER;
  assert.equal(await c.call("bash", { command: PROBE }), undefined);
  assert.equal(fs.existsSync(path.join(askDir, "ask.md")), false, "a clear opens no ask");
  c.reply.read = ESCALATE;
  const r = await c.call("bash", { command: "ls ~/.local/share | head -3" });
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /the parent did not answer within/);
  assert.match(fs.readFileSync(path.join(askDir, "ask.md"), "utf8"), /ls ~\/\.local\/share \| head -3/);
});

test("the same scenario with gate.readClear false: exactly one call and the same deny text", async (t) => {
  const c = await childRig(t, { readClear: false });
  const r = await c.call("bash", { command: PROBE });
  assert.equal(r?.block, true);
  assert.match(r?.reason ?? "", /nobody is at this session \(no pane\)/);
  assert.equal(c.prompts.length, 1);
  assert.doesNotMatch(c.prompts[0], /^You are the read judge/);
});
