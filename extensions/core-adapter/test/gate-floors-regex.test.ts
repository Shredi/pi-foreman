// r79 item 18: the gate never compiles command text into a RegExp (a `[A-Za-z_` pattern word made floors.ts globRe throw: gate-error).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { boundNames } from "../permoverlay.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo"], scratch: [], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd }), env)?.rule ?? null;

/** Run `fn` with every compiled RegExp source recorded. */
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

test("a for loop with grep -o -E and sed -E class words is no gate-error and no floor hit", () => {
  const line = `for f in *.ts; do grep -o -E '[A-Za-z_][A-Za-z0-9_]*' "$f" | sed -E 's/x/y/'; done`;
  assert.equal(floor(line), null);
  assert.equal(floor(`grep -E [A-Za-z_][A-Za-z0-9_]* a.ts`), null);
});

test("an unterminated class word passes", () => {
  assert.equal(floor("grep -E '[abc' a.ts"), null);
  assert.equal(floor("grep -E [abc* a.ts"), null);
  assert.equal(floor("grep -E 'a]b?' a.ts"), null);
});

test("a protected path with brackets in it is still protected", () => {
  assert.equal(floor("sed -i s/a/b/ /h/me/.pi/agent/pi-foreman/permissions.json"), "floor-policy-file");
  assert.equal(floor("sed -i s/a/b/ /h/me/.pi/agent/pi-foreman/permissions.js*"), "floor-policy-file");
  assert.equal(floor("sed -i s/a/b/ /h/me/.pi/agent/pi-foreman/state/approvals/[ab]*"), "floor-policy-file");
  assert.equal(floor("sed -i s/a/b/ /h/me/.pi/agent/pi-foreman/perm[i]ssions.js*"), "floor-policy-file");
});

test("a catastrophic backtracking pattern word is never compiled and runs in constant time", () => {
  const line = `grep -E '(a+)+$' ${"a".repeat(40)}! x.txt`;
  const t0 = Date.now();
  const { out, sources } = spyRegExp(() => floor(line));
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(sources.some((s) => s.includes("(a+)+") || s.includes("(a\\+)\\+")), false);
  const globbed = spyRegExp(() => floor(`grep -E '(a+)+$*' x`));
  assert.equal(globbed.out, null);
  assert.equal(globbed.sources.some((s) => s.includes("(a+)+")), false);
});

test("permoverlay: a shell variable name that is not a plain identifier never reaches new RegExp", () => {
  const { sources } = spyRegExp(() => boundNames("declare -i 'a(+)+b' 'c.d[' ; typeset -i '(x+)+=1'; local -i 'e$' ; (a+)+=1"));
  assert.equal(sources.some((s) => s.includes("(a+)+") || s.includes("a(+)+b") || s.includes("c.d[") || s.includes("(x+)+")), false);
});
