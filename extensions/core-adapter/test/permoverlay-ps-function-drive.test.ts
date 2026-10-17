// R9 ledger item 11 (backlog 19): a PowerShell function defined through the function: drive (`Set-Item function:x`, `$function:x =`,
// `New-Item function:x`) or loaded by `using module` is code a later call runs, so it binds every harness-trusted name like `iex $c`
// and `Import-Module ./m.psm1` do: a later `$env:HOME/..` / `$env:FOREMAN_SCRATCH/..` is never trusted, for the foreman and a child
// alike. Test names are the literal lines.
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
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-psfunc-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
const main = path.join(base, "repo");
const scratch = path.join(base, "tmp", "pi-foreman-scratch", "child1");
for (const d of [path.join(main, ".workflow"), agentDir, scratch]) fs.mkdirSync(d, { recursive: true });
const owned = ownedRoots({ agentDir, workspaceRoot: main, tmpRoot: path.join(base, "tmp"), npmRoot: null });
const rules = buildOverlayRules(baseline, {}, {}, agentDir, pkgRoot, undefined, false, owned);

const foreman = (command: string): string => checkToolCall(rules, "powershell", { command }, { cwd: main, home, platform: process.platform, role: "main", owned })?.kind ?? "pass";
const child = (command: string): string => {
  const ctx: MatchCtx = { cwd: main, home, platform: process.platform, role: "child", scratch, owned };
  return checkToolCall(rules, "powershell", { command }, ctx)?.kind ?? "pass";
};
const untrusted = (kind: string, line: string): void => assert.ok(kind === "deny" || kind === "ask", `${line}: ${kind}`);

// the uses: trusted while unbound (pass), so a definition boundNames misses would let them through
const PS_USE = "Get-Content $env:HOME/.pi/agent/pi-foreman/x";
const CHILD_USE = "Set-Content $env:FOREMAN_SCRATCH/f y";

test("ps function drive baseline: the unbound uses are trusted", { skip: !posix }, () => {
  assert.equal(foreman(PS_USE), "pass");
  assert.equal(child(CHILD_USE), "pass");
});

// the reference outcome: dynamic code execution binds every trusted name
for (const line of [`iex $c; ${PS_USE}`, `Import-Module ./m.psm1; ${PS_USE}`]) {
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
}

// one case per form, foreman (HOME) and child (FOREMAN_SCRATCH)
const FORMS = [
  "Set-Item function:x $c; x",
  "Set-Item function:x (gc f); x",
  "Set-Item function:x (Get-Content f); x",
  "$function:x = { Remove-Item ./a }; x",
  "${function:x} = { Remove-Item ./a }; x",
  "ni function:x -Value { Remove-Item ./a }; x",
  "New-Item -Path function: -Name x -Value { Remove-Item ./a }; x",
  "using module ./m.psm1",
  // case and alias variants
  "si FUNCTION:x $c; x",
  "SET-ITEM Function:\\x $c; x",
  "New-Item -Pa Function: -Na x -Va { Remove-Item ./a }; x",
  "$FUNCTION:x = $c; x",
  "Using Module ./m.psm1",
];
for (const form of FORMS) {
  const line = `${form}; ${PS_USE}`;
  test(line, { skip: !posix }, () => {
    assert.ok(boundNames(line, "powershell").has("HOME"), "boundNames sees HOME");
    untrusted(foreman(line), line);
  });
  const cline = `${form}; ${CHILD_USE}`;
  test(cline, { skip: !posix }, () => {
    assert.ok(boundNames(cline, "powershell").has("FOREMAN_SCRATCH"), "boundNames sees FOREMAN_SCRATCH");
    untrusted(child(cline), cline);
  });
}

// control: a plain read-only command binds no trusted name and stays trusted
for (const line of [`Get-ChildItem; ${PS_USE}`]) {
  test(line, { skip: !posix }, () => {
    assert.ok(!boundNames(line, "powershell").has("HOME"), "not HOME");
    assert.equal(foreman(line), "pass");
  });
}
