import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { boundLedger, ensureSessionMarker, isLedgerTarget, markerPath } from "../marker.ts";
import { registerViaGlobalRegistry } from "../childext.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pf-adapter-"));
}

test("session marker: core file name, started kept on re-run, binding read back", () => {
  const dir = tmp();
  const first = ensureSessionMarker(dir, "01ab-cd_ef!", 1000.12345);
  assert.equal(first.created, true);
  assert.equal(path.basename(first.path), "fable-orch-model-01ab-cd_ef.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, "utf8")), { session_id: "01ab-cd_ef!", started: 1000.123 });
  const ledger = path.join(dir, ".workflow", "LEDGER-t.md");
  fs.mkdirSync(path.dirname(ledger));
  fs.writeFileSync(ledger, "- [ ] 1. x\n");
  fs.writeFileSync(first.path, JSON.stringify({ session_id: "s", started: 5, ledger }));
  assert.equal(ensureSessionMarker(dir, "01ab-cd_ef!", 9999).created, false);
  assert.equal(JSON.parse(fs.readFileSync(markerPath(dir, "01ab-cd_ef!"), "utf8")).started, 5);
  assert.equal(boundLedger(dir, "01ab-cd_ef!"), ledger);
  assert.equal(isLedgerTarget(ledger), true);
  assert.equal(isLedgerTarget(path.join(dir, ".workflow", "LEDGER-t-archive.md")), false);
  assert.equal(isLedgerTarget(path.join(dir, "LEDGER-t.md")), false);
});

test("required child extensions: fallback registry stamps requireForAllRunners and disposes", () => {
  const dir = tmp();
  const file = path.join(dir, "ext.ts");
  fs.writeFileSync(file, "export default () => {}\n");
  const reg = registerViaGlobalRegistry({ sessionId: "sess-x", extensions: [{ id: "pf", path: file }], requireForAllRunners: true });
  const store = (globalThis as unknown as Record<symbol, { bySession: Map<string, Array<Record<string, unknown>>> }>)[Symbol.for("pi-subagents.required-child-extensions.v1")];
  const entry = store.bySession.get("sess-x")![0];
  assert.equal(entry.requireForAllRunners, true);
  assert.equal(entry.path, fs.realpathSync(file));
  assert.throws(() => registerViaGlobalRegistry({ sessionId: "sess-x", extensions: [{ id: "pf", path: file }] }), /already registered/);
  reg.dispose();
  assert.equal(store.bySession.has("sess-x"), false);
  assert.throws(() => registerViaGlobalRegistry({ sessionId: "s2", extensions: [{ id: "pf", path: path.join(dir, "missing.ts") }] }), /not an importable file/);
});
