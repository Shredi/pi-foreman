// PR B2 parity, re-based on PR C (there are no modes): every line of the fixture gets the verdict recorded in its `now` field, for the foreman and for a child, and `now` stays
// consistent with `was`, the stricter of the removed Python delete guard and the floors at f0d8b980: a line that was refused is never run unless it is in a named class below, and
// a line that was refused or asked on is never looser than the judge-first list says (judge: the gate hands the call to the judge first).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

type Foreman = "allow" | "ask" | "deny";
type Child = "allow" | "refused";
type Now = "run" | "judge" | "floor" | "ask";
interface Row { path: string; tool: string; line: string; was: { foreman: Foreman; child: Child }; now: { foreman: Now; child: Now }; class?: number }
const rows: Row[] = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "destructive-parity.json"), "utf8")).rows;

/** The deliberate differences from `was` that stay: `dir` is the only direction the class allows, with its reason. Everything the judge-first list took over from a refusal needs no class. */
const CLASSES: Record<number, { dir: "looser" | "stricter"; why: string }> = {
  1: { dir: "looser", why: "owner exception: a delete inside the worktree runs (a recursive rm over ssh is judge-first since the PR C security round)" },
  3: { dir: "looser", why: "approved by #289 (ledger 8): scratch deletes through FOREMAN_SCRATCH, a read-only `which rm`/git loop, a non-delete `$a=...` assignment, a push to a named feature branch" },
  4: { dir: "stricter", why: "PowerShell system-folder and disk lines stay a hard deny where the Python guard only asked" },
  5: { dir: "looser", why: "the Python guard's own tamper and in-band bypass strings are no concern of the floors" },
  7: { dir: "looser", why: "Python text match, no command runs: `bash -c 'echo \"f(){ rm -rf ~; }\"'` only prints the text of a function" },
  8: { dir: "looser", why: "owner 2026-11-19: an unknown wrapper inside a `-c`/eval string (`sh -c 'taskset 1 rm -rf ~'`, strace, `script -c`, also under `busybox sh -c`) runs; no text match, no program list (round judge-first-unknown: ionice, chroot and unbuffer are runners the walker does not unwrap and go to the judge, ledger item 1)" },
  // round judge-first-unknown: a busybox/toybox applet the walker does not unwrap, or a wrapper behind one, is no known-safe program (ledger item 1) and now ends in a floor
  11: { dir: "stricter", why: "round judge-first-unknown: `busybox reboot`, `busybox sudo ls`, `busybox fdisk -l` and the like name a program this walker does not read, so the call is not known-safe" },
  10: { dir: "stricter", why: "coproc bodies are read (the Python guard and the floors at f0d8b980 looked inside none): a system delete in one is a floor" },
};

/** `looser`: refused or asked on before, runs now. `stricter`: allowed or asked on before, a floor now (a judge-first hit is the list taking a call over and needs no class). */
const direction = (was: Foreman | Child, now: Now): "looser" | "stricter" | null => (was !== "allow" && now === "run" ? "looser" : (was === "allow" || was === "ask") && now === "floor" ? "stricter" : null);

