// Plan asks-wait-for-owner D3: a run that ends while its child waits on the owner keeps the question (dir, watch and dialog stay); the owner's answer is parked
// for exactly that call (launch + tool + cwd + input hash, once, memory only) and applies when the resumed run asks again. Parent rig with held dialogs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { readChildAsk, writeChildAsk } from "../childask.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";

type T = Parameters<typeof r11Rig>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
const FIELDS = { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", role: "builder", cause: "no rule matches", reason: "r", inputHash: "h1" };
const ruling = (dir: string, n: number): string => path.join(dir, `ruling-${n}.md`);
const firstLine = (file: string): string => fs.readFileSync(file, "utf8").split("\n")[0];

function registry() {
  return { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ verdict: "allow", entry: "x", reason: "x" }) }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
}
const ROLES = ["explorer", "builder", "reviewer"];
const cfg = () => ({ providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false } });

type Sent = { customType?: string; content?: string };

/** A parent whose dialogs stay open until `pending[i]` is called; `sent` collects the custom messages the adapter sends. */
async function parentRig(t: T) {
  const titles: string[] = [];
  const pending: ((v: string | undefined) => void)[] = [];
  const sent: Sent[] = [];
  const ui = {
    notify: () => undefined,
    confirm: async () => false,
    select: (title: string, _o: string[], opts?: { signal?: AbortSignal }) =>
      new Promise<string | undefined>((res) => {
        titles.push(title);
        pending.push(res);
        opts?.signal?.addEventListener("abort", () => res(undefined), { once: true });
      }),
    input: async () => undefined,
    setStatus: () => undefined,
    setWidget: () => undefined,
  };
  const r = await r11Rig(t, {}, { ctx: { ui, modelRegistry: registry() }, config: cfg(), piExtra: { sendMessage: (m: Sent) => void sent.push(m) } });
  const launch = async () => {
    const input: Record<string, unknown> = { agent: "builder", task: "go" };
    const { id } = await r.launch(input);
    const b = (input.extensionBindings as Record<string, Record<string, unknown>>)[BINDING_NS];
    return { id, input, askDir: b.askDir as string, launchId: b.launchId as string };
  };
  const resume = async (runId: string) => {
    const input: Record<string, unknown> = { action: "resume", id: runId, message: "go on" };
    const { id } = await r.launch(input);
    return { id, input };
  };
  const ofType = (type: string) => sent.filter((m) => m.customType === type);
  return { ...r, titles, pending, sent, launch, resume, ofType };
}
type Rig = Awaited<ReturnType<typeof parentRig>>;

const OPEN = "pi-foreman-ask-open";
const ANSWERED = "pi-foreman-ask-answered";

/** A launch whose run `runId` waits with a shown dialog for `FIELDS` (+ `over`). */
async function waiting(r: Rig, runId: string, over: Partial<typeof FIELDS> = {}) {
  const l = await r.launch();
  await r.started(l.id, l.input, runId);
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId, ...over });
  const shown = r.titles.length;
  await until(() => r.titles.length === shown + 1);
  return l;
}

test("run end event with an open ask: dir, watch and dialog stay; the owner's answer is written as the ruling; one notice line says the question is open", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  assert.ok(fs.existsSync(l.askDir), "the dir stays");
  assert.equal(r.ofType(OPEN).length, 1);
  assert.match(String(r.ofType(OPEN)[0].content), /the run ended while waiting for the owner on bash: pip install requests; the question is still open, do not work around it/);
  r.pending[0]("allow once");
  await until(() => fs.existsSync(l.askDir) === false);
});

test("foreground run: the launch's tool result with an open ask keeps dir and dialog and carries the notice line", async (t) => {
  const r = await parentRig(t);
  const l = await r.launch();
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => r.titles.length === 1);
  r.end({ runId: "run-2" }); // the run end comes before the tool result: nothing to finish yet
  const res = (await r.started(l.id, l.input, "run-2")) as { content?: { text?: string }[] } | undefined;
  assert.ok(fs.existsSync(l.askDir), "the dir stays");
  assert.match((res?.content ?? []).map((c) => c.text).join("\n"), /the run ended while waiting for the owner on bash: pip install requests; the question is still open, do not work around it/);
  r.pending[0]("allow once");
  await until(() => fs.existsSync(l.askDir) === false);
});

test("a run that ends with no open ask is cleaned up as today (event and foreground result), without the notice line", async (t) => {
  const r = await parentRig(t);
  const a = await r.launch();
  await r.started(a.id, a.input, "run-a");
  r.end({ runId: "run-a" });
  assert.equal(fs.existsSync(a.askDir), false);
  const b = await r.launch();
  r.end({ runId: "run-b" });
  const res = (await r.started(b.id, b.input, "run-b")) as { content?: { text?: string }[] } | undefined;
  assert.equal(fs.existsSync(b.askDir), false);
  assert.doesNotMatch((res?.content ?? []).map((c) => c.text).join("\n"), /still open/);
  assert.equal(r.ofType(OPEN).length, 0);
});

test("the answer to a dialog of an ended run wakes the parent once with a notice that is data", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await sleep(60);
  assert.equal(r.ofType(ANSWERED).length, 1);
  const text = String(r.ofType(ANSWERED)[0].content);
  assert.match(text, /the owner answered/);
  assert.match(text, /the run can be resumed/i);
  assert.doesNotMatch(text, /you must|please/i);
  assert.equal(fs.existsSync(l.askDir), false, "the dir goes with the answer; a recognised resume re-creates it");
});

