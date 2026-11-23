// A line too deep for the stack sizes in use (measured up to `--stack-size=7000`): parseShell ends it as the one unreadable segment marked `tooDeep` (it does not throw), and the gate
// decides it judge-first (main and child), never `gate-error` and never an allow.
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

test("parseShell: a long arithmetic expression is read, not opaque (explicit-stack walks)", () => {
  const plain = parseShell(UNPARSABLE, { platform: "linux" });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].opaque, "parse_error");
  for (const [name, line] of Object.entries(DEEP)) {
    const segs = parseShell(line, { platform: "linux" });
    // the walks keep their own explicit stacks: a long expression is read as a short one is (it no longer overflows), never a thrown RangeError
    assert.equal(segs.length, 1, name);
    assert.notEqual(segs[0].opaque, "parse_error", name);
    assert.ok(!segs[0].tooDeep, name);
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
  test(`gateEvaluate (${label}): a long arithmetic expression is decided as its short twin`, () => {
    const want = gate(UNPARSABLE, child, withRoots);
    // a plain unreadable line (a syntax error) is not judge-first and runs; a too-deep one is judge-first (below)
    assert.equal(want.result, undefined);
    assert.equal(want.danger, null, "an unreadable line is not judge-first");
    for (const [name, line] of Object.entries(DEEP)) {
      const got = gate(line, child, withRoots);
      assert.notEqual(got.result?.rule, "gate-error", name);
      assert.ok(!got.result?.allow, `${name}: not an allow`);
      // read, not overflowed: decided as the short twin is (an allow, as on origin/main, where nothing hides in the expression)
      const twin = gate("echo $(( 1+1 ))", child, withRoots);
      assert.deepEqual({ rule: got.result?.rule, danger: (got.danger as { name?: string } | null)?.name }, { rule: twin.result?.rule, danger: (twin.danger as { name?: string } | null)?.name }, name);
    }
  });
}
