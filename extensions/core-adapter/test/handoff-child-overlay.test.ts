// Item 3: the (old permoverlay) childBlockHit exemption for the child's own handoff dir, the launch binding's handoffDir round-trip,
// and the bare `work` entry staying parent-protected (writing INTO work/ is fine).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BINDINGS_ENV, BINDING_NS, bindLaunch, readBinding, recordUsageLaunch, stripBinding } from "../usage.ts";
import type { LaunchBinding } from "../usage.ts";
import { childHandoffWrite } from "../pathrules.ts";

// a real path (the path rules compare real spellings; /home is an automount on macOS)
const agentDir = path.join(fs.realpathSync(os.tmpdir()), "pf-ho-overlay", ".pi", "agent").replace(/\\/g, "/");
const H = `${agentDir}/pi-foreman/handoffs/h1`;

test("bare work entry: below work/ is writable, work itself (rm -rf / mv target) is not", () => {
  const id = (p: string): string | null => p;
  const w = (p: string): boolean => childHandoffWrite(H, p, p, "linux", id);
  assert.equal(w(`${H}/work/x`), true);
  assert.equal(w(`${H}/work`), false);
  assert.equal(w(`${H}/work/`), false);
  const win = (p: string): boolean => childHandoffWrite("C:\\h\\h1", p, p, "win32", id);
  assert.equal(win("C:\\h\\h1\\work\\x"), true);
  assert.equal(win("C:\\h\\h1\\WORK"), false);
  assert.equal(win("C:\\h\\h1\\work."), false);
});

test("launch binding handoffDir: writer -> env -> readBinding round-trip", () => {
  const registry = new Map<string, LaunchBinding>();
  const b = recordUsageLaunch(registry, { foremanSession: "fs1", workspace: "/ws", role: "builder", model: null });
  b.handoffDir = H;
  const input: Record<string, unknown> = { agent: "builder" };
  bindLaunch(input, b);
  const env = { [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) };
  assert.equal(readBinding(env)?.handoffDir, H);
  // win32 absolute spelling survives too; a relative one is dropped
  const win = { [BINDINGS_ENV]: JSON.stringify({ [BINDING_NS]: { ...b, handoffDir: "C:\\agent\\handoffs\\h1" } }) };
  assert.equal(readBinding(win)?.handoffDir, "C:\\agent\\handoffs\\h1");
  const rel = { [BINDINGS_ENV]: JSON.stringify({ [BINDING_NS]: { ...b, handoffDir: "rel/h1" } }) };
  assert.equal(readBinding(rel)?.handoffDir, undefined);
  // a foreman-supplied binding never survives
  stripBinding(input);
  assert.equal(input.extensionBindings, undefined);
});
