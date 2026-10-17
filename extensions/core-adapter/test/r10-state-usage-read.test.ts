// R10 P1 item 1 (a): the foreman's own `{agentDir}/pi-foreman/state/usage` is readable with read-only shell verbs (ls/cat/head/tail/wc/stat) and
// ONLY the narrow python form of ruling D1 (`python3 -c` with a single print(open('<literal>').read()) or json.load(open('<literal>'))); every other
// python form asks, writes into state/ stay protected, a child stays denied. Each case runs through the overlay (checkToolCall), the review.ts allow
// chain (the permission link) and the rendered external_directory rules (scripts/permissions_gen.py external_rules over the baseline).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownUsageReadable } from "../roundsurface.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules } from "../timeoutallow.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-usage-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const usage = path.join(state, "usage");
for (const d of [ws, usage]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(usage, "u.jsonl"), "{}\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownReads = ownUsageReadable(ag, process.platform);
const ctx = (role: "main" | "child"): MatchCtx => ({ cwd: ws, home, platform: process.platform, role, ...(role === "main" ? { ownReads } : {}) });
const sh = (role: "main" | "child", command: string): string => checkToolCall(rules, "bash", { command }, ctx(role))?.kind ?? "pass";

const U = usage;
const F = path.join(usage, "u.jsonl");
const PY_READ = `python3 -c "print(open('${F}').read())"`;
const PY_JSON = `python3 -c "import json; print(json.load(open('${F}')))"`;

// the open forms (foreman)
const OPEN = [`ls ${U}`, `ls -la ${U}`, `cat ${F}`, `head -n 5 ${F}`, `tail -n 5 ${F}`, `wc -l ${F}`, `stat ${F}`, `stat ${U}`, PY_READ, PY_JSON];

for (const cmd of OPEN) {
  test(`expected-open (R10a): ${cmd.replace(w, "<tmp>")} (overlay, foreman)`, { skip: !posix }, () => {
    assert.equal(sh("main", cmd), "pass");
  });
}

// asks (foreman) and denies (child)
const ASK = [
  `echo x > ${path.join(U, "f")}`,
  `cp ${F} ${path.join(state, "x")}`,
  `touch ${path.join(U, "f")}`,
  `rm ${F}`,
  `stat ${path.join(state, "rounds.json")}`,
  `python3 -c "open('${F}','w').write('x')"`,
  `python3 -c "open('${F}','a')"`,
  `python3 -c "import os; print(os.listdir('${U}'))"`,
  `python3 -c "import subprocess; subprocess.run(['ls','${U}'])"`,
  `python3 -c "exec(open('${F}').read())"`,
  `python3 -c "print(open('${F}').read())" > ${path.join(U, "g")}`,
  `python3 -c "print(open('${path.join(state, "rounds.json")}').read())"`,
  `python3 ${F}`,
  `stat ${F} && touch ${path.join(U, "g")}`,
  `cat ${F} | tee ${path.join(U, "g")}`,
];
for (const cmd of ASK) {
  test(`(decision: ask) ${cmd.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<tmp>")} (overlay, foreman)`, { skip: !posix }, () => {
    assert.notEqual(sh("main", cmd), "pass");
  });
}

test("(decision: deny) a child does not get the foreman's own state/usage, read or write", { skip: !posix }, () => {
  // (the child's inline python read exemption, pythonReadOnlyCode + soloPython, predates R10 and is not changed here)
  for (const cmd of [`cat ${F}`, `ls ${U}`, `stat ${F}`, `echo x > ${path.join(U, "f")}`]) assert.equal(sh("child", cmd), "deny", cmd);
});

test("a symlink in state/usage that leads to a protected path stays protected for stat", { skip: !posix }, () => {
  fs.mkdirSync(path.join(ag, "intercom"), { recursive: true });
  fs.symlinkSync(path.join(ag, "intercom"), path.join(usage, "lnk"));
  assert.notEqual(sh("main", `stat ${path.join(usage, "lnk", "x")}`), "pass");
});

// the review.ts allow chain for the bash surface: what the permission system forwards when its own rules ask
const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const prules = bashRules(baseline, {});
const session = (): ReviewSession => ({ isChild: false, cwd: ws, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => prules, ownReads: () => ownReads });
const link = async (command: string) => { const r = new ForemanReview(); r.upsert("s", session()); return (await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value: command, toolName: "bash" })).kind; };

test("review chain: the D1 python forms are allowed without the model (permission link, foreman)", { skip: !posix }, async () => {
  assert.equal(await link(PY_READ), "allow");
  assert.equal(await link(PY_JSON), "allow");
});

test("review chain: every other python form is not allowed by the link (permission link, foreman)", { skip: !posix }, async () => {
  for (const cmd of ASK.filter((c) => c.startsWith("python3"))) assert.notEqual(await link(cmd), "allow", cmd);
});

// the rendered external_directory_read rules (permissions_gen.py external_rules): last match wins, `*` matches any characters including `/`
test("rendered external_directory_read: the usage dir and its files are read-allowed, not write-allowed (permissions_gen external_rules)", { skip: !posix }, () => {
  const ext = (JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { externalDirectory: { allow: string[]; read: string[]; ask: string[] } }).externalDirectory;
  const fill = (ps: string[]): string[] => ps.map((p) => p.replaceAll("{agentDir}", ag)).filter((p) => !p.includes("{"));
  const re = (p: string): RegExp => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const hit = (ps: string[], v: string): boolean => fill(ps).some((p) => re(p).test(v));
  for (const v of [U, F]) {
    assert.ok(hit(ext.read, v), v);
    assert.ok(!hit(ext.allow, v), `write-capable ${v}`);
  }
});
