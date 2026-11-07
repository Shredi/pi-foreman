import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CORE_KEY, DISPLACED_KEY, STARTED_KEY, claimCore, isDisplaced, markCoreStarted } from "../registry.ts";
import coreAdapter from "../index.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-displaced-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const mkRoot = (name: string): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "pi-foreman", version: "1.0.0" }));
  return d;
};
const holderRoot = mkRoot("holder");
const checkout = mkRoot("checkout");
const off = (source: string) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });
const project = (name: string, packages: unknown[]): string => {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages }));
  return cwd;
};
const agentDir = (name: string, packages: unknown[]): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ packages }));
  return d;
};

test("a takeover marks the displaced holder; the new claim is not displaced", () => {
  const g: Record<symbol, unknown> = {};
  const first = claimCore(holderRoot, g);
  const second = claimCore(checkout, g, process.platform, project("p1", ["..", off(holderRoot)]), agentDir("a1", [holderRoot]));
  assert.ok(first.active && second.active);
  if (!first.active || !second.active) return;
  assert.equal(isDisplaced(first.claim, g), true);
  assert.equal(isDisplaced(second.claim, g), false);
  assert.ok(g[DISPLACED_KEY]);
});

test("same-root re-claim does not displace; release then re-claim (the /reload order) leaves one active claim", () => {
  const g: Record<symbol, unknown> = {};
  const first = claimCore(holderRoot, g);
  const again = claimCore(holderRoot, g);
  assert.ok(first.active && again.active);
  if (!first.active || !again.active) return;
  assert.equal(isDisplaced(first.claim, g), false);
  assert.equal(isDisplaced(again.claim, g), false);
  again.release();
  const reloaded = claimCore(holderRoot, g);
  assert.ok(reloaded.active);
  if (!reloaded.active) return;
  assert.equal(isDisplaced(reloaded.claim, g), false);
  assert.equal(g[CORE_KEY], reloaded.claim);
});

test("a displaced adapter instance handles no session_start, never marks started, and notes once", async () => {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const saved = [g[CORE_KEY], g[STARTED_KEY], g[DISPLACED_KEY]];
  delete g[CORE_KEY];
  delete g[STARTED_KEY];
  delete g[DISPLACED_KEY];
  try {
    const handlers: Record<string, ((...a: unknown[]) => unknown)[]> = {};
    const fake = new Proxy({ on: (n: string, h: (...a: unknown[]) => unknown) => void (handlers[n] ??= []).push(h), events: { on: () => () => undefined, emit: () => undefined } } as Record<string, unknown>, { get: (t, p: string) => (p in t ? t[p] : () => undefined) });
    coreAdapter(fake as never);
    const mine = g[CORE_KEY] as { pkgRoot: string };
    assert.ok(mine);
    assert.ok(handlers.session_start?.length);
    // a second root takes over: registered by hand, as the takeover branch of claimCore does
    const other = { version: "1.0.0", pkgRoot: checkout, api: 1 };
    g[DISPLACED_KEY] = new WeakMap([[mine, other]]);
    g[CORE_KEY] = other;
    const notes: string[] = [];
    const ctx = { ui: { notify: (m: string) => notes.push(m) } };
    for (const h of handlers.session_start) await h({ reason: "startup" }, ctx);
    for (const h of handlers.session_start) await h({ reason: "startup" }, ctx);
    assert.equal(g[STARTED_KEY], undefined, "a displaced copy never marks itself started");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /core_displaced/);
    for (const h of handlers.session_shutdown ?? []) await h({}, ctx);
    assert.equal(g[CORE_KEY], other, "shutdown of the displaced copy does not release the holder's key");
    markCoreStarted(other as never, g);
  } finally {
    for (const [i, k] of [CORE_KEY, STARTED_KEY, DISPLACED_KEY].entries()) {
      if (saved[i] === undefined) delete g[k];
      else g[k] = saved[i];
    }
  }
});
