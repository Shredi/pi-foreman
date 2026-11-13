// The read question's model call asks with reasoning `high`; the first classifier question passes no reasoning; the log row and the trace event carry the level.
// One adapter session, the scripted model in-process (no child process).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { READ_REASONING } from "../classifier.ts";

const ROLES = ["explorer", "builder", "reviewer"];
const CHECK = { writes: "no", network: "no", runs: "no", secrets: "no", paths: "inside" };
const READ = JSON.stringify({ verdict: "read", check: CHECK, reason: "only greps files in src" });
const ESC = JSON.stringify({ verdict: "escalate", entry: null, reason: "nothing in the whitelist covers it" });

const calls: { kind: "first" | "read"; options: Record<string, unknown> }[] = [];
const registry = {
  find: () => ({ id: "m" }),
  getProviderAuthStatus: () => ({ configured: false }),
  complete: async (_m: never, c: { systemPrompt: string }, options: Record<string, unknown>) => {
    const kind = /^You are the read judge/.test(c.systemPrompt) ? "read" : "first";
    calls.push({ kind, options });
    return { content: [{ type: "text", text: kind === "read" ? READ : ESC }], stopReason: "stop", usage: { input: 1, output: 1 } };
  },
};

const cleanups: (() => void | Promise<void>)[] = [];
const h = {} as { r: Awaited<ReturnType<typeof r11Rig>> };
before(async () => {
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => "deny", input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const config = {
    providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } },
    gate: { reviewTimeoutMs: 300 },
    presence: { enabled: false },
  };
  const perms = { classifier: { allow: ["Run the project's test suite."] } };
  h.r = await r11Rig({ after: (fn) => void cleanups.push(fn) }, {}, { ctx: { ui, modelRegistry: registry, [RIG_PERMISSIONS]: perms }, config, deps: { getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }), spawner: inprocSpawner } });
});
after(async () => {
  for (const f of cleanups.reverse()) await f();
});

test("the read call passes reasoning high with room for the answer; the first call passes none; row and trace carry the level", async () => {
  assert.equal(READ_REASONING, "high");
  assert.equal(await h.r.call("bash", { command: "grep -n foo src/*.ts | head -20" }), undefined);
  assert.deepEqual(calls.map((c) => c.kind), ["first", "read"]);
  assert.equal(calls[1].options.reasoning, "high");
  assert.ok((calls[1].options.maxTokens as number) >= 4096, "the reasoning budget leaves room for the answer");
  assert.equal("reasoning" in calls[0].options, false);
  assert.equal(calls[0].options.maxTokens, 1024);
  const f = gateLogFile(h.r.agentDir);
  const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(rows.find((x) => x.rule === "read-clear")?.reasoning, "high");
  assert.equal(rows.find((x) => x.layer === "classifier" && x.rule === "model")?.reasoning, undefined);
  const ev = h.r.events("review").filter((e) => e.entry === "read-clear");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].reasoning, "high");
});
