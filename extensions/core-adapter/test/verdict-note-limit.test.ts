// D224: a review_verdict note that would take its item line over 1000 characters is refused.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureSessionMarker, markerPath } from "../marker.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

async function call(t: Parameters<typeof r11Rig>[0], note: string): Promise<{ text: string; isError?: boolean }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-d224-"));
  const saved = process.env[BINDINGS_ENV];
  t.after(() => {
    if (saved === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "reviewer", launchId: "l1", kind: "first", workspace: "", verdictDir: dir, items: [1] } });
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const r = await r11Rig(t, { ledgerHelper: "tool" }, { child: true, config: { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { reviewer: { model: "fake/reviewer" } } } } }, piExtra: { registerTool: (d: { name: string; execute: never }) => void tools.set(d.name, d as never), registerCommand: () => undefined } });
  const ledger = path.join(dir, "LEDGER-d224.md");
  fs.writeFileSync(ledger, `# LEDGER d224\n\n- [ ] 1. ${"t".repeat(900)}\n- [ ] V. fresh-eyes verification passed\n`);
  const stateDir = path.join(r.agentDir, "pi-foreman", "state");
  ensureSessionMarker(stateDir, "parent-session", 1);
  const file = markerPath(stateDir, "parent-session");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ledger }));
  const res = await tools.get("review_verdict")!.execute("id", { verdict: "pass", items: [{ id: 1, result: "open", note }] }, undefined, undefined, r.ctx);
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError };
}

test("D224: a note past the item-line limit is refused with the file hint", async (t) => {
  const r = await call(t, "n".repeat(150));
  assert.equal(r.isError, true);
  assert.match(r.text, /the note of item 1/);
  assert.match(r.text, /keep evidence in a file and link it/);
});

test("D224: a short note passes", async (t) => {
  const r = await call(t, "see the file");
  assert.notEqual(r.isError, true, r.text);
});
