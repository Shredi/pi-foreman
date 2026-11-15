// Round 2, step 2 part A: the powershell tool's `floor-builtin-deny` against the old permission overlay, line by line. The gate splits a line into
// the units the overlay matched its `bash.deny` patterns against (psunits.ts is the overlay's own lexer), so the two must agree on every row.
// This test goes with the overlay (permoverlay.ts) in the deletion step (step 6): delete it there.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { gateDecide, type GateResult } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const base = fs.realpathSync.native(mkTestTmp("pf-r2-psdiff-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const scr = path.join(base, "scr");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [agentDir, work, scr]) fs.mkdirSync(d, { recursive: true });

const rules = buildOverlayRules(readBaseline(PKG_ROOT)!, {}, {}, agentDir, PKG_ROOT);
const envOf = (child: boolean): FloorEnv => ({ cwd: work, home, agentDir, writeRoots: [work, scr], scratch: [scr], pkgRoot: PKG_ROOT, child });
const roots = (role: string) => ({ worktree: work, scratch: [scr], tmp: [fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true }) as never;
const gate = (role: string, command: string): string | null => {
  const r: GateResult = gateDecide("powershell", { command }, work, { env: () => envOf(role !== "foreman"), roots: () => roots(role) });
  return r && "block" in r && r.block ? (r.rule ?? null) : null;
};
/** The pattern of the deny-list rule the overlay refused with, or null (a refusal for another reason, an ask or a pass is no deny-list refusal). */
const oldPattern = (role: "main" | "child", command: string): string | null => {
  const d = checkToolCall(rules, "powershell", { command }, { cwd: work, home, platform: process.platform, role, ...(role === "child" ? { scratch: scr } : {}) });
  return d?.kind === "deny" ? (/command rule '([^']*)'/.exec(d.reason)?.[1] ?? null) : null;
};

const bt = String.fromCharCode(96);
const T = "gh auth token";
const SEC = "security find-internet-password -s x";

// refused by both
const REFUSED = [
  T, "GH AUTH TOKEN", SEC, "gh auth status --show-token", "security find-generic-password -s x -w",
  `echo 1; ${T}`, `echo 1 && ${T}`, `echo 1 || ${T}`, `echo 1 | ${T}`, `& ${T}`, `& gh.exe auth token`, "gh.exe auth token", "GH.EXE auth token", "C:\\tools\\gh.exe auth token", "./gh auth token",
  "cmd /c gh auth token", "cmd /k gh auth token", "pwsh -c 'gh auth token'", "pwsh -Command \"gh auth token\"", "powershell.exe -c gh auth token", "pwsh -c \"pwsh -c 'gh auth token'\"",
  `gh ${bt}\nauth token`, `gh auth ${bt}\n token`, "gh au''th token", "gh \"auth\" token", "gh auth 'token'",
  `echo $(${T})`, `Write-Host "$(${T})"`, `$x = $(${T})`, `echo 1 2>$null; ${T}`,
  `& { ${T} }`, `{ ${T} }.Invoke()`, `if ($true) { ${T} }`, `foreach ($x in 1) { ${T} }`, `[string](${T})`, `(${T})`, `((${T}))`, `$x = (${T})`,
  `& { if ($true) { (${T}) } }`, `& { & { ${T} } }`, `& { pwsh -c { ${T} } }`, `1 | ForEach-Object { ${T} }`, `1 | % { ${T} }`, `Invoke-Command { ${T} }`,
  `try { ${T} } catch { }`, `while ($false) { ${T} }`, `function f { ${T} }; f`, `$null = & { ${T} }`, `[void](${T})`, `@(${T})`, `(${T}).Trim()`,
  // a statement after a closing brace or parenthesis
  `if ($true) { echo 1 }; ${T}`, `& { echo 1 }; ${T}`, `(echo 1); ${T}`, `$x = (1); ${T}`, `Get-Date | % { $_ } | Out-Null; ${T}`,
  `Get-ChildItem | Where-Object { $_.Length -gt 0 } ; ${SEC}`, `(1) | ${T}`, `(1) && ${T}`, `{ echo 1 }; ${T}`, `{ echo 1 } | ${T}`,
  // backtick escapes
  `echo ${bt}'; ${T}`, `echo ${bt}"; ${T}`, `echo a${bt}'b ; ${T}`, `Write-Host "a${bt}"b"; ${T}`, `echo "${bt}$("; ${T}`, `echo ${bt}${bt} ; ${T}`, `echo ${bt}{ ; ${T}`,
  // quotes, braces and parentheses before a statement
  `'{' ; ${T}`, `"(" ; ${T}`, `echo "}"; ${T}`, `Write-Host ('${T}')`,
  // a posix script inside the line gets the posix rules, a PowerShell script inside that its own again
  `bash -c 'echo ${bt}${T}${bt}'`, `bash -c 'echo ${bt}${SEC}${bt}'`, `sh -c 'gh auth tok\en'`, `eval 'gh auth tok\en'`, "bash -c 'gh auth to\\\nken'",
  `bash -c 'gh auth $'"'"'token'"'"`, `pwsh -c "bash -c 'gh auth tok\en'"`, `bash -c "pwsh -c '${T}'"`, `bash -c "pwsh -c 'gh auth status ––show-token'"`,
  `bash -c 'echo $(gh auth tok\en)'`,
  // the dashes psDashes handles (en dash, em dash, horizontal bar), so a drift between its two copies is caught
  "gh auth status ––show-token", "gh auth status —-show-token", "gh auth status ――show-token", "pwsh -c \"gh auth status ––show-token\"", "echo 1; gh auth status ——show-token",
];

