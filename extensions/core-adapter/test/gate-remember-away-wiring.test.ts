// perms-remember-away, wired through the adapter: the gate log's `reason` carries the dialog answer (owner side, child side, the parent's
// child-ask line), a child-ask dialog under a parent in mode allow offers no sentence, and a child denied because child asks are off reads
// the childAsk-off text, not the no-pane text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { gateLogFile } from "../gatelog.ts";
import { writeChildAsk } from "../childask.ts";
import { EXACT_OPTION } from "../gatedialog.ts";
import { NO_PANE_TEXT } from "../presencewait.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const ROLES = ["explorer", "builder", "reviewer"];
const INSTALL = "pip install requests"; // danger-install
const config = (gate?: Record<string, unknown>) => ({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, ...(gate ? { gate } : {}), presence: { enabled: false } });
const registry = (reply: string) => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const ESCALATE = JSON.stringify({ verdict: "escalate", entry: null, reason: "unsure" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
const logOf = (agentDir: string): Record<string, unknown>[] => {
  const f = gateLogFile(agentDir);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const writePerms = (agentDir: string, body: Record<string, unknown>): void => {
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-foreman", "permissions.json"), JSON.stringify(body));
};
const ignoreWorkflow = (project: string): void => {
  execFileSync("git", ["init", "-q"], { cwd: project });
  fs.mkdirSync(path.join(project, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(project, ".git", "info", "exclude"), ".workflow/\n");
};

/** An owner session in mode `mode`; select answers come from `pick(title, options)` (every title and option list is kept). */
async function owner(t: T, mode: string, pick: (options: string[]) => string | undefined) {
  const asked: { title: string; options: string[] }[] = [];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: async (title: string, options: string[]) => (asked.push({ title, options }), pick(options)),
    input: async () => "",
    editor: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry(ESCALATE) }, config: config() });
  writePerms(r.agentDir, { mode });
  return { ...r, asked };
}
const remembering = (options: string[]): string | undefined => (options.includes("use this sentence") ? "use this sentence" : options.includes("yes") ? "no" : "allow and remember");

test("the owner dialog's log line carries the answer: allow-once, allow-remember, and a refused remember", async (t) => {
  const once = await owner(t, "ask", () => "allow once");
  assert.equal(await once.call("bash", { command: INSTALL }), undefined);
  const rec = logOf(once.agentDir).filter((x) => x.layer === "dialog").at(-1)!;
  assert.deepEqual([rec.verdict, rec.reason], ["allow", "allow-once"]);

  const kept = await owner(t, "ask", remembering);
  ignoreWorkflow(kept.project);
  assert.equal(await kept.call("bash", { command: INSTALL }), undefined);
  assert.equal(logOf(kept.agentDir).filter((x) => x.layer === "dialog").at(-1)!.reason, "allow-remember");
  assert.ok(fs.existsSync(path.join(kept.project, ".workflow", "permissions.json")));

  const refused = await owner(t, "ask", remembering); // no git exclude: the write is refused
  assert.equal(await refused.call("bash", { command: INSTALL }), undefined);
  assert.equal(logOf(refused.agentDir).filter((x) => x.layer === "dialog").at(-1)!.reason, "allow-remember-refused");
  assert.equal(fs.existsSync(path.join(refused.project, ".workflow", "permissions.json")), false);
});

test("a denied dialog keeps its deny text as the log reason", async (t) => {
  const r = await owner(t, "ask", (o) => (o.includes("deny and stop") ? "deny and stop" : undefined));
  assert.equal((await r.call("bash", { command: INSTALL }))?.block, true);
  const rec = logOf(r.agentDir).filter((x) => x.layer === "dialog").at(-1)!;
  assert.deepEqual(rec.verdict, "deny");
  assert.match(String(rec.reason), /asked you to stop/);
});

/** A parent session whose launch has an ask dir, and one child ask written into it. */
async function parentWithAsk(t: T, mode: string, pick: (options: string[]) => string | undefined) {
  const r = await owner(t, mode, pick);
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(input);
  const b = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
  const askDir = b.askDir as string;
  const n = writeChildAsk(askDir, { tool: "bash", payload: INSTALL, cwd: "/w", session: "child-s", cause: "danger-install", reason: "unsure", entry: "", role: "builder", run: "L9" } as Parameters<typeof writeChildAsk>[1]);
  return { ...r, askDir, ruling: path.join(askDir, `ruling-${n}.md`) };
}

test("child-ask dialog under a parent in mode allow: no sentence option, the exact-command option stays; the parent's log line has the answer", async (t) => {
  const r = await parentWithAsk(t, "allow", (o) => (o.includes(EXACT_OPTION) ? "allow once" : undefined));
  await until(() => fs.existsSync(r.ruling));
  assert.equal(r.asked[0].options.includes("allow and remember"), false);
  assert.equal(r.asked[0].options.includes(EXACT_OPTION), true);
  const rec = await until(() => logOf(r.agentDir).find((x) => x.layer === "child-ask"));
  assert.match(String(rec.reason), /answered allow-once/);
});

test("child-ask dialog under a parent in mode auto: the sentence option is offered as before", async (t) => {
  const r = await parentWithAsk(t, "auto", () => "allow once");
  await until(() => fs.existsSync(r.ruling));
  assert.deepEqual(r.asked[0].options, ["allow once", "allow and remember", EXACT_OPTION, "deny with comment", "deny and stop"]);
});

// ------------------------------------------------------------------ the child side

/** A child session with a launch binding (`extra` fields, `askDir` optional); the review escalates. */
async function child(t: T, extra: Record<string, unknown>, gate?: Record<string, unknown>) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, ...extra } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  return r11Rig(t, {}, { ctx: { modelRegistry: registry(ESCALATE) }, config: config(gate), child: true });
}
const tmpDir = (t: T): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-away-ask-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const OFF = /gate\.childAsk/;
const denyOf = async (c: Awaited<ReturnType<typeof child>>) => {
  const res = await c.call("bash", { command: INSTALL });
  assert.equal(res?.block, true);
  const rec = logOf(c.agentDir).filter((x) => x.layer === "dialog").at(-1)!;
  assert.deepEqual([rec.verdict, rec.rule], ["deny", "danger-install"]);
  return String(res?.reason);
};