test("resume re-adds the watch and shows a new ask, never the answered one", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-1");
  assert.ok(fs.existsSync(l.askDir));
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId, payload: "pip install flask", inputHash: "h2" });
  await until(() => r.titles.length === 2);
  assert.match(r.titles[1], /pip install flask/);
  assert.equal(r.titles.filter((x) => /pip install requests/.test(x)).length, 1, "the answered ask is not shown again");
});

test("after the owner answers the ask of an ended run the dir is gone", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  assert.ok(fs.existsSync(l.askDir), "the dir stays while the dialog is open");
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  assert.equal(fs.existsSync(l.askDir), false);
});

test("a recognised resume re-creates the dir and the identical re-ask is answered from the parked entry without a dialog", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  assert.equal(fs.existsSync(l.askDir), false);
  await r.resume("run-1");
  assert.ok(fs.existsSync(l.askDir));
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => fs.existsSync(ruling(l.askDir, 1)));
  assert.equal(firstLine(ruling(l.askDir, 1)), "ALLOW");
  assert.equal(r.titles.length, 1, "no dialog for the parked answer");
});

test("a child whose resume was not recognised gets the gone denial, no dialog, and does not hang", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-"); // shortened run id: not recognised, nothing re-creates the dir
  const c = await childRig(t, l.askDir, {});
  const res = await c.call("bash", { command: "git branch -D old-topic" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /the session that started this helper has ended or no longer watches it/);
  assert.equal(fs.existsSync(l.askDir), false);
  assert.equal(r.titles.length, 1, "no dialog");
});

test("resume of a run that ended cleanly recreates the ask dir and watches it", async (t) => {
  const r = await parentRig(t);
  const l = await r.launch();
  await r.started(l.id, l.input, "run-1");
  r.end({ runId: "run-1" });
  assert.equal(fs.existsSync(l.askDir), false);
  await r.resume("run-1");
  assert.ok(fs.existsSync(l.askDir));
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => r.titles.length === 1);
});

test("an identical re-ask of the resumed run is answered without a dialog and the entry is gone: the third identical ask shows a dialog", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-1");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => fs.existsSync(ruling(l.askDir, 1)));
  assert.equal(firstLine(ruling(l.askDir, 1)), "ALLOW");
  assert.equal(r.titles.length, 1, "no dialog for the parked answer");
  const used = await until(() => r.events("ask_parked_used")[0]);
  assert.equal(used.decision, "allow");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => r.titles.length === 2);
  assert.equal(fs.existsSync(ruling(l.askDir, 2)), false);
});

test("a parked deny denies once", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("deny with comment");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-1");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => fs.existsSync(ruling(l.askDir, 1)));
  assert.equal(firstLine(ruling(l.askDir, 1)), "DENY");
  assert.equal(r.titles.length, 1);
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId });
  await until(() => r.titles.length === 2);
});

test("the same path with different edits (another input hash) asks", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-1");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId, inputHash: "h-other" });
  await until(() => r.titles.length === 2);
  assert.equal(fs.existsSync(ruling(l.askDir, 2)), false);
});

test("a changed cwd asks", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  await r.resume("run-1");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId, cwd: "/elsewhere" });
  await until(() => r.titles.length === 2);
});

test("another launch asks", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1");
  const other = await r.launch();
  await r.started(other.id, other.input, "run-9");
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => r.ofType(ANSWERED).length === 1);
  writeChildAsk(other.askDir, { ...FIELDS, run: other.launchId });
  await until(() => r.titles.length === 2);
  assert.equal(fs.existsSync(ruling(other.askDir, 1)), false);
  assert.notEqual(l.launchId, other.launchId);
});

test("an ask without the hash field is never parked: no wake notice and the re-ask shows a dialog", async (t) => {
  const r = await parentRig(t);
  const l = await waiting(r, "run-1", { inputHash: undefined } as never);
  r.end({ runId: "run-1" });
  r.pending[0]("allow once");
  await until(() => fs.existsSync(l.askDir) === false);
  await r.resume("run-1");
  writeChildAsk(l.askDir, { ...FIELDS, run: l.launchId, inputHash: undefined } as never);
  await until(() => r.titles.length === 2);
  assert.equal(r.ofType(ANSWERED).length, 0);
});

// ------------------------------------------------------------------ child side: the hash of the whole input

async function childRig(t: T, askDir: string, ctx: Record<string, unknown>) {
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, askDir } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  const escalate = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "because" });
  const reg = { ...registry(), complete: async () => ({ content: [{ type: "text", text: escalate }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
  return r11Rig(t, {}, { ctx: { modelRegistry: reg, ...ctx }, config: cfg(), child: true });
}

test("child gate: ask.md carries a hash of the whole tool input; another field or value changes it, key order does not", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-ask-hash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hashes: (string | undefined)[] = [];
  for (const input of [{ command: "git branch -D old-topic", timeout: 5 }, { timeout: 5, command: "git branch -D old-topic" }, { command: "git branch -D old-topic", timeout: 6 }]) {
    const ac = new AbortController();
    const r = await childRig(t, dir, { signal: ac.signal });
    const p = r.call("bash", input);
    const n = hashes.length + 1;
    await until(() => readChildAsk(dir)?.n === n);
    hashes.push(readChildAsk(dir)?.inputHash);
    ac.abort();
    await p;
  }
  assert.match(String(hashes[0]), /^[0-9a-f]{64}$/);
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], hashes[2]);
});
