// PR A (perms-fix) A8: the narrow read relaxation (a double-quoted unknown word in a grep/rg pattern or option-value position) and a local `npx <bin>`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-a8-"));
const wt = path.join(base, "wt");
const sub = path.join(wt, "pkg", "deep");
const bare = path.join(base, "bare");
for (const d of [path.join(wt, "src"), path.join(wt, "node_modules", ".bin"), sub, bare, path.join(base, "tmp")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "src", "a.ts"), "x");
fs.writeFileSync(path.join(wt, "package.json"), "{}");
fs.writeFileSync(path.join(wt, "node_modules", ".bin", "mytool"), "#!/bin/sh\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (command: string, cwd = wt, child = false) => gateEvaluate("bash", { command }, cwd, { env: (c) => baseFloorEnv(c, { ...(child ? { child: true } : {}) }), roots: () => roots(child) });
const rule = (command: string, child = false): string | null => {
  const o = run(command, wt, child);
  return o.danger ? o.danger.name : o.result && "rule" in o.result ? String(o.result.rule) : "none";
};

test("A8: a double-quoted unknown word in a grep/rg pattern or option value is a read", () => {
  for (const l of ['grep -n "$PAT" src/a.ts', 'rg -e "$PAT" --type ts src/', 'rg --type "$T" foo src/', 'grep -A "$N" foo src/a.ts', 'grep -e "$P" src/a.ts']) {
    assert.equal(rule(l), "default-read", l);
    assert.equal(rule(l, true), "default-read", `child ${l}`);
  }
});

test("A8: a quoted $(...) pattern is no danger-opaque; its inner segment is judged on its own", () => {
  const l = 'grep -n "$(cat list.txt)" src/a.ts';
  assert.equal(run(l).danger, null);
  // an inner segment that is not a read still counts
  const bad = run('grep -n "$(sudo id)" src/a.ts');
  assert.equal(bad.result && "rule" in bad.result ? bad.result.rule : null, "floor-privilege");
});

test("A8: every other unknown word keeps the segment opaque", () => {
  for (const l of [
    "grep -n $PAT src/a.ts", // unquoted: word splitting and globbing
    'grep -n foo "$F"', // path position
    'grep -n foo $(cat list.txt)',
    'cat $(cat list.txt)',
    'cat "$F"',
    'grep -f "$F" src/a.ts', // file option
    'grep -n "$PAT" src/a.ts > "$OUT"', // redirect target
    'grep -n "$PAT" "$DIR"/a.ts',
    // the script text of sed and awk is unknown
    'sed -n "$EXPR" src/a.ts',
    'awk "$PROG" src/a.ts',
    '"$P" -n foo src/a.ts', // the program
    'cd "$D" && grep foo src/a.ts', // a cd operand
    'rg --pre "$X" foo src/a.ts',
  ]) {
    assert.equal(rule(l), "danger-opaque", l);
  }
});

test("A8: a relaxed pattern word does not hide a floored path", () => {
  assert.match(rule('grep -n "$PAT" ~/.ssh/id_rsa') ?? "", /floor|danger|none|deny/);
  const out = run('grep -n "$PAT" ~/.ssh/id_rsa');
  assert.notEqual(out.result && "rule" in out.result ? out.result.rule : null, "default-read");
});

test("A8: npx <bin> with node_modules/.bin/<bin> under the nearest package.json is not danger-install", () => {
  const at = (l: string, cwd: string) => run(l, cwd).danger?.name ?? null;
  assert.notEqual(at("npx mytool --flag", wt), "danger-install");
  assert.notEqual(at("npx mytool", sub), "danger-install", "from a subdirectory of the package");
  assert.notEqual(at("npx --no mytool", wt), "danger-install");
  // never a default allow: the bin's class is unknown
  assert.notEqual(rule("npx mytool"), "default-read");
  assert.notEqual(rule("npx mytool"), "default-build-test");
});

test("A8: npx stays danger-install for a missing bin, a package option, a version, --yes or a path", () => {
  const at = (l: string, cwd = wt) => run(l, cwd).danger?.name ?? null;
  for (const l of ["npx other", "npx -p mytool mytool", "npx --package=mytool mytool", "npx mytool@1.2.3", "npx --yes mytool", "npx -y mytool", "npx ./mytool", "npx", "npx -c mytool"]) {
    assert.equal(at(l), "danger-install", l);
  }
  assert.equal(at("npx mytool", bare), "danger-install", "no package.json above the cwd");
  assert.equal(at("npx mytool", path.join(base, "tmp")), "danger-install");
});