const base = fs.realpathSync(mkTestTmp("pf-parity-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [path.join(wt, "sub"), path.join(wt, "build"), scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
/** What the gate does with the call: a refusal (`floor`), a question that is no judge-first hit (`ask`), the judge first (`judge`), or nothing (`run`). */
const verdictOf = (tool: string, line: string, child: boolean): Now => {
  const o = gateEvaluate(tool, { command: line }, wt, { env: (cwd) => baseFloorEnv(cwd, { scratch: [scr], home: "/Users/fixture", ...(child ? { child: true, builder: true } : {}) }), roots: () => roots(child) });
  const x = o.result;
  if (x && "block" in x) return "floor";
  if (x && "ask" in x) return "ask";
  return o.danger ? "judge" : "run";
};
const verdict = (r: Row, child: boolean): Now => verdictOf(r.tool, r.line, child);
/** One line, both roles, the same verdict. */
const both = (tool: string, line: string, want: Now): void => {
  for (const child of [false, true]) assert.equal(verdictOf(tool, line, child), want, `${child ? "child" : "foreman"}: ${line}`);
};

test("the fixture covers every recursing path and a spread of rows", () => {
  assert.ok(rows.length >= 800, String(rows.length));
  for (const p of ["rm", "ssh", "container", "function-body", "multiplexer", "ps-remove", "ps-iex", "redirect", "git", "docker-exec", "busybox-sh-c", "allow-pin"]) assert.ok(rows.some((r) => r.path === p), p);
});

for (const [who, child] of [["foreman", false], ["child", true]] as const) {
  test(`${who}: every row gets the verdict recorded in its now field`, () => {
    const bad: string[] = [];
    for (const r of rows) {
      const now = verdict(r, child);
      if (now !== r.now[who]) bad.push(`${r.tool} ${JSON.stringify(r.line)}: recorded ${r.now[who]}, now ${now}`);
    }
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
  });

  test(`${who}: no difference from the baseline outside the named classes`, () => {
    const bad: string[] = [];
    for (const r of rows) {
      const was = r.was[who];
      const now = r.now[who];
      const dir = direction(was, now);
      if (dir === null || (r.class !== undefined && CLASSES[r.class]?.dir === dir)) continue;
      bad.push(`${r.tool} ${JSON.stringify(r.line)}: was ${was}, now ${now} (${dir}${r.class ? `, class ${r.class} allows ${CLASSES[r.class]?.dir}` : ", no class"})`);
    }
    assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
  });
}

test("every class is used, and a row with a class differs for the foreman or the child in its direction (no stale class)", () => {
  const stale: string[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.class === undefined) continue;
    seen.add(r.class);
    if (!(["foreman", "child"] as const).some((w) => direction(r.was[w], r.now[w]) === CLASSES[r.class!]?.dir)) stale.push(r.line);
  }
  assert.deepEqual(stale, []);
  assert.deepEqual([...seen].sort((x, y) => x - y).map(String), Object.keys(CLASSES));
});

test("the moved forms go to the judge first, for the foreman and a child", () => {
  for (const l of ["git clean -fd $X", "docker exec c rm -rf /data", "kubectl exec p -- rm -rf /data", "function g { rm -rf $1; }; g x", "git clean -fd -e keep"]) both("bash", l, "judge");
  for (const l of ["chmod -R 777 $X", "chown -R me $X", "truncate -s 0 $X", "echo hi > $F", "dd of=$X if=/dev/zero", "find $X -delete", "xargs rm -rf", "find . -exec rm -rf {} +", "sh -c \"rm -rf $D\"", "eval \"rm -rf $D\"", "rm -rf \"$X\"/*"]) both("bash", l, "judge");
  for (const l of ["Remove-Item -Recurse $p", "iex $s", "pwsh -EncodedCommand AAAA", "Remove-Item @p", "Get-ChildItem | Remove-Item -Recurse"]) both("powershell", l, "judge");
});

test("the forms that stay floors: literal system deletes, the rare local forms, a variable push destination", () => {
  for (const l of ["rm -rf ~", "busybox rm -rf ~", "toybox rm -rf ~", "f(){ rm -rf ~; }; f", "busybox sh -c 'rm -rf ~'", "git push origin HEAD:$B", "rm -rf $X; rm -rf ~", "f(){ rm -rf $1; rm -rf ~; }; f", "sh -c 'rm -rf $X; rm -rf ~'"]) both("bash", l, "floor");
  both("powershell", "Remove-Item -Recurse -LiteralPath:C:\\Windows", "floor");
});

test("a remote command (ssh, docker or podman exec, kubectl exec) is judge-first whatever it runs (owner decision of the PR C security round)", () => {
  for (const l of ["ssh host 'rm -rf /data'", "ssh host ls", "docker exec c ls"]) both("bash", l, "judge");
});

test("the harmless lines still run", () => {
  for (const child of [false, true]) {
    for (const l of ["git push origin $B", "docker ps", "rm -rf *", "iex -S mix"]) assert.equal(verdictOf("bash", l, child), "run", `${child ? "child" : "foreman"}: ${l}`);
  }
  // a redirect through a variable is run by the foreman when the variable is not the target at the end of the command; a child's write through it is the write check's judge-first hit (D4)
  for (const l of ["echo > $F arg", "echo hi >| $F"]) assert.equal(verdictOf("bash", l, false), "run", `foreman: ${l}`);
  both("powershell", "iex 'Get-Date'", "run");
});

test("sudo/doas in a body or string is read behind the privilege program; a recursive rm outside the roots in a body or behind a wrapper goes to the judge", () => {
  for (const l of ["f(){ sudo rm -rf ~; }; f", "f(){ doas find / -delete; }; f", "f(){ sudo shred /x; }; f", "f(){ sudo mkfs.ext4 /dev/sdb; }; f", "f(){ xargs -I{} sudo rm -rf {}; }; f"]) assert.notEqual(verdictOf("bash", l, false), "run", l);
  // round judge-first-unknown (ledger item 1): a busybox applet behind a shell string is a program the walker does not read, so these are refused now instead of judged
  for (const l of ["sh -c 'busybox rm -rf /opt/x'", "sh -c 'busybox nice rm -rf /opt/x'", "sh -c 'busybox env rm -rf /opt/x'", "sh -c 'busybox timeout 5 rm -rf /opt/x'",
    "sh -c 'busybox setsid rm -rf /opt/x'", "sh -c 'busybox nohup rm -rf /opt/x'", "busybox rm -rf /opt/x"]) both("bash", l, "floor");
  for (const l of ["eval 'toybox rm -r /opt/x'", "f(){ env rm -rf /opt/x; }; f", "f(){ command rm -rf /opt/x; }; f", "f(){ rm -rf /opt/x; }; f"]) both("bash", l, "judge");
});

// round judge-first-unknown (ledger item 1): ionice, chroot and unbuffer are runners the walker does not unwrap, so the program behind them was not walked: judged now, no longer running
test("class 8: an unknown wrapper inside a -c/eval string or a function body keeps running when it is no runner; an unwalked runner goes to the judge (no text match, no program list)", () => {
  for (const l of ["sh -c 'taskset 1 rm -rf ~'", "sh -c 'strace rm -rf ~'"]) both("bash", l, "run");
  for (const l of ["sh -c 'ionice rm -rf ~'", "sh -c 'chroot / rm -rf ~'", "sh -c 'unbuffer rm -rf ~'", "busybox sh -c 'ionice rm -rf ~'", "eval 'ionice rm -rf ~'", "f(){ ionice rm -rf ~; }; f"]) both("bash", l, "judge");
});
