// The bundled @juicesharp/rpiv-ask-user-question passes `blocked` to ctx.ui.custom, so Pi reports the session as blocked
// on a question while the dialog is open (inline and overlay). Fails against the npm 2.15.0 package, which passes none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

type Tool = { name: string; execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown> };
type Options = { overlay?: boolean; blocked?: { kind?: unknown; message?: unknown } };

const PARAMS = { questions: [{ question: "Which database?", header: "DB", options: [{ label: "pg", description: "Postgres" }, { label: "sqlite", description: "SQLite" }] }] };
const CANCEL = { answers: [], cancelled: true };

async function addonTool(): Promise<Tool> {
  // Loaded the way Pi loads it (jiti): node does not strip types below node_modules.
  const addon = await createJiti(import.meta.url).import<{ default(pi: never): void }>("@juicesharp/rpiv-ask-user-question");
  const tools: Tool[] = [];
  const pi = { registerTool: (d: Tool) => void tools.push(d), on: () => {}, events: { emit: () => {}, on: () => () => {} } };
  addon.default(pi as never);
  const tool = tools.find((x) => x.name === "ask_user_question");
  assert.ok(tool, "the add-on registers ask_user_question");
  return tool;
}

function assertBlocked(o: Options | undefined, overlay: boolean) {
  assert.ok(o, "ctx.ui.custom got an options object");
  assert.equal(o.overlay, overlay);
  assert.equal(o.blocked?.kind, "question");
  assert.equal(typeof o.blocked?.message, "string");
  assert.ok((o.blocked!.message as string).trim().length > 0, "blocked.message is not empty");
}

test("ask_user_question mounts its dialog with blocked: { kind: 'question', message } inline and as an overlay", async () => {
  const tool = await addonTool();
  const seen: Options[] = [];
  let releaseFirst!: (r: unknown) => void;
  let firstMounted!: () => void;
  let secondMounted!: () => void;
  const firstUp = new Promise<void>((resolve) => { firstMounted = resolve; });
  const second = new Promise<void>((resolve) => { secondMounted = resolve; });
  // The first dialog holds the inline slot until the second one, which then has to mount as an overlay, was seen.
  const custom = (_factory: unknown, options: Options) => {
    seen.push(options);
    if (seen.length === 1) return new Promise((resolve) => { releaseFirst = resolve; firstMounted(); });
    secondMounted();
    return Promise.resolve(CANCEL);
  };
  const ctx = { hasUI: true, mode: "tui", cwd: process.cwd(), isProjectTrusted: () => false, ui: { custom, notify: () => {} } };
  const first = tool.execute("a1", PARAMS, undefined, undefined, ctx);
  await firstUp;
  const other = tool.execute("a2", PARAMS, undefined, undefined, ctx);
  await second;
  releaseFirst(CANCEL);
  await Promise.all([first, other]);
  assert.equal(seen.length, 2);
  assertBlocked(seen[0], false);
  assertBlocked(seen[1], true);
});
