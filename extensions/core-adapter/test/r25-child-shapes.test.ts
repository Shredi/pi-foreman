import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp } from "./_tmpbase.ts";
import { bashPath } from "./_bashpath.ts";
import { effectCtx } from "../effects.ts";
import type { EffectCtx } from "../effects.ts";
import { bashRules, deterministicAllowInfo } from "../timeoutallow.ts";
import { readBaseline } from "../permoverlay.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});

const base = mkTestTmp("pf-r25-");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const repo = path.join(base, "repo");
const outside = path.join(base, "outside");
const scratch = path.join(base, "scratch");
for (const d of [path.join(repo, ".git"), path.join(repo, "tests"), outside, scratch]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(repo, "tests", "a.test.js"), "\n");
fs.writeFileSync(path.join(repo, "tests", "test_a.py"), "\n");
fs.writeFileSync(path.join(repo, "tsconfig.json"), "{}\n");
const ctx = (): EffectCtx => effectCtx(repo, [scratch]);
const allow = (cmd: string) => deterministicAllowInfo(rules, cmd, { scratchDirs: [scratch], effects: ctx() });

// the shapes children use most (the baseline matches them too, so they never forward)
const SHAPES = ["node --test tests/a.test.js", "python3 -I -m unittest discover -s tests -p 'test_*.py'", "python3 -B -m unittest discover -s tests -p test_a.py", "python3 -u -m unittest discover -v -s tests", "npx tsc --noEmit -p tsconfig.json", "npx tsc --noEmit"];

test("shapes: each runs without a cd prefix and with a contained cd prefix, as an effect-build-test chain", () => {
  for (const shape of SHAPES) {
    assert.deepEqual(allow(shape), { label: "effect-build-test", segments: 1 }, shape);
    assert.deepEqual(allow(`cd ${bashPath(repo)} && ${shape}`), { label: "effect-build-test", segments: 2 }, `cd repo && ${shape}`);
    assert.deepEqual(allow(`cd . && ${shape}`), { label: "effect-build-test", segments: 2 }, `cd . && ${shape}`);
  }
});

test("a contained cd is neutral: it does not allow a chain by itself", () => {
  assert.equal(allow(`cd ${bashPath(repo)}`), null);
  assert.equal(allow("cd tests"), null);
});

test("negative: a cd outside the worktree still asks, with or without the shape", () => {
  for (const shape of SHAPES) assert.equal(allow(`cd ${bashPath(outside)} && ${shape}`), null, shape);
});

test("negative: an output redirect to a repo file still asks", () => {
  assert.equal(allow("node --test tests/a.test.js > out.txt"), null);
  assert.equal(allow(`cd ${bashPath(repo)} && npx tsc --noEmit > out.txt`), null);
});

test("negative: options that load code or change the run still ask", () => {
  for (const cmd of ["node --test --import ./x.mjs tests/a.test.js", "node -e 'x'", "node --test", "python3 -I -c 'x'", "python3 -I -m unittest discover -s ../outside -p x", "python3 -I -m unittest -c", "npx tsc --noEmit --outDir ../out", "npx --package=x tsc --noEmit"]) assert.equal(allow(cmd), null, cmd);
});

