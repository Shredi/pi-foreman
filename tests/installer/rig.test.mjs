import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSandbox } from "./rig/sandbox.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const VERSIONS = { "pi-intercom": "0.17.0", herdr: "0.5.1", "herdr-app": "0.2.0", hc: "1.2.3", python: "3.13.1" };

// Runs a shim by path through Node, the way the wrappers do on every platform.
const shim = (sb, name, args) => spawnSync(process.execPath, [path.join(HERE, "rig", "shims", `${name}.mjs`), ...args], { encoding: "utf8", env: sb.env });

test("sandbox creates the agent dir, HOME and shim bin dir", () => {
  const sb = createSandbox();
  try {
    for (const d of [sb.agentDir, sb.home, sb.binDir]) assert.ok(fs.statSync(d).isDirectory());
    assert.ok(sb.env.PATH.startsWith(sb.binDir));
    assert.equal(sb.env.HOME, sb.home);
    assert.equal(sb.env.PI_CODING_AGENT_DIR, sb.agentDir);
    assert.equal(sb.env.PI_FOREMAN_PICKER, "off");
    assert.equal(sb.env.CI, "1");
    assert.deepEqual(sb.calls(), []);
    assert.deepEqual(sb.snapshot(), {});
  } finally {
    sb.cleanup();
  }
});

test("shims record their call and answer from SHIM_VERSIONS", () => {
  const sb = createSandbox({ versions: VERSIONS });
  try {
    assert.equal(shim(sb, "npm", ["view", "pi-intercom", "version"]).stdout.trim(), "0.17.0");
    assert.equal(shim(sb, "npm", ["view", "unknown", "version"]).status, 1);
    assert.equal(shim(sb, "npm", ["install"]).status, 0);
    assert.equal(shim(sb, "npm", ["ci"]).status, 0);
    assert.equal(shim(sb, "herdr", ["--version"]).stdout.trim(), "0.5.1");
    assert.equal(shim(sb, "herdr-app", ["--version"]).stdout.trim(), "0.2.0");
    assert.equal(shim(sb, "herdr", ["status"]).status, 0);
    assert.equal(shim(sb, "hc", ["--version"]).stdout.trim(), "1.2.3");
    assert.equal(shim(sb, "python", ["--version"]).stdout.trim(), "3.13.1");
    assert.equal(shim(sb, "python", ["-c", "pass"]).status, 0);
    const calls = sb.calls();
    assert.deepEqual(calls.map((c) => c.tool), ["npm", "npm", "npm", "npm", "herdr", "herdr-app", "herdr", "hc", "python", "python"]);
    assert.deepEqual(calls[0].argv, ["view", "pi-intercom", "version"]);
    assert.equal(typeof calls[0].cwd, "string");
    assert.deepEqual(sb.snapshot(), {});
  } finally {
    sb.cleanup();
  }
});

test("setup --dry-run in the sandbox calls only pi (no npm, herdr, herdr-app, hc, python)", () => {
  const sb = createSandbox({ versions: VERSIONS });
  try {
    fs.writeFileSync(path.join(sb.agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
    const before = sb.snapshot();
    const r = spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), "--dry-run", "--agent-dir", sb.agentDir], { encoding: "utf8", env: sb.env, cwd: sb.home });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const tools = new Set(sb.calls().map((c) => c.tool));
    for (const t of ["npm", "herdr", "herdr-app", "hc", "python"]) assert.ok(!tools.has(t), `unexpected call to ${t}`);
    assert.ok(tools.size > 0 && [...tools].every((t) => t === "pi"), `tools called: ${[...tools]}`);
    assert.deepEqual(sb.snapshot(), before);
  } finally {
    sb.cleanup();
  }
});

test("a shim runs by bare name through the sh or .cmd wrapper", () => {
  const sb = createSandbox({ versions: VERSIONS });
  try {
    const r = spawnSync(process.platform === "win32" ? "hc.cmd" : "hc", ["--version"], { env: sb.env, shell: true, encoding: "utf8" });
    assert.equal(r.stdout.trim(), VERSIONS.hc);
    const calls = sb.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, "hc");
    assert.deepEqual(calls[0].argv, ["--version"]);
  } finally {
    sb.cleanup();
  }
});

test("setup --preview prints no review WARN line", () => {
  const sb = createSandbox();
  try {
    const r = spawnSync("sh", [path.join(ROOT, "bin", "foreman"), "setup", "--preview", "home"], { env: sb.env, encoding: "utf8" });
    assert.doesNotMatch(r.stdout + r.stderr, /WARN/);
  } finally {
    sb.cleanup();
  }
});

test("cleanup removes the sandbox", () => {
  const sb = createSandbox();
  const base = path.dirname(sb.agentDir);
  sb.cleanup();
  assert.equal(fs.existsSync(base), false);
});
