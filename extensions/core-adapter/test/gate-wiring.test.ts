// r79 items 3, 5, 11, rebased on PR C: the gate handler's wiring. Floors, defaults, the judge-first list, the judge, the owner dialog (allow once,
// deny with comment, deny and stop), the no-UI deny. One decision-log record per decision; the log carries the shape, never the raw command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";

type Reply = string | Error;
function fakeRegistry(replies: Reply[], found = true) {
  const calls: { text: string }[] = [];
  const registry = {
    find: () => (found ? { id: "m" } : undefined),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push({ text: ctx.messages[0].content });
      const r = replies[Math.min(calls.length - 1, replies.length - 1)];
      if (r instanceof Error) throw r;
      return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  return { registry, calls };
}
const V = (verdict: string, reason: string | null): string => JSON.stringify({ verdict, reason: `because ${reason}` });
// presence off: an owner dialog awaits the presence probe's detached child, which keeps no event loop alive in a bare test process
const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: false } };
const DANGER = "git branch -D old-topic"; // danger-git: judge-first

interface RigOpts {
  child?: boolean;
  hasUI?: boolean;
  found?: boolean;
  /** Answers of ui.select in order; a missing answer is undefined (dismissed). */
  selects?: (string | undefined)[];
}
async function rig(t: Parameters<typeof r11Rig>[0], replies: Reply[], o: RigOpts = {}) {
  const reg = fakeRegistry(replies, o.found ?? true);
  const asked: { title: string; options: string[] }[] = [];
  const answers = [...(o.selects ?? [])];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: async (title: string, options: string[]) => (asked.push({ title, options }), answers.shift()),
    input: async () => "",
    editor: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: reg.registry, ui, hasUI: o.hasUI ?? true }, config, child: o.child });
  if (o.perms) {
    fs.mkdirSync(path.join(r.agentDir, "pi-foreman"), { recursive: true });
    fs.writeFileSync(path.join(r.agentDir, "pi-foreman", "permissions.json"), JSON.stringify(o.perms));
  }
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  return { ...r, reg, log, asked };
}

test("a floor deny blocks and writes a floor record under the fixture agent dir", async (t) => {
  const r = await rig(t, [V("clear", "judge")]);
  const res = await r.call("bash", { command: "sudo ls" });
  assert.ok(res && res.block);
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule, rec.tool], ["floor", "deny", "floor-privilege", "bash"]);
  assert.ok(gateLogFile(r.agentDir).startsWith(r.agentDir));
  assert.equal(r.reg.calls.length, 0);
});

// r79 item 4: the permissions file is the protected policy file
test("a permissions file write is a floor deny for every kind of session", async (t) => {
  for (const child of [false, true]) {
    const r = await rig(t, [V("clear", "judge")], { child });
    const res = await r.call("write", { path: path.join(r.project, ".workflow", "permissions.json"), content: "x" });
    assert.ok(res && res.block, String(child));
    assert.equal(r.log().at(-1)!.rule, "floor-policy-file");
  }
});

test("a default allow writes a default record and no judge call", async (t) => {
  const r = await rig(t, [V("unsure", "judge")]);
  await r.call("bash", { command: "git status" });
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule], ["default", "allow", "default-git-read"]);
  assert.equal(r.reg.calls.length, 0);
});

test("a call nothing names runs: a no-rule record, no judge call", async (t) => {
  const r = await rig(t, [V("unsure", "judge")]);
  assert.equal(await r.call("bash", { command: "somecmd --flag" }), undefined);
  assert.deepEqual([r.log().at(-1)!.layer, r.log().at(-1)!.verdict], ["mode", "allow"]);
  assert.equal(r.reg.calls.length, 0);
  assert.equal(r.asked.length, 0);
});

// ask-kind floor (opaque text naming a push to a protected branch): the owner decides, never the judge
test("an ask-kind floor hit opens the owner dialog and never the judge", async (t) => {
  const r = await rig(t, [V("clear", "judge")], { selects: ["deny with comment"] });
  const res = await r.call("bash", { command: OPAQUE_PUSH });
  assert.equal(res?.block, true);
  assert.equal(r.asked.length, 1);
  assert.match(r.asked[0].title, /cause: floor-git-push-protected/);
  assert.equal(r.reg.calls.length, 0);
});

test("judge clear runs the call and logs a judge record; an identical repeat is a cache hit", async (t) => {
  const r = await rig(t, [V("clear", "judge")]);
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  const rec = r.log().find((x) => x.layer === "classifier")!;
  assert.deepEqual([rec.verdict, rec.rule], ["allow", "judge"]);
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.equal(r.reg.calls.length, 1);
  assert.equal(r.log().at(-1)!.layer, "cache");
  assert.ok(r.events("review").length >= 1);
  assert.equal(r.asked.length, 0);
});

test("judge unsure opens the dialog with the judge's reason; failures and a missing model ask too", async (t) => {
  const esc = await rig(t, [V("unsure", null)], { selects: ["allow once"] });
  assert.equal(await esc.call("bash", { command: DANGER }), undefined);
  assert.match(esc.asked[0].title, /cause: danger-git/);
  assert.match(esc.asked[0].title, /classifier: because null/);
  assert.deepEqual(esc.asked[0].options, ["allow once", "deny with comment", "deny and stop"]);
  const gone = await rig(t, [new Error("boom")]);
  assert.equal((await gone.call("bash", { command: DANGER }))?.block, true);
  assert.equal(gone.asked.length, 1);
  assert.equal(gone.log().find((x) => x.layer === "classifier")!.rule, "judge:provider_error");
  const none = await rig(t, [V("clear", "judge")], { found: false });
  await none.call("bash", { command: DANGER });
  assert.equal(none.log().find((x) => x.layer === "classifier")!.rule, "judge:no_model");
});

test("no UI: a judge-first call the judge is unsure of, and an ask-kind floor, are denied at once with the no-pane text", async (t) => {
  const r = await rig(t, [V("unsure", null)], { hasUI: false });
  const res = await r.call("bash", { command: DANGER });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /nobody is at this session \(no pane\)\. The owner is absent/);
  assert.equal(r.asked.length, 0);
  const f = await r.call("bash", { command: OPAQUE_PUSH });
  assert.match(String(f?.reason), /nobody is at this session/);
});

test("deny and stop blocks every later gated call until the next user prompt", async (t) => {
  const r = await rig(t, [V("unsure", null)], { selects: ["deny and stop"] });
  assert.equal((await r.call("bash", { command: DANGER }))?.block, true);
  assert.match(String((await r.call("bash", { command: "somecmd" }))?.reason), /asked you to stop/);
  await r.ownerPrompt("go on");
  assert.equal(await r.call("bash", { command: "somecmd" }), undefined);
});

test("the log carries the shape, never the raw command, and the child session logs too", async (t) => {
  const r = await rig(t, [V("unsure", null)], { child: true });
  await r.call("bash", { command: "curl -X POST -H 'Authorization: Bearer sk-abcdef0123456789abcdef' https://example.com/x && git reset --hard" });
  const rec = r.log().at(-1)!;
  assert.equal(rec.kind, "child");
  assert.doesNotMatch(JSON.stringify(rec), /sk-abcdef|Bearer/);
});

// an opaque line naming a push to main: the floors ask (kind ask), they do not deny
const OPAQUE_PUSH = "$(echo git) push origin main";
