// r79 item 18: one linear glob matcher shared by the floors and the overlay; a command word is never compiled into a RegExp.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { globMatch, globSegMatch, wildMatch } from "../glob.ts";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-glob-")));
const cwd = path.join(root, "proj");
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [cwd, home, agentDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(cwd, "a".repeat(255)), "x\n");
fs.writeFileSync(path.join(cwd, "a".repeat(254) + "c"), "x\n");
const ctx: MatchCtx = { cwd, home, platform: process.platform };
const rules = buildOverlayRules(baseline, {}, {}, agentDir);
const bash = (command: string) => checkToolCall(rules, "bash", { command }, ctx);

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo"], scratch: [], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd }), env)?.rule ?? null;

function spyRegExp<T>(fn: () => T): { out: T; sources: string[] } {
  const Real = globalThis.RegExp;
  const sources: string[] = [];
  const Spy = new Proxy(Real, {
    construct(t, args, nt) {
      sources.push(String(args[0] instanceof Real ? args[0].source : args[0]));
      return Reflect.construct(t, args, nt);
    },
  });
  globalThis.RegExp = Spy;
  try {
    return { out: fn(), sources };
  } finally {
    globalThis.RegExp = Real;
  }
}

const evil = Array.from({ length: 40 }, () => "a*").join("") + "b";
const deriv = (s: string): boolean => s.includes("a.*a") || s.includes("a*a*a") || s.includes("A-Za-z_") || s.includes("a\\*");

test("glob semantics: stars, question marks, classes, literal [", () => {
  assert.equal(globSegMatch("*.ts", "a.ts"), true);
  assert.equal(globSegMatch("*.ts", "a.js"), false);
  assert.equal(globSegMatch("?.md", "a.md"), true);
  assert.equal(globSegMatch("?.md", "ab.md"), false);
  assert.equal(globSegMatch("[!.]*", "x"), true);
  assert.equal(globSegMatch("[!.]*", ".x"), false);
  assert.equal(globSegMatch("[^.]*", ".x"), false);
  assert.equal(globSegMatch("[a-c]x", "bx"), true);
  assert.equal(globSegMatch("[a-c]x", "dx"), false);
  assert.equal(globSegMatch("[", "["), true);
  assert.equal(globSegMatch("[A-Za-z_", "[A-Za-z_"), true);
  assert.equal(globSegMatch("a**b", "axxb"), true);
  assert.equal(globSegMatch("*", ".hidden"), true); // dot handling belongs to the caller
  assert.equal(globMatch("/a/*/c", "/a/b/c"), true);
  assert.equal(globMatch("/a/*", "/a/b/c"), false);
  assert.equal(globMatch("/A/*", "/a/b", true), true);
});

test("wildMatch: star crosses slashes, question mark is one char, 40 stars are linear", () => {
  assert.equal(wildMatch("/a/*", "/a/b/c"), true);
  assert.equal(wildMatch("/a/?", "/a/bc"), false);
  assert.equal(wildMatch("/A/*", "/a/b", true), true);
  const t0 = Date.now();
  assert.equal(wildMatch(evil, "a".repeat(255) + "c"), false);
  assert.ok(Date.now() - t0 < 50);
});

test("a 40-star word against a 255-char name finishes in constant-ish time", () => {
  const name = "a".repeat(255) + "c";
  const t0 = Date.now();
  assert.equal(globSegMatch(evil, name), false);
  assert.equal(globSegMatch("*a*a*a*a*a*a*a*a*a*a*b", name), false);
  assert.ok(Date.now() - t0 < 50);
});

test("overlay expandGlob (write protection, bash words) never compiles the word and stays fast", () => {
  for (const word of ["*a*a*a*a*a*a*a*a*a*a*b", evil, "[A-Za-z_"]) {
    const t0 = Date.now();
    const { sources } = spyRegExp(() => bash(`touch ${word}`));
    assert.ok(Date.now() - t0 < 500, word);
    assert.deepEqual(sources.filter(deriv), [], word);
  }
});

test("floors never compile the word and stay fast", () => {
  const t0 = Date.now();
  const { out, sources } = spyRegExp(() => floor(`for f in *.ts; do grep -o -E '[A-Za-z_][A-Za-z0-9_]*' "$f" | sed -E 's/x/y/'; done; touch ${evil}`));
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(sources.some(deriv), false);
});
