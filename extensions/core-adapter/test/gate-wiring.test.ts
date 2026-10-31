// r79 items 3, 5, 11: the gate handler's wiring. Floors, rules, the dangerous class, the mode step, the classifier, the owner dialog with
// remember, the no-UI deny. One decision-log record per decision; the log carries the shape, never the raw command.
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
const V = (verdict: string, entry: string | null): string => JSON.stringify({ verdict, entry, reason: `because ${entry}` });
// presence off: an owner dialog awaits the presence probe's detached child, which keeps no event loop alive in a bare test process
const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: false } };
const DANGER = "terraform apply -auto-approve"; // danger-deploy
const PROSE = { classifier: { allow: ["Apply terraform changes in this repository"], deny: ["Never touch production state"] } };

interface RigOpts {
  child?: boolean;
  hasUI?: boolean;
  perms?: Record<string, unknown>;
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
  const r = await rig(t, [V("allow", "A1")]);
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
    const r = await rig(t, [V("allow", "A1")], { child });
    const res = await r.call("write", { path: path.join(r.project, ".workflow", "permissions.json"), content: "x" });
    assert.ok(res && res.block, String(child));
    assert.equal(r.log().at(-1)!.rule, "floor-policy-file");
  }
});

test("a default allow writes a default record and no classifier call", async (t) => {
  const r = await rig(t, [V("deny", "D1")], PERMS_NONE);
  await r.call("bash", { command: "git status" });
  const rec = r.log().at(-1)!;
  assert.deepEqual([rec.layer, rec.verdict, rec.rule], ["default", "allow", "default-git-read"]);
  assert.equal(r.reg.calls.length, 0);
});

test("an unmatched call that is not dangerous runs under auto: a mode record, no classifier call", async (t) => {
  const r = await rig(t, [V("deny", "D1")]);
  assert.equal(await r.call("bash", { command: "somecmd --flag" }), undefined);
  assert.deepEqual([r.log().at(-1)!.layer, r.log().at(-1)!.verdict], ["mode", "allow"]);
  assert.equal(r.reg.calls.length, 0);
});

test("mode deny refuses an unmatched and a dangerous call with the mode text; a deny rule still names itself", async (t) => {
  const r = await rig(t, [V("allow", "A1")], { perms: { mode: "deny", allow: ["Bash(somecmd *)"], deny: ["Bash(evilcmd *)"], ...PROSE } });
  const text = "pi-foreman: denied: permissions mode is deny (no rule allows this call)";
  assert.equal((await r.call("bash", { command: "othercmd" }))?.reason, text);
  assert.equal((await r.call("bash", { command: DANGER }))?.reason, text);
  assert.equal(await r.call("bash", { command: "somecmd go" }), undefined, "an allow rule still runs under mode deny");
  assert.match(String((await r.call("bash", { command: "evilcmd x" }))?.reason), /denied by the permission rule Bash\(evilcmd \*\)/);
  assert.equal(r.reg.calls.length, 0);
  assert.equal(r.log().find((x) => x.rule === "mode-deny")?.layer, "mode");
});

test("mode ask asks the owner for an unmatched call and never calls the classifier", async (t) => {
  const r = await rig(t, [V("allow", "A1")], { perms: { mode: "ask", ...PROSE }, selects: ["allow once", "deny and stop"] });
  assert.equal(await r.call("bash", { command: "othercmd" }), undefined);
  assert.match(r.asked[0].title, /cause: no rule matches/);
  assert.equal((await r.call("bash", { command: DANGER }))?.block, true);
  assert.equal(r.reg.calls.length, 0);
});

test("mode allow runs a dangerous call with no classifier and no dialog", async (t) => {
  const r = await rig(t, [V("deny", "D1")], { perms: { mode: "allow", ...PROSE } });
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.equal(r.reg.calls.length, 0);
  assert.equal(r.asked.length, 0);
});

// ask-kind floor (opaque text naming a push to a protected branch): the owner decides before the mode step, even under allow
test("an ask-kind floor hit opens the owner dialog before the mode step, under mode allow too, never the classifier", async (t) => {
  const line = OPAQUE_PUSH;
  for (const mode of ["allow", "auto"]) {
    const r = await rig(t, [V("allow", "A1")], { perms: { mode, ...PROSE }, selects: ["deny with comment"] });
    const res = await r.call("bash", { command: line });
    assert.equal(res?.block, true, mode);
    assert.equal(r.asked.length, 1, mode);
    assert.match(r.asked[0].title, /cause: floor-git-push-protected/);
    assert.equal(r.reg.calls.length, 0, mode);
  }
});

test("a deny rule blocks by name and a pattern ask rule opens a dialog without remember", async (t) => {
  const r = await rig(t, [V("allow", "A1")], { perms: { deny: ["Bash(evilcmd *)"], ask: ["Bash(somecmd *)"] }, selects: ["allow once"] });
  assert.match(String((await r.call("bash", { command: "evilcmd x" }))?.reason), /denied by the permission rule Bash\(evilcmd \*\)/);
  assert.equal(r.asked.length, 0);
  assert.equal(await r.call("bash", { command: "somecmd go" }), undefined);
  assert.match(r.asked[0].title, /cause: rule Bash\(somecmd \*\)/);
  assert.ok(!r.asked[0].options.includes("allow and remember"));
});

