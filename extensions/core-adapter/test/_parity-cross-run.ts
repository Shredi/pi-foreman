// PR B2 parity, generated part (test/_parity-cross.ts), re-based on PR C (there are no modes); run per role by destructive-parity-cross-foreman.test.ts and
// destructive-parity-cross-child.test.ts (two files: two processes). Every line gets the verdict recorded in the fixture (`now`: a run, j judge first, f floor), and the verdict
// stays consistent with the baseline (the stricter of the removed Python delete guard and the floors at f0d8b980): a line that was refused is never run.
// Sampling (each file under about 20 s): every line with no prefix or one prefix, and of the lines with two stacked prefixes one in five, shifted by the context and body so that
// every prefix pair meets every context and body somewhere. PARITY_CROSS_FULL=1 runs all 7385 lines (about 50 s per file).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { crossLines } from "./_parity-cross.ts";

const fixture: { count: number; baseline: string; now: string } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "destructive-parity-cross.json"), "utf8"));

/** The lines of one context x body block: 1 bare, 14 with one prefix, 196 with two. */
const BLOCK = 211;
const sampled = (i: number): boolean => process.env.PARITY_CROSS_FULL === "1" || i % BLOCK < 15 || ((i % BLOCK) - 15 + Math.floor(i / BLOCK)) % 5 === 0;

/**
 * The one allowed difference from the baseline (class 9), stricter for the foreman only: a multiplexer with another wrapper behind it (`busybox sudo rm -rf ~`, `busybox env mkfs`:
 * neither old check read past the applet and the wrapper) is read like the bare applet, so a system delete or a disk format is a floor and a delete outside the roots goes to the judge.
 */
const class9 = (line: string, was: string): boolean => was === "a" && /\b(?:busybox|toybox)\b/.test(line);

export function runCross(who: "foreman" | "child"): void {
  const child = who === "child";
  const lines = crossLines();
  const base = fs.realpathSync(mkTestTmp("pf-parity-cross-"));
  const wt = path.join(base, "wt");
  const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
  for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
  after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true };
  const verdict = (line: string): string => {
    const o = gateEvaluate("bash", { command: line }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots });
    const x = o.result;
    if (x && "block" in x) return "f";
    if (x && "ask" in x) return "k";
    return o.danger ? "j" : "a";
  };

  test("the generated cross product has the recorded size", () => {
    assert.equal(lines.length, fixture.count);
    assert.equal(fixture.baseline.length, 2 * lines.length);
    assert.equal(fixture.now.length, 2 * lines.length);
  });

  test(`${who}: the sampled cross product gets the recorded verdict`, () => {
    const bad: string[] = [];
    let n = 0;
    lines.forEach(({ line }, i) => {
      if (!sampled(i)) return;
      n++;
      const was = fixture.now[2 * i + (child ? 1 : 0)];
      const now = verdict(line);
      if (now !== was) bad.push(`${JSON.stringify(line)}: recorded ${was}, now ${now}`);
    });
    assert.deepEqual(bad, [], `\n${bad.slice(0, 40).join("\n")}\n(${bad.length} rows)`);
    assert.ok(n >= 1500, String(n));
  });

  test(`${who}: the recorded verdicts of every line agree with the baseline (a refused line never runs; a floor where it ran is class 9)`, () => {
    const bad: string[] = [];
    let used = 0;
    lines.forEach(({ line }, i) => {
      const was = fixture.baseline[2 * i + (child ? 1 : 0)];
      const now = fixture.now[2 * i + (child ? 1 : 0)];
      if (was !== "a" && now === "a") bad.push(`${JSON.stringify(line)}: was ${was}, runs now`);
      else if (was === "a" && now === "f") {
        if (!child && class9(line, was)) used++;
        else bad.push(`${JSON.stringify(line)}: was run, a floor now`);
      }
    });
    assert.deepEqual(bad, [], `\n${bad.slice(0, 40).join("\n")}\n(${bad.length} rows)`);
    if (child) assert.equal(used, 0);
    else assert.ok(used > 0);
  });
}