// the one ruled exception, where the gate is stricter than the old layer: a backtick before CRLF continues the line, so the gate reads this as `gh auth token`
const CRLF_STRICTER = [`gh ${bt}\r\nauth token`, `gh auth ${bt}\r\n token`];

// no decision from either (the old layer matches a unit from its start; a string that only mentions the words is no unit)
const UNDECIDED = [
  `iex '${T}'`, `Invoke-Expression "${T}"`, "Start-Process gh -ArgumentList 'auth token'", `. ${T}`, `$a = ${T}`, `$env:X = ${T}`, `${bt}gh${bt}tauth`, `$h = @{ k = ${T} }`,
  `echo a${bt};gh auth token`, `& ('gh') auth token`, "& (Get-Command gh) auth token", "gh (auth) token",
];

// ordinary lines
const ORDINARY = [
  "gh auth status", "gh pr view 12", "gh auth login", "security find-certificate -a", "security find-generic-password -s x", "echo gh auth token",
  `Write-Output "${T}"`, `echo '${T}'; gh auth status`, "Get-Content notes.txt", `Write-Host "use (${T})"`, `Write-Host '{ ${T} }'`, `git commit -m 'fix (${T}) docs'`, `git commit -m "fix (${T}) docs"`,
  "Get-ChildItem . -Recurse | Where-Object { $_.Name -like '*.ts' }", "@{ a = 1 }", "echo 'a & b'", `git commit -m 'fix: & ${T} docs'`, `Select-String -Pattern '${T}' f.txt`,
  "'C:\\Program Files (x86)\\x' | Out-Null", "ls ./a(b)", "git log --format='%h (%an)'", "Get-Date", "if ($true) { echo 1 }", "$x = 1; $y = 2", `echo "a${bt}"(${T})${bt}""`,
];

test("the differential table has at least 80 lines", () => {
  assert.ok(REFUSED.length + UNDECIDED.length + ORDINARY.length >= 80);
});

const SKIPPED = (pat: string): boolean => /^(?:sudo|doas) /.test(pat) || pat.includes(" | ") || pat.startsWith("git credential fill");

for (const [oldRole, gateRole] of [["main", "foreman"], ["child", "builder"]] as const) {
  test(`powershell tool, ${gateRole}: a backtick before CRLF is refused by the gate though the old layer lets it through (named exception)`, () => {
    for (const line of CRLF_STRICTER) {
      assert.equal(oldPattern(oldRole, line), null, `${JSON.stringify(line)}: overlay`);
      assert.equal(gate(gateRole, line), "floor-builtin-deny", `${JSON.stringify(line)}: gate`);
    }
  });

  test(`powershell tool, ${gateRole}: every line the overlay refuses through the deny list is refused by the floor, and no other line is`, () => {
    for (const line of [...REFUSED, ...UNDECIDED, ...ORDINARY]) {
      const pat = oldPattern(oldRole, line);
      const rule = gate(gateRole, line);
      if (pat !== null) {
        if (pat.startsWith("git credential fill")) continue;
        const owners = SKIPPED(pat) ? ["floor-privilege", "floor-download-shell"] : ["floor-builtin-deny"];
        assert.ok(owners.includes(rule ?? ""), `${gateRole}: ${JSON.stringify(line)}: overlay refuses with '${pat}', gate gives ${rule}`);
      } else {
        assert.notEqual(rule, "floor-builtin-deny", `${gateRole}: ${JSON.stringify(line)}: overlay gives no deny-list refusal, gate refuses`);
      }
    }
  });

  test(`powershell tool, ${gateRole}: the refused-by-both rows are refused by both`, () => {
    for (const line of REFUSED) {
      assert.notEqual(oldPattern(oldRole, line), null, `${JSON.stringify(line)}: overlay`);
      assert.equal(gate(gateRole, line), "floor-builtin-deny", `${JSON.stringify(line)}: gate`);
    }
  });
}