test("child, own config gate.childAsk deny: the deny names the key and the cause, not the owner's absence", async (t) => {
  const text = await denyOf(await child(t, { askDir: tmpDir(t) }, { childAsk: "deny" }));
  assert.match(text, OFF);
  assert.match(text, /Report this line to the foreman/);
  assert.match(text, /The call was: danger-install/);
  assert.doesNotMatch(text, /absent|no pane/);
});

test("child, binding marker `deny` (the parent launched it with child asks off): the same text", async (t) => {
  const text = await denyOf(await child(t, { noAsk: "deny" }));
  assert.match(text, OFF);
  assert.match(text, /The call was: danger-install/);
  assert.doesNotMatch(text, /absent|no pane/);
});

test("child, binding marker `no-pane` (the parent has no UI): the no-pane text; the binding of a headless parent carries it", async (t) => {
  const text = await denyOf(await child(t, { noAsk: "no-pane" }));
  assert.equal(text, `${NO_PANE_TEXT} The call was: danger-install: installs, runs or removes software from a package registry.`);
  const head = await r11Rig(t, {}, { ctx: { hasUI: false, mode: "print", modelRegistry: registry(ESCALATE) }, config: config() });
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  await head.launch(input);
  const b = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
  assert.deepEqual([b.askDir, b.noAsk], [undefined, "no-pane"]);
  const off = await r11Rig(t, {}, { ctx: { modelRegistry: registry(ESCALATE) }, config: config({ childAsk: "deny" }) });
  const input2: Record<string, unknown> = { agent: "builder", task: "go" };
  await off.launch(input2);
  const b2 = (input2.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
  assert.deepEqual([b2.askDir, b2.noAsk], [undefined, "deny"]);
});

test("child, binding without marker and without an ask dir: today's no-pane text", async (t) => {
  const text = await denyOf(await child(t, {}));
  assert.equal(text, `${NO_PANE_TEXT} The call was: danger-install: installs, runs or removes software from a package registry.`);
});
