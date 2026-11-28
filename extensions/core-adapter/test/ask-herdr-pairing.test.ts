// The bundled @juicesharp/rpiv-ask-user-question (2.16.0+) emits `herdr:blocked` itself. Herdr counts each `active: true`
// until its `active: false`, so every true the package emits must be paired with a false, however the dialog ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

type Tool = { name: string; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown> };
type Blocked = { active: boolean; label?: string };

const PARAMS = { questions: [{ question: "Which database?", header: "DB", options: [{ label: "pg", description: "Postgres" }, { label: "sqlite", description: "SQLite" }] }] };
const CANCEL = { answers: [], cancelled: true };
const ANSWER = { answers: [{ questionIndex: 0, question: "Which database?", kind: "option", answer: "pg" }], cancelled: false };

async function load() {
  // Loaded the way Pi loads it (jiti): node does not strip types below node_modules.
  const addon = await createJiti(import.meta.url).import<{ default(pi: never): void }>("@juicesharp/rpiv-ask-user-question");
  const tools: Tool[] = [];
  const blocked: Blocked[] = [];
  const pi = {
    registerTool: (d: Tool) => { tools.push(d); },
    on: () => {},
    events: { emit: (ch: string, d: unknown) => { if (ch === "herdr:blocked") blocked.push(d as Blocked); }, on: () => () => {} },
  };
  addon.default(pi as never);
  const tool = tools.find((x) => x.name === "ask_user_question");
  assert.ok(tool, "the add-on registers ask_user_question");
  return { tool, blocked };
}

const count = (b: Blocked[], active: boolean) => b.filter((e) => e.active === active).length;
const ctxWith = (custom: (f: unknown, o: unknown) => Promise<unknown>) =>
  ({ hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => false, ui: { custom, notify: () => {} } });

for (const [name, result] of [["answered", ANSWER], ["cancelled", CANCEL]] as const) {
  test(`herdr:blocked events are balanced when the dialog is ${name}`, async () => {
    const { tool, blocked } = await load();
    let mounted!: () => void;
    let release!: (r: unknown) => void;
    const up = new Promise<void>((r) => { mounted = r; });
    const done = tool.execute("p1", PARAMS, undefined, undefined, ctxWith(() => new Promise((r) => { release = r; mounted(); })));
    await up;
    assert.equal(count(blocked, true), 1, "one true while the dialog is open");
    assert.equal(count(blocked, false), 0);
    release(result);
    await done;
    assert.equal(count(blocked, true), 1);
    assert.equal(count(blocked, false), 1);
  });
}

test("herdr:blocked events are balanced when the dialog throws", async () => {
  const { tool, blocked } = await load();
  await tool.execute("p2", PARAMS, undefined, undefined, ctxWith(() => Promise.reject(new Error("render failed")))).catch(() => undefined);
  assert.equal(count(blocked, true), count(blocked, false));
  assert.ok(count(blocked, true) >= 1);
});

test("herdr:blocked events are balanced for two questions open at once (inline and overlay)", async () => {
  const { tool, blocked } = await load();
  const releases: ((r: unknown) => void)[] = [];
  let mounted2!: () => void;
  const second = new Promise<void>((r) => { mounted2 = r; });
  const ctx = ctxWith(() => new Promise((r) => { releases.push(r); if (releases.length === 2) mounted2(); }));
  const a = tool.execute("p3", PARAMS, undefined, undefined, ctx);
  await new Promise((r) => setTimeout(r, 200));
  const b = tool.execute("p4", PARAMS, undefined, undefined, ctx);
  await second;
  assert.equal(count(blocked, true), 2);
  releases.forEach((r) => r(CANCEL));
  await Promise.all([a, b]);
  assert.equal(count(blocked, true), 2);
  assert.equal(count(blocked, false), 2);
});