test("classifier allow runs the call and logs prose:A1; an identical repeat is a cache hit", async (t) => {
  const r = await rig(t, [V("allow", "A1")], { perms: PROSE });
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  const rec = r.log().find((x) => x.layer === "classifier")!;
  assert.deepEqual([rec.verdict, rec.rule], ["allow", "prose:A1"]);
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.equal(r.reg.calls.length, 1);
  assert.equal(r.log().at(-1)!.layer, "cache");
  assert.ok(r.events("review").length >= 1);
});

test("classifier deny blocks with the whitelist rule text and logs prose:D1", async (t) => {
  const r = await rig(t, [V("deny", "D1")], { perms: PROSE });
  const res = await r.call("bash", { command: DANGER });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /^pi-foreman: denied by whitelist rule D1: Never touch production state/);
  assert.equal(r.log().find((x) => x.layer === "classifier")!.rule, "prose:D1");
  assert.equal(r.asked.length, 0);
});

test("classifier escalate opens the dialog with the classifier's reason; failures and a missing model escalate too", async (t) => {
  const esc = await rig(t, [V("escalate", null)], { perms: PROSE, selects: ["allow once"] });
  assert.equal(await esc.call("bash", { command: DANGER }), undefined);
  assert.match(esc.asked[0].title, /cause: danger-deploy/);
  assert.match(esc.asked[0].title, /classifier: because null/);
  assert.deepEqual(esc.asked[0].options, ["allow once", "allow and remember", "deny with comment", "deny and stop"]);
  const gone = await rig(t, [new Error("boom")], { perms: PROSE });
  assert.equal((await gone.call("bash", { command: DANGER }))?.block, true);
  assert.equal(gone.asked.length, 1);
  assert.equal(gone.log().find((x) => x.layer === "classifier")!.rule, "provider_error");
  const none = await rig(t, [V("allow", "A1")], { perms: PROSE, found: false });
  await none.call("bash", { command: DANGER });
  assert.equal(none.log().find((x) => x.layer === "classifier")!.rule, "no_model");
});

test("allow and remember writes the sentence to the project file and clears the classifier cache", async (t) => {
  const r = await rig(t, [V("allow", "A1")], { perms: PROSE });
  execFileSync("git", ["init", "-q"], { cwd: r.project });
  fs.mkdirSync(path.join(r.project, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(r.project, ".git", "info", "exclude"), ".workflow/\n");
  assert.equal(await r.call("bash", { command: DANGER }), undefined); // classifier call 1, cached
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.equal(r.reg.calls.length, 1);
  // a second call the classifier escalates; the owner remembers it (sentence only)
  r.reg.calls.length = 0;
  const reg2 = fakeRegistry([V("escalate", null), V("allow", "A1")]);
  (r.ctx.modelRegistry as unknown as { complete: unknown }).complete = reg2.registry.complete;
  const answers = ["allow and remember", "use this sentence", "no"];
  (r.ctx.ui as { select: unknown }).select = async (title: string, options: string[]) => (r.asked.push({ title, options }), answers.shift());
  assert.equal(await r.call("bash", { command: "terraform destroy -auto-approve" }), undefined);
  const file = path.join(r.project, ".workflow", "permissions.json");
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as { classifier: { allow: string[] } };
  assert.equal(written.classifier.allow.length, 1);
  assert.match(written.classifier.allow[0], /terraform|deploy|cluster|service/i);
  // the cache was cleared by the write: the first command goes to the model again
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.equal(reg2.calls.length, 2);
});

test("remember is refused with a visible reason when the project file is not git-ignored; the call runs once", async (t) => {
  const r = await rig(t, [V("escalate", null)], { perms: PROSE, selects: ["allow and remember"] });
  const notes: string[] = [];
  (r.ctx.ui as { notify: unknown }).notify = (m: string) => void notes.push(m);
  assert.equal(await r.call("bash", { command: DANGER }), undefined);
  assert.ok(notes.some((n) => /not remembered/.test(n)), notes.join("|"));
  assert.ok(!fs.existsSync(path.join(r.project, ".workflow", "permissions.json")));
});

test("no UI: a dangerous call the classifier escalates, and an ask-kind floor, are denied at once with the no-pane text", async (t) => {
  const r = await rig(t, [V("escalate", null)], { perms: PROSE, hasUI: false });
  const res = await r.call("bash", { command: DANGER });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /nobody is at this session \(no pane\)\. The owner is absent/);
  assert.equal(r.asked.length, 0);
  const f = await r.call("bash", { command: OPAQUE_PUSH });
  assert.match(String(f?.reason), /nobody is at this session/);
});

test("deny and stop blocks every later gated call until the next user prompt", async (t) => {
  const r = await rig(t, [V("escalate", null)], { perms: PROSE, selects: ["deny and stop"] });
  assert.equal((await r.call("bash", { command: DANGER }))?.block, true);
  assert.match(String((await r.call("bash", { command: "somecmd" }))?.reason), /asked you to stop/);
  await r.ownerPrompt("go on");
  assert.equal(await r.call("bash", { command: "somecmd" }), undefined);
});

test("the log carries the shape, never the raw command, and the child session logs too", async (t) => {
  const r = await rig(t, [V("deny", "D1")], { child: true, perms: PROSE });
  await r.call("bash", { command: "curl -X POST -H 'Authorization: Bearer sk-abcdef0123456789abcdef' https://example.com/x" });
  const rec = r.log().at(-1)!;
  assert.equal(rec.kind, "child");
  assert.doesNotMatch(JSON.stringify(rec), /sk-abcdef|Bearer/);
});

// an opaque line naming a push to main: the floors ask (kind ask), they do not deny
const OPAQUE_PUSH = "$(echo git) push origin main";
const PERMS_NONE = { perms: { allow: [] } };
