// R8 ledger items 1-2: a nameref without a literal value, an integer-attribute assignment and a `${a:off:len}` substring offset may
// bind a harness-trusted name (HOME, S), so a later `$HOME/..` / `$S/..` is never trusted as a path. Test names are the literal lines.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { boundNames, buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { ownedRoots } from "../owned.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-varsbind-r8-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
const main = path.join(base, "repo");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
for (const d of [path.join(main, ".workflow"), agentDir, scratch]) fs.mkdirSync(d, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const foreman = (command: string): string => checkToolCall(rules, "bash", { command }, { cwd: main, home, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const child = (command: string): string => {
  const ctx: MatchCtx = { cwd: main, home, platform: process.platform, role: "child", scratch, owned };
  return checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
};
const runAs = (who: "child" | "foreman", line: string): string => (who === "child" ? child(line) : foreman(line));
const untrusted = (kind: string, line: string): void => assert.ok(kind === "deny" || kind === "ask", `${line}: ${kind}`);

const HOME_USE = "cat $HOME/.pi/agent/pi-foreman/x";
const S_USE = "echo y > $S/f";

test("r8 baseline: the unbound uses are trusted", { skip: !posix }, () => {
  assert.equal(foreman(HOME_USE), "pass");
  assert.equal(child(S_USE), "pass");
});

// ------------------------------------------------------------------ item 1: nameref bindings
for (const [line, name, who] of [
  [`for r in $x; do declare -n r; r=/x; done; ${HOME_USE}`, "HOME", "foreman"],
  [`r=$x; declare -n r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`r=$x; typeset -n r; r=/x; ${S_USE}`, "S", "child"],
  [`f() { local -n r; r=/x; }; r=$x; f; ${S_USE}`, "S", "child"],
  [`r=$x; declare -nx r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`read r <f; declare -n r; r=/x; ${S_USE}`, "S", "child"],
  [`declare -n r; for r in $x; do r=/x; done; ${HOME_USE}`, "HOME", "foreman"],
  [`r=HOME; declare -n r; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -n r=HOME; r=/x; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -nx r=S; r=/x; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// ------------------------------------------------------------------ item 2: integer attribute and substring offsets
for (const [line, name, who] of [
  [`declare -i x; x=$y; ${S_USE}`, "S", "child"],
  [`y=$(cat f); declare -i x; x=$y; ${S_USE}`, "S", "child"],
  [`typeset -i x; x=$y; ${HOME_USE}`, "HOME", "foreman"],
  [`f() { local -i x; x=$1; }; f "$y"; ${S_USE}`, "S", "child"],
  [`declare -ix x; x=$y; ${S_USE}`, "S", "child"],
  [`declare -ai a; a[0]=$y; ${S_USE}`, "S", "child"],
  [`declare -i x; x+=$y; ${S_USE}`, "S", "child"],
  [`declare -i x=$y; ${S_USE}`, "S", "child"],
  [`declare -i x; x=y; ${S_USE}`, "S", "child"],
  [`declare -i x; x="$y"; ${HOME_USE}`, "HOME", "foreman"],
  [`declare -i x; read x <f; ${S_USE}`, "S", "child"],
  [`declare -i x; for x in $y; do :; done; ${S_USE}`, "S", "child"],
  [`echo \${a:$off}; ${S_USE}`, "S", "child"],
  [`echo \${a:off}; ${S_USE}`, "S", "child"],
  [`echo \${a:1:$len}; ${HOME_USE}`, "HOME", "foreman"],
  [`echo \${a:1:len}; ${S_USE}`, "S", "child"],
  [`echo \${a: -x}; ${S_USE}`, "S", "child"],
  [`echo \${a:S=1}; ${S_USE}`, "S", "child"],
  [`echo \${@:$off}; ${S_USE}`, "S", "child"],
  [`echo \${a[0]:$off}; ${S_USE}`, "S", "child"],
] as const) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line).has(name), `boundNames sees ${name}`);
    untrusted(runAs(who, line), line);
  });
}

// ------------------------------------------------------------------ negatives: HOME stays unbound
for (const line of [
  "declare -i n; n=5; cat $HOME/f",
  "echo ${a:2}; cat $HOME/f",
  "echo ${a:2:3}; cat $HOME/f",
  "echo ${a: -1}; cat $HOME/f",
  "echo ${a:-x}; cat $HOME/f",
  "echo ${a:=x}; cat $HOME/f",
  "echo ${a:+x}; cat $HOME/f",
  "echo ${a:?x}; cat $HOME/f",
  "HOMEDIR=/x; cat $HOME/f",
  "echo $HOME_OLD; cat $HOME/f",
]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line).has("HOME"));
    assert.equal(foreman(line), foreman("cat $HOME/f"));
    assert.equal(foreman(line.replace("$HOME/f", HOME_USE.slice(4))), "pass");
  });
}
