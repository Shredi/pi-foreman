// PR B2 parity, generated part (test/_parity-cross.ts), run per role by destructive-parity-cross-foreman.test.ts and destructive-parity-cross-child.test.ts (two files: two processes).
// Every line is refused at least as hard as its recorded baseline (the stricter of the removed Python delete guard and the floors at f0d8b980), in mode `allow` (the gate result
// before the mode step).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { crossLines } from "./_parity-cross.ts";

const fixture: { count: number; baseline: string } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "destructive-parity-cross.json"), "utf8"));
const RANK: Record<string, number> = { a: 0, k: 1, d: 2, r: 2 };

/**
 * The one allowed difference (class 9), stricter for the foreman only: a multiplexer with another wrapper behind it (`busybox sudo rm -rf ~`, `busybox env mkfs`: neither old check read
 * past the applet and the wrapper), and a recursive rm outside the roots behind any wrapper in a body or before a multiplexer (`f(){ nice rm -rf /opt/x; }; f`, `nice busybox rm -rf
 * /opt/x`: a dialog before, a deny now, since only a command that needed no unwrapping keeps the dialog). Any other difference fails.
 */
const class9 = (line: string, was: string): boolean => (was === "a" && /\b(?:busybox|toybox)\b/.test(line)) || (was === "k" && line.includes("rm -rf /opt/x"));

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
    if (x && "block" in x) return child ? "r" : "d";
    if (x && "ask" in x) return child ? "r" : "k";
    return "a";
  };

  test("the generated cross product has the recorded size", () => {
    assert.equal(lines.length, fixture.count);
    assert.equal(fixture.baseline.length, 2 * lines.length);
  });

  test(`mode allow, ${who}: the cross product is refused at least as hard as the baseline`, () => {
    const bad: string[] = [];
    let used = 0;
    lines.forEach(({ line }, i) => {
      const was = fixture.baseline[2 * i + (child ? 1 : 0)];
      const now = verdict(line);
      if (RANK[now] === RANK[was]) return;
      if (RANK[now] > RANK[was] && !child && class9(line, was)) { used++; return; }
      bad.push(`${JSON.stringify(line)}: was ${was}, now ${now}`);
    });
    assert.deepEqual(bad, [], `\n${bad.slice(0, 40).join("\n")}\n(${bad.length} rows)`);
    if (child) assert.equal(used, 0);
    else assert.ok(used > 0);
  });
}
