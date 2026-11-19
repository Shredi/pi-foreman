// Follow-up PR B2 (ledger item 9): until the permission modes go (PR C), a recursive delete whose target the gate cannot read is a floor
// (`floor-delete-unknown-target`; the own-scratch deletes that must keep running are pinned in gate-floors-t2.test.ts), refused in every mode including `allow` (gate.mode "floors-only"). One test per form, each in mode allow and mode auto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const FLOOR = "floor-delete-unknown-target";
const MODES = ["floors-only", "full"] as const;

async function refused(t: Parameters<typeof r11Rig>[0], tool: string, line: string, child = false): Promise<void> {
  for (const mode of MODES) {
    const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode } }, child });
    const res = await r.call(tool, { command: line });
    assert.equal(res?.block, true, `${mode}: ${line}`);
    assert.match(String(res?.reason), /denied by the permission floor \(delete-unknown-target\)/, `${mode}: ${line}`);
    assert.match(String(res?.reason), /cannot be read/, `${mode}: ${line}`);
  }
}

async function runs(t: Parameters<typeof r11Rig>[0], line: string): Promise<void> {
  const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode: "floors-only" } } });
  const res = await r.call("bash", { command: line });
  assert.ok(!(res?.block === true && /delete-unknown-target/.test(String(res?.reason))), `${line}: ${JSON.stringify(res)}`);
}

test(`${FLOOR}: variable or empty operand (rm -rf "$X", $X/, -- "$1"/*, "")`, async (t) => {
  for (const l of ['rm -rf "$X"', "rm -rf $X/", 'rm -rf -- "$1"/*', 'rm -rf ""']) await refused(t, "bash", l);
});
test(`${FLOOR}: variable command word that is a remover ($RM -rf build)`, async (t) => {
  await refused(t, "bash", "$RM -rf build");
});
test(`${FLOOR}: recursive rm under xargs and find -exec`, async (t) => {
  for (const l of ["ls | xargs rm -rf", "find /tmp/x -exec rm -rf {} +"]) await refused(t, "bash", l);
});
test(`${FLOOR}: eval and sh -c with a non-literal string`, async (t) => {
  for (const l of ['eval "rm -rf $D"', 'sh -c "rm -rf $D"']) await refused(t, "bash", l, true);
});
test(`${FLOOR}: rm after an unresolved cd`, async (t) => {
  await refused(t, "bash", "cd $D && rm -rf build");
});
test(`${FLOOR}: recursive PowerShell delete of a variable (powershell tool, pwsh -c, cmd rd /s /q)`, async (t) => {
  await refused(t, "powershell", "Remove-Item -Recurse -Force $p");
  await refused(t, "bash", `pwsh -c 'Remove-Item -Recurse -Force $p'`);
  await refused(t, "bash", "cmd /c rd /s /q %X%");
});

test(`${FLOOR}: literal and resolved deletes, a read-only variable command and plain finds keep running`, async (t) => {
  for (const l of ["rm -rf build", "rm -rf ./dist", "for b in $(git branch -r | grep origin/round); do git log --oneline -1 $b; done", "find . -name x -print", "pwsh -c '$a=Get-Acl -Force'"]) await runs(t, l);
});

test(`${FLOOR}: a floor-eligible hit anywhere on the line fires, in either order beside a label-only hit`, async (t) => {
  for (const l of ["git clean -fd $X; rm -rf $Y", "rm -rf $Y; git clean -fd $X"]) await refused(t, "bash", l);
});
test(`${FLOOR}: PowerShell -Path:$p and -LiteralPath:$p are variable operands`, async (t) => {
  for (const l of ["Remove-Item -Recurse -Path:$p", "Remove-Item -Recurse -LiteralPath:$p"]) await refused(t, "powershell", l);
  await refused(t, "bash", `pwsh -c 'Remove-Item -Recurse -Path:$p'`);
});
