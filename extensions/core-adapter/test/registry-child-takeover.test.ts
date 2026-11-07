import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CORE_KEY, claimCore } from "../registry.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-childtakeover-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const mkRoot = (name: string): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "pi-foreman", version: "1.0.0" }));
  return d;
};
const rootA = mkRoot("root-a");
const rootB = mkRoot("root-b");
const off = (source: string) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });
// The develop-checkout layout of registry-trust-pass.test.ts: the project disables root A with an empty-filter override.
const cwd = path.join(tmp, "project");
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["..", off(rootA)] }));
const agentDir = path.join(tmp, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [rootA] }));

const rootOf = (g: Record<symbol, unknown>): string => (g[CORE_KEY] as { pkgRoot: string }).pkgRoot;

/** Run `fn` with PI_SUBAGENT_CHILD set (or deleted when `value` is undefined), restoring the previous state. */
const withChildEnv = (value: string | undefined, fn: () => void): void => {
  const prev = process.env.PI_SUBAGENT_CHILD;
  if (value === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prev;
  }
};

test("a subagent child stays inert against a not-started holder its project disables", () => {
  withChildEnv("1", () => {
    const g: Record<symbol, unknown> = {};
    const holder = claimCore(rootA, g, process.platform, cwd, agentDir);
    assert.ok(holder.active);
    const r = claimCore(rootB, g, process.platform, cwd, agentDir);
    assert.equal(r.active, false);
    assert.equal(rootOf(g), rootA);
    assert.equal(g[CORE_KEY], holder.active ? holder.claim : undefined);
  });
});

test("without the child env the same setup still takes over (#108)", () => {
  withChildEnv(undefined, () => {
    const g: Record<symbol, unknown> = {};
    claimCore(rootA, g, process.platform, cwd, agentDir);
    const r = claimCore(rootB, g, process.platform, cwd, agentDir);
    assert.ok(r.active);
    assert.equal(rootOf(g), rootB);
  });
});

test("a child re-claims its own root, also after release (/reload order)", () => {
  withChildEnv("1", () => {
    const g: Record<symbol, unknown> = {};
    const first = claimCore(rootA, g, process.platform, cwd, agentDir);
    assert.ok(first.active);
    assert.ok(claimCore(rootA, g, process.platform, cwd, agentDir).active);
    if (first.active) first.release();
    assert.ok(claimCore(rootA, g, process.platform, cwd, agentDir).active);
    assert.equal(rootOf(g), rootA);
  });
});
