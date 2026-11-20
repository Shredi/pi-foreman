import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

// Text checks on the justfile: `just` itself is not needed to run these.
const root = path.join(import.meta.dirname, "..", "..", "..");
const text = fs.readFileSync(path.join(root, "justfile"), "utf8");
const lines = text.split(/\r?\n/);
const scripts = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {});

/** Recipe name -> dependencies, from the header lines (`name params: deps`). `set x := ...` is not a header: it has `:=`. */
function recipes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines) {
    const m = /^([A-Za-z][\w-]*)([^:=\n]*):(?!=)(.*)$/.exec(line);
    if (m) out.set(m[1], m[3].trim().split(/\s+/).filter((dep) => dep !== ""));
  }
  return out;
}

test("justfile: every `npm run X` names a package.json script", () => {
  const used = [...text.matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0, "the justfile runs no npm script");
  for (const name of used) assert.ok(scripts.includes(name), `npm run ${name}: no such script in package.json`);
});

test("justfile: `npm test` names the package.json test script", () => {
  if (/\bnpm test\b/.test(text)) assert.ok(scripts.includes("test"), "npm test: no test script in package.json");
});

test("justfile: the Windows shell is PowerShell", () => {
  assert.ok(lines.includes('set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]'));
});

test("justfile: the recipes exist", () => {
  const names = recipes();
  for (const name of ["default", "test", "test-node", "test-installer", "typecheck", "lint", "ci-extra", "ci"]) {
    assert.ok(names.has(name), `recipe ${name} is missing`);
  }
});

test("justfile: ci depends on lint, typecheck, test, test-node and ci-extra", () => {
  const deps = recipes().get("ci") ?? [];
  assert.deepEqual([...deps].sort(), ["ci-extra", "lint", "test", "test-node", "typecheck"]);
});
