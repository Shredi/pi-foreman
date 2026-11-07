import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CORE_KEY, STARTED_KEY, claimCore, markCoreStarted } from "../registry.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-trustpass-")));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const mkRoot = (name: string): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "pi-foreman", version: "1.0.0" }));
  return d;
};
const userRoot = mkRoot("user-copy");
const checkout = mkRoot("checkout");
const projectWith = (name: string, packages: unknown[]): string => {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages }));
  return cwd;
};
const globalWith = (name: string, packages: unknown[]): string => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify({ packages }));
  return d;
};
const off = (source: string) => ({ source, extensions: [], skills: [], prompts: [], themes: [] });

test("pass 2 checkout takes over the stale claim of a dropped pass-1 copy (absolute and relative override)", () => {
  const rel = path.relative(path.join(tmp, "p-abs", ".pi"), userRoot);
  for (const [name, source] of [["p-abs", userRoot], ["p-rel", path.relative(path.join(tmp, "p-rel", ".pi"), userRoot)]] as const) {
    assert.ok(rel.length > 0);
    const g: Record<symbol, unknown> = {};
    const pass1 = claimCore(userRoot, g);
    assert.ok(pass1.active);
    const cwd = projectWith(name, ["..", off(source)]);
    const pass2 = claimCore(checkout, g, process.platform, cwd, globalWith(`g-${name}`, [userRoot]));
    assert.ok(pass2.active, name);
    assert.equal((g[CORE_KEY] as { pkgRoot: string }).pkgRoot, checkout);
    if (pass1.active) pass1.release(); // stale release is a no-op
    assert.equal((g[CORE_KEY] as { pkgRoot: string }).pkgRoot, checkout);
  }
});

test("a remote pi-foreman override matches a holder that is a pi-foreman package", () => {
  const g: Record<symbol, unknown> = {};
  claimCore(userRoot, g);
  const cwd = projectWith("p-remote", ["..", off("npm:pi-foreman@1.0.0")]);
  assert.ok(claimCore(checkout, g, process.platform, cwd, globalWith("g-remote", ["npm:pi-foreman"])).active);
});

const takeover = (name: string, globalEntry: string, overrideEntry: unknown): boolean => {
  const g: Record<symbol, unknown> = {};
  claimCore(userRoot, g);
  return claimCore(checkout, g, process.platform, projectWith(`p-${name}`, ["..", overrideEntry]), globalWith(`g-${name}`, [globalEntry])).active;
};

test("relative global entry plus absolute project override: takeover", () => {
  const agentDir = path.join(tmp, "g-relabs");
  assert.equal(takeover("relabs", path.relative(agentDir, userRoot), off(userRoot)), true);
});

test("a symlinked override of the real global entry stays inert", () => {
  const link = path.join(tmp, "user-link");
  fs.symlinkSync(userRoot, link);
  assert.equal(takeover("symlink", userRoot, off(link)), false);
});

test("a case-changed override path stays inert on non-win32", { skip: process.platform === "win32" }, () => {
  assert.equal(takeover("case", userRoot, off(userRoot.replace("user-copy", "USER-COPY"))), false);
});

test("an autoload:false override does not disable the holder", () => {
  assert.equal(takeover("autoload", userRoot, { ...off(userRoot), autoload: false }), false);
});

test("an override without a matching global entry stays inert", () => {
  assert.equal(takeover("noglobal", checkout, off(userRoot)), false);
});

test("without the override the later copy stays inert with the notice", () => {
  const g: Record<symbol, unknown> = {};
  claimCore(userRoot, g);
  const r = claimCore(checkout, g, process.platform, projectWith("p-none", [".."]));
  assert.equal(r.active, false);
  if (!r.active) assert.ok(r.notice.includes(userRoot));
  assert.equal(claimCore(checkout, g, process.platform, path.join(tmp, "no-settings")).active, false);
});

test("a holder that saw session_start is never taken over", () => {
  const g: Record<symbol, unknown> = {};
  const a = claimCore(userRoot, g);
  assert.ok(a.active);
  if (a.active) markCoreStarted(a.claim, g);
  assert.equal(g[STARTED_KEY], g[CORE_KEY]);
  const r = claimCore(checkout, g, process.platform, projectWith("p-started", ["..", off(userRoot)]));
  assert.equal(r.active, false);
});

test("an override with non-empty extensions does not disable the holder", () => {
  const g: Record<symbol, unknown> = {};
  claimCore(userRoot, g);
  const cwd = projectWith("p-filter", ["..", { source: userRoot, extensions: ["x.ts"] }, { source: userRoot }]);
  assert.equal(claimCore(checkout, g, process.platform, cwd).active, false);
});

test("factory level: the index.ts default export takes over a stale foreign claim under a project override", async () => {
  const { default: coreAdapter } = await import("../index.ts");
  const g = globalThis as unknown as Record<symbol, unknown>;
  const saved = g[CORE_KEY];
  const savedStarted = g[STARTED_KEY];
  const cwd = projectWith("p-factory", ["..", off("npm:pi-foreman")]);
  const prevCwd = process.cwd();
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = globalWith("g-factory", ["npm:pi-foreman"]);
  g[CORE_KEY] = { version: "0", pkgRoot: userRoot, api: 1 };
  try {
    process.chdir(cwd);
    const tools: string[] = [];
    const fake = new Proxy({ registerTool: (d: { name: string }) => void tools.push(d.name), events: { on: () => undefined, emit: () => undefined } } as Record<string, unknown>, {
      get: (t, k: string) => t[k] ?? (() => undefined),
    });
    try {
      coreAdapter(fake as never);
    } catch {
      // the rest of the factory needs a full Pi; only the once-guard outcome matters here
    }
    assert.ok(tools.includes("tool_search"));
    assert.equal((g[CORE_KEY] as { pkgRoot: string }).pkgRoot !== userRoot, true);
  } finally {
    process.chdir(prevCwd);
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (saved === undefined) delete g[CORE_KEY];
    else g[CORE_KEY] = saved;
    if (savedStarted === undefined) delete g[STARTED_KEY];
    else g[STARTED_KEY] = savedStarted;
  }
});
