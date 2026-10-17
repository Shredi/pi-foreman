// R10 P1 item 3 (c): read-only toolchain probes. The permission system read-allows the baseline `externalDirectory.probe` dirs (toolchain bin dirs,
// the npx cache; scripts/permissions_gen.py probe_read_patterns, read keys only); the overlay narrows that to a plain ls/stat/which shell line and
// the ls tool. Anything else naming a probe dir asks (a child: deny); exec of a found binary as the command word stays with the permission
// system's bash rules (no allow row matches it, so it asks); `cat ~/.npmrc` stays a path deny.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules, hits } from "../timeoutallow.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-probe-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, ag, path.join(home, ".npm", "_npx", "abc"), path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, ".npm", "_npx", "abc", "package.json"), "{}\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctx = (role: "main" | "child"): MatchCtx => ({ cwd: ws, home, platform: process.platform, role });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, ctx(role))?.kind ?? "pass";
const tool = (role: "main" | "child", name: string, input: Record<string, unknown>): string => checkToolCall(rules, name, input, ctx(role))?.kind ?? "pass";
const prules = bashRules(baseline, {});

const OPEN = [
  "which node",
  "which -a npx",
  "ls /usr/local/bin",
  "ls -la /opt/homebrew/bin",
  "stat /usr/bin",
  "ls ~/.npm/_npx",
  "ls -la ~/.npm/_npx/abc",
  "stat ~/.local/bin",
  "ls $HOME/.npm-global/bin",
  "ls /usr/local/bin /opt/homebrew/bin && stat ~/.npm/_npx",
  "which node && ls -l /usr/local/bin",
];
for (const cmd of OPEN) {
  for (const role of ["main", "child"] as const) {
    test(`expected-open (R10c): ${cmd} (overlay, ${role === "main" ? "foreman" : "child"})`, { skip: !posix }, () => {
      assert.equal(sh(role, cmd), "pass");
    });
  }
}

test("expected-open (R10c): the ls tool on a probe dir (overlay, foreman and child)", { skip: !posix }, () => {
  for (const role of ["main", "child"] as const) {
    assert.equal(tool(role, "ls", { path: "/usr/local/bin" }), "pass", role);
    assert.equal(tool(role, "ls", { path: path.join(home, ".npm", "_npx") }), "pass", role);
  }
});

test("expected-open (R10c): the permission system's bash rules allow which/ls/stat (no PS bash ask)", () => {
  for (const cmd of ["which node", "ls /usr/local/bin", "stat ~/.npm/_npx"]) assert.ok(hits(prules.allow, cmd, home), cmd);
});

const ASK = [
  "cat /usr/local/bin/x",
  "head ~/.npm/_npx/abc/package.json",
  "ls /usr/local/bin | sh",
  "ls /usr/local/bin | grep node",
  "cp x /usr/local/bin/",
  "cp x ~/.local/bin/x",
  "ls /usr/local/bin > f",
  "ls /usr/local/bin 2>/dev/null",
  "ls $(echo /usr/local/bin)",
  "ls `echo /usr/local/bin`",
  "env ls /usr/local/bin",
  "X=1 ls /usr/local/bin",
  "ls /usr/local/bin; /usr/local/bin/foo",
  "ls ~/.npm/_npx && node ~/.npm/_npx/abc/x.js",
  "sh -c 'ls /usr/local/bin'",
  "find /usr/local/bin -name node",
  "file /usr/bin/x",
  "ls $HOME/.npm/_npx/$X",
];
for (const cmd of ASK) {
  test(`(decision: ask) ${cmd} (overlay, foreman; a child gets deny)`, { skip: !posix }, () => {
    assert.equal(sh("main", cmd), "ask");
    assert.equal(sh("child", cmd), "ask");
  });
}

test("(decision: ask) read, grep, find, write and edit tools on a probe dir (overlay, foreman and child)", { skip: !posix }, () => {
  const pj = path.join(home, ".npm", "_npx", "abc", "package.json");
  for (const role of ["main", "child"] as const) {
    assert.equal(tool(role, "read", { path: pj }), "ask", `${role} read`);
    assert.equal(tool(role, "read", { path: "/usr/local/bin/x" }), "ask", `${role} read bin`);
    assert.equal(tool(role, "grep", { pattern: "x", path: path.join(home, ".npm", "_npx") }), "ask", `${role} grep`);
    assert.equal(tool(role, "find", { pattern: "*.js", path: path.join(home, ".npm", "_npx") }), "ask", `${role} find`);
    assert.equal(tool(role, "write", { path: path.join(home, ".local", "bin", "x"), content: "x" }), "ask", `${role} write`);
    assert.equal(tool(role, "edit", { path: pj, oldText: "{", newText: "[" }), "ask", `${role} edit`);
  }
});

test("(decision: ask) exec of a found binary: the overlay leaves the command word to the permission system, whose bash rules have no allow row for it", { skip: !posix }, async () => {
  for (const cmd of ["/usr/local/bin/foo --version", `${path.join(home, ".npm", "_npx", "abc", "bin")} x`]) {
    assert.ok(!hits(prules.allow, cmd, home), `PS allow ${cmd}`);
    const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
    const s: ReviewSession = { isChild: false, cwd: ws, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => prules };
    const r = new ForemanReview();
    r.upsert("s", s);
    assert.notEqual((await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value: cmd, toolName: "bash" })).kind, "allow", `link ${cmd}`);
  }
});

test("(decision: deny) cat ~/.npmrc stays a path deny, also next to a probe line", { skip: !posix }, () => {
  for (const role of ["main", "child"] as const) {
    assert.equal(sh(role, "cat ~/.npmrc"), "deny", role);
    assert.equal(sh(role, "ls ~/.npm/_npx && cat ~/.npmrc"), "deny", role);
  }
});

test("(decision: deny) a child's non-probe verb on a probe dir is blocked (overlay ask -> child block)", { skip: !posix }, async () => {
  const { resolveDecision } = await import("../permoverlay.ts");
  const d = checkToolCall(rules, "bash", { command: "cat /usr/local/bin/x" }, ctx("child"));
  const r = await resolveDecision(d, { isChild: true, mode: "tui", hasUI: true });
  assert.equal(r?.block, true);
});

test("the probe list in the baseline is the fixed generic list (no owner path)", () => {
  assert.deepEqual(baseline.externalDirectory?.probe, ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "~/.local/bin", "~/.npm/_npx", "~/.npm-global/bin", "%APPDATA%/npm"]);
});

test("a dir merely sharing a prefix with a probe dir is not narrowed", { skip: !posix }, () => {
  assert.equal(sh("main", "cat /usr/local/binx/y"), "pass");
});
