// Item 3: the permoverlay childBlockHit exemption for the child's own handoff dir, the launch binding's handoffDir round-trip,
// and the bare `work` entry staying parent-protected (writing INTO work/ is fine).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { BINDINGS_ENV, BINDING_NS, bindLaunch, readBinding, recordUsageLaunch, stripBinding } from "../usage.ts";
import type { LaunchBinding } from "../usage.ts";
import { childHandoffWrite } from "../pathrules.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
// a real path (the overlay resolves real spellings; /home is an automount on macOS)
const agentDir = path.join(fs.realpathSync(os.tmpdir()), "pf-ho-overlay", ".pi", "agent").replace(/\\/g, "/");
const H = `${agentDir}/pi-foreman/handoffs/h1`;
const rules = buildOverlayRules(baseline, {}, {}, agentDir, "/pkg", undefined, false);
const ctx = (extra: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: "/ws/repo", home: "/home/u", platform: process.platform === "win32" ? "win32" : "linux", role: "child", exists: () => false, isDir: () => false, realpath: (p) => p, list: () => [], ...extra });
const write = (name: string, c: MatchCtx) => checkToolCall(rules, "write", { path: `${H}/${name}`, content: "x" }, c);

test("child with handoffDir: allow-list names pass the childBlock, parent-owned names stay blocked", () => {
  const c = ctx({ handoffDir: H });
  for (const n of ["plan.md", "result.md", "ask.md", "ask-2.md", ".ask", ".seen", ".steer-last-read.json", "work/a/b.txt"]) assert.notEqual(write(n, c)?.kind, "deny", `${n}: ${JSON.stringify(write(n, c))}`);
  for (const n of ["ruling.md", "brief-1.md", "steer.md", "close.json", "parent", "child"]) assert.equal(write(n, c)?.kind, "deny", n);
});

test("child without handoffDir keeps today's rules for the same names", () => {
  assert.equal(write("ask.md", ctx())?.kind, "deny");
  assert.equal(write("ruling.md", ctx())?.kind, "deny");
});

test("child with handoffDir: another session's handoff dir is not exempt", () => {
  const other = checkToolCall(rules, "write", { path: `${agentDir}/pi-foreman/handoffs/h2/ask.md`, content: "x" }, ctx({ handoffDir: H }));
  assert.equal(other?.kind, "deny");
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
  // the dir entry cannot be removed or replaced by a link to elsewhere
  for (const cmd of [`rm -rf ${H}/work`, `mv ${H}/work /tmp/x`, `ln -sfn /tmp/x ${H}/work`]) {
    assert.equal(checkToolCall(rules, "bash", { command: cmd }, ctx({ handoffDir: H }))?.kind, "deny", cmd);
  }
});
