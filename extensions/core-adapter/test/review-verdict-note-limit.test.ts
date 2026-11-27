// D224: a verdict note that would take an item line over the limit is refused to the reviewer child, whose own marker names no ledger: the ledger is the parent's.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ensureSessionMarker, markerPath } from "../marker.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

test("only the foreman session has the ledger bound: an over-limit note of an open item is refused", async (t) => {
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
  const state = path.join(r.agentDir, "pi-foreman", "state");
  const ledger = path.join(r.project, "LEDGER-note.md");
  fs.writeFileSync(ledger, `# L\n\n- [ ] 1. ${"L".repeat(900)}\n`);
  ensureSessionMarker(state, "parent-session", 1);
  const file = markerPath(state, "parent-session");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ledger }));
  const res = await tools.get("review_verdict")!.execute("id", { verdict: "pass", items: [{ id: 1, result: "open", note: "n".repeat(200) }] }, undefined, undefined, r.ctx);
  const text = res.content.map((c) => c.text).join("\n");
  assert.equal(res.isError, true, text);
  assert.match(text, /the note of item 1: .*keep evidence in a file and link it\. Shorten the note or leave it out\./);
});
