// D177: the "takes no items" refusal of a normal launch names the fix (launch the reviewer with items: [...]); the high-stakes text stays as it is.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

async function call(t: Parameters<typeof r11Rig>[0], extra: Record<string, unknown>, params: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-d177-"));
  const saved = process.env[BINDINGS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "l1", kind: "first", workspace: "", verdictDir: dir, ...extra } });
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const r = await r11Rig(t, { ledgerHelper: "tool" }, { child: true, config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } }, piExtra: { registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never), registerCommand: () => undefined } });
  const res = await tools.get("review_verdict")!.execute("id", params, undefined, undefined, r.ctx);
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
}

const withItem = { verdict: "pass", items: [{ id: 1, result: "pass" }] };

test("a normal launch with no items: giving an item is refused and the text says to launch the reviewer with items: [...]", async (t) => {
  const r = await call(t, { items: [] }, withItem);
  assert.equal(r.isError, true);
  assert.match(r.text, /item 1 is not one of this launch's items: this launch takes no items/);
  assert.match(r.text, /launches the reviewer with items: \[\.\.\.\]/);
});

test("a high-stakes launch keeps its text without the fix; a verdict without items is accepted", async (t) => {
  const hs = await call(t, { items: [1], highStakes: true }, withItem);
  assert.equal(hs.isError, true);
  assert.match(hs.text, /this launch takes no items/);
  assert.doesNotMatch(hs.text, /items: \[\.\.\.\]/);
  const none = await call(t, { items: [] }, { verdict: "pass" });
  assert.notEqual(none.isError, true, none.text);
});
