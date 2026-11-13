// A line too deep for the stack sizes in use (measured up to `--stack-size=7000`): parseShell ends it as the one unreadable segment (it does not throw), and the gate decides it as it
// decides an unreadable line (main and child), never `gate-error` and never an allow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateEvaluate, baseFloorEnv } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

// Overflows the walk even with `--stack-size=7000` on Node 22 and 26 (measured), and parses in tens of milliseconds. unbash cuts the shapes that nest
// deeply in `parse` itself short with a syntax error, so no line reaches a RangeError inside `parse`; the walk is where the overflow happens.
const N = 50000;
const rep = (s: string, n: number, sep: string): string => Array.from({ length: n }, () => s).join(sep);
const DEEP: Record<string, string> = {
  "arith expansion sum": `echo $(( ${rep("1", N, "+")} ))`,
  "arith expansion product": `echo $(( ${rep("1", N, "*")} ))`,
  "arith expansion comma": `echo $(( ${rep("1", N, ",")} ))`,
};
const UNPARSABLE = "echo )";

test("parseShell: a line too deep for the stack is one opaque parse_error segment", () => {
  const plain = parseShell(UNPARSABLE, { platform: "linux" });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].opaque, "parse_error");
  for (const [name, line] of Object.entries(DEEP)) {
    const segs = parseShell(line, { platform: "linux" });
    assert.equal(segs.length, 1, name);
    assert.equal(segs[0].opaque, "parse_error", name);
    assert.deepEqual(segs, plain, name);
  }
});

test("parseShell: an error that is not a stack overflow still propagates", () => {
  // the walk reads `rn.env.FOREMAN_SCRATCH` in `prepare`, so the TypeError arises inside the walk, after the parse succeeded
  const env = new Proxy({} as Record<string, string>, {
    get(): never {
      throw new TypeError("boom");
    },
  });
  assert.throws(() => parseShell("echo $X", { platform: "linux", env }), TypeError);
});

let root = "";
before(() => {
  root = fs.realpathSync(mkTestTmp("pf-deep-"));
  fs.mkdirSync(path.join(root, "cwd"));
  fs.mkdirSync(path.join(root, "scratch", "pi-foreman-scratch", "mine"), { recursive: true });
});
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The gate's outcome without the segments: `result` (undefined: nothing decided, the mode step follows) and `danger`. */
function gate(command: string, child: boolean, withRoots = true): { result: { block?: boolean; allow?: boolean; rule?: string } | undefined; danger: unknown } {
  const cwd = path.join(root, "cwd");
  const scratch = path.join(root, "scratch", "pi-foreman-scratch", "mine");
  const roots: GateRoots = {
    worktree: cwd,
    scratch: [scratch],
    tmp: [],
    scratchBase: path.dirname(scratch),
    owned: [],
    install: [],
    roundFlow: [],
    handoffs: [],
    child,
    role: child ? "builder" : "main",
    tmpAccess: false,
  };
  const out = gateEvaluate("bash", { command }, cwd, {
    env: (c) => baseFloorEnv(c, { child, home: path.join(root, "home"), platform: "linux", writeRoots: [c, root], scratch: [scratch] }),
    ...(withRoots ? { roots: () => roots } : {}),
  });
  return { result: out.result as { block?: boolean; allow?: boolean; rule?: string } | undefined, danger: out.danger };
}

for (const [label, child, withRoots] of [["main, no session roots", false, false], ["main, with roots", false, true], ["child", true, true]] as const) {
  test(`gateEvaluate (${label}): a too-deep line is decided like an unreadable line`, () => {
    const want = gate(UNPARSABLE, child, withRoots);
    // the unreadable line: nothing decided here (the mode step follows); with session roots it carries `danger` (measured: `danger-opaque`)
    assert.equal(want.result, undefined);
    if (withRoots) assert.ok(want.danger, "unreadable line carries danger");
    for (const [name, line] of Object.entries(DEEP)) {
      const got = gate(line, child, withRoots);
      assert.notEqual(got.result?.rule, "gate-error", name);
      assert.ok(!got.result?.allow, `${name}: not an allow`);
      assert.deepEqual(got, want, name);
    }
  });
}
