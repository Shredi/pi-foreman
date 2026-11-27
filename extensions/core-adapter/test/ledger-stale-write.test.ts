// D181: a host `write` over the bound ledger is refused when the file is not as this session last read (in full) or wrote it;
// an `edit` is not; a new ledger is not; ledger.py and the upsert running together lose nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeHint } from "../hints.ts";
import { boundLedger } from "../marker.ts";
import { setup } from "./_hsrig.ts";
import type { Rig } from "./_hsrig.ts";

type Block = { block?: boolean; reason?: string } | undefined;
let n = 0;

const call = async (a: Rig, toolName: string, input: Record<string, unknown>, outcome: { details?: unknown } = {}): Promise<Block> => {
  const id = `sw${++n}`;
  const res = (await a.fire("tool_call", { toolName, toolCallId: id, input })) as Block;
  if (res?.block) return res;
  await a.fire("tool_result", { toolName, toolCallId: id, input, details: outcome.details ?? {}, content: [{ type: "text", text: "ok" }], isError: false });
  return res;
};

async function rig(t: Parameters<typeof setup>[0]) {
  const s = await setup(t);
  const file = path.join(fs.realpathSync.native(s.w.project), ".workflow", "LEDGER-x.md");
  const state = path.join(path.dirname(s.w.project), "agent", "pi-foreman", "state");
  assert.equal(boundLedger(state, s.a.ctx.sessionManager.getSessionId()), file, "the ledger is bound");
  return { ...s, file };
}

test("an outside edit after the read: the write from the old copy is refused and the outside edit stays", async (t) => {
  const { a, file } = await rig(t);
  await call(a, "read", { path: file });
  fs.appendFileSync(file, "- [ ] 2. outside\n");
  const res = await call(a, "write", { path: file, content: "# old copy\n" });
  assert.equal(res?.block, true);
  assert.match(res?.reason ?? "", /changed on disk since this session last read or wrote it/);
  assert.match(fs.readFileSync(file, "utf8"), /2\. outside/);
});

test("a harness note after the read: the write is refused, the note stays; after a fresh read the write passes", async (t) => {
  const { a, file } = await rig(t);
  await call(a, "read", { path: file });
  assert.deepEqual(writeHint(file, ["1"], "ledger mark"), ["1"]);
  const res = await call(a, "write", { path: file, content: "# old copy\n" });
  assert.equal(res?.block, true);
  assert.match(fs.readFileSync(file, "utf8"), /ledger mark/);
  await call(a, "read", { path: file });
  assert.equal(await call(a, "write", { path: file, content: "# fresh\n- [x] 1. item\n" }), undefined);
});

test("a partial read leaves the stamp as it is", async (t) => {
  const { a, file } = await rig(t);
  await call(a, "read", { path: file });
  fs.appendFileSync(file, "- [ ] 2. outside\n");
  await call(a, "read", { path: file, limit: 2 });
  assert.equal((await call(a, "write", { path: file, content: "x\n" }))?.block, true);
  await call(a, "read", { path: file }, { details: { truncation: { truncated: true } } });
  assert.equal((await call(a, "write", { path: file, content: "x\n" }))?.block, true);
});

test("no read since the restart: the write is refused", async (t) => {
  const { file, w } = await rig(t);
  const b = await w.adapter("resume");
  assert.equal((await call(b, "write", { path: file, content: "x\n" }))?.block, true);
});

test("the session's own write keeps its stamp; a new ledger write passes; an edit after an outside change passes", async (t) => {
  const { a, file, w } = await rig(t);
  assert.equal(await call(a, "write", { path: file, content: "# Ledger: x\nTier: standard\n\n- [ ] 1. item\n" }), undefined);
  assert.equal(await call(a, "write", { path: file, content: "# Ledger: x\nTier: standard\n\n- [ ] 1. item two\n" }), undefined);
  fs.appendFileSync(file, "- [ ] 2. outside\n");
  assert.equal(await call(a, "edit", { path: file, edits: [{ oldText: "item two", newText: "item 2" }] }), undefined);
  const fresh = path.join(w.project, ".workflow", "LEDGER-new.md");
  assert.equal(await call(a, "write", { path: fresh, content: "# Ledger: new\n" }), undefined);
});

test("ledger.py in a second process and the upsert together lose nothing", async (t) => {
  const { a, file } = await rig(t);
  // ledger.py holds no lock itself (core/ is pinned); the shim does, with the same lock file as the upsert
  const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "ledger");
  const adds = new Promise<number>((resolve) => {
    const code = `for i in $(seq 0 24); do sh ${JSON.stringify(shim)} -f ${JSON.stringify(file)} add py$i >/dev/null || exit 1; done`;
    spawn("sh", ["-c", code], { stdio: "inherit", env: { ...process.env, PI_FOREMAN_PYTHON: process.platform === "win32" ? "python" : "python3" } }).on("exit", (c) => resolve(c ?? 1));
  });
  const tool = a.tool("foreman_ledger")!;
  for (let i = 0; i < 25; i++) await tool.execute(`u${i}`, { action: "upsert", item: "1", text: `item up${i}` }, undefined, undefined, a.ctx);
  assert.equal(await adds, 0);
  const text = fs.readFileSync(file, "utf8");
  for (let i = 0; i < 25; i++) assert.match(text, new RegExp(` py${i}\\n`));
  assert.match(text, /item up24/);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
