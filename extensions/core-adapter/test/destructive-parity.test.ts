// PR B2 parity: in mode `allow` (the gate result before the mode step: nothing decided runs) every line of the fixture is refused at least as hard as the stricter of the removed
// Python delete guard and the floors at f0d8b980, for the foreman and for a child. The classes below are the only differences that pass; any other difference fails.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

type Foreman = "allow" | "ask" | "deny";
type Child = "allow" | "refused";
interface Row { path: string; tool: string; line: string; was: { foreman: Foreman; child: Child }; class?: number }
const rows: Row[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "destructive-parity.json"), "utf8")).rows;

/** The allowed differences: `dir` is the only direction the class allows, with its reason. */
const CLASSES: Record<number, { dir: "looser" | "stricter"; why: string }> = {
  1: { dir: "looser", why: "owner exception: a recursive rm over ssh, and a delete inside the worktree, run" },
  2: { dir: "stricter", why: "2026-11-18 ruling: `cd $D && rm -rf build` and `find . -exec rm -rf {} +` (and their direct variants, `git -C d clean $X`) are refused for the foreman instead of a dialog" },
  3: { dir: "looser", why: "approved by #289 (ledger 8): scratch deletes through FOREMAN_SCRATCH, a read-only `which rm`/git loop, a non-delete `$a=...` assignment, a push to a named feature branch" },
  4: { dir: "stricter", why: "PowerShell system-folder and disk lines stay a hard deny where the Python guard only asked" },
  5: { dir: "looser", why: "the Python guard's own tamper and in-band bypass strings are no concern of the floors" },
  6: { dir: "stricter", why: "the redirect target ends its command by the parser's node offsets: a trailing comment or a closing `)` no longer hides `> $F` (the Python regex let `echo hi > $F # c` and `( echo hi > $F )` run)" },
  7: { dir: "looser", why: "Python text match, no command runs: `bash -c 'echo \"f(){ rm -rf ~; }\"'` only prints the text of a function" },
};

const base = fs.realpathSync(mkTestTmp("pf-parity-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(wt, "sub"), path.join(wt, "build"), scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const verdict = (r: Row, child: boolean): Foreman | Child => {
  const o = gateEvaluate(r.tool, { command: r.line }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  if (x && "block" in x) return child ? "refused" : "deny";
  if (x && "ask" in x) return child ? "refused" : "ask";
  return "allow";
};
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2, refused: 2 };

test("the fixture covers every recursing path and a spread of rows", () => {
  assert.ok(rows.length >= 800, String(rows.length));
  for (const p of ["rm", "ssh", "container", "function-body", "multiplexer", "ps-remove", "ps-iex", "redirect", "git", "docker-exec", "busybox-sh-c", "allow-pin"]) assert.ok(rows.some((r) => r.path === p), p);
});

for (const [who, child] of [["foreman", false], ["child", true]] as const) {
  test(`mode allow, ${who}: no difference from the baseline outside the allowed classes`, () => {
    const bad: string[] = [];
    const used = new Set<number>();
    for (const r of rows) {
      const was = r.was[who];
      const now = verdict(r, child);
      const dir = RANK[now] < RANK[was] ? "looser" : RANK[now] > RANK[was] ? "stricter" : null;
      if (dir === null) continue;
      if (r.class !== undefined && CLASSES[r.class]?.dir === dir) { used.add(r.class); continue; }
      bad.push(`${r.tool} ${JSON.stringify(r.line)}: was ${was}, now ${now} (${dir}${r.class ? `, class ${r.class} allows ${CLASSES[r.class]?.dir}` : ", no class"})`);
    }
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
    assert.ok(used.size > 0);
  });
}

test("every class is used, and a row with a class differs for the foreman or the child (no stale class)", () => {
  const stale: string[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.class === undefined) continue;
    seen.add(r.class);
    const differs = (["foreman", "child"] as const).some((w) => RANK[verdict(r, w === "child")] !== RANK[r.was[w]]);
    if (!differs) stale.push(r.line);
  }
  assert.deepEqual(stale, []);
  assert.deepEqual([...seen].sort().map(String), Object.keys(CLASSES));
});

test("the restored forms are refused again for both", () => {
  const refused = (line: string, tool = "bash"): void => {
    for (const child of [false, true]) assert.notEqual(verdict({ path: "x", tool, line, was: { foreman: "deny", child: "refused" } }, child), "allow", `${child ? "child" : "foreman"}: ${line}`);
  };
  for (const l of ["busybox rm -rf ~", "toybox rm -rf ~", "git clean -fd $X", "docker exec c rm -rf /data", "kubectl exec p -- rm -rf /data",
    "f(){ rm -rf ~; }; f", "function g { rm -rf $1; }; g x", "busybox sh -c 'rm -rf ~'", "f(){ mkfs.ext4 /dev/sdb; }; f", "git push origin HEAD:$B", "git clean -fd -e keep"]) refused(l);
  for (const l of ["Remove-Item -Recurse -LiteralPath:C:\\Windows", "Remove-Item -Recurse $p", "iex $s", "pwsh -EncodedCommand AAAA", "Remove-Item @p"]) refused(l, "powershell");
});

test("the harmless lines still run", () => {
  for (const child of [false, true]) {
    for (const l of ["echo > $F arg", "echo hi >| $F", "git push origin $B", "ssh host 'rm -rf /data'", "ssh host ls", "docker ps", "rm -rf *", "iex -S mix"]) {
      assert.equal(verdict({ path: "x", tool: "bash", line: l, was: { foreman: "allow", child: "allow" } }, child), "allow", `${child ? "child" : "foreman"}: ${l}`);
    }
    assert.equal(verdict({ path: "x", tool: "powershell", line: "iex 'Get-Date'", was: { foreman: "allow", child: "allow" } }, child), "allow");
  }
});
