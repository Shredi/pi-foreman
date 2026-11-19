// Follow-up PR B2 (ledger item 9): until the permission modes go (PR C), a recursive delete whose target the gate cannot read is a floor
// (`floor-delete-unknown-target`; the own-scratch deletes that must keep running are pinned in gate-floors-t2.test.ts), refused in every mode including `allow` (gate.mode "floors-only"). One test per form, each in mode allow and mode auto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

const FLOOR = "floor-delete-unknown-target";
const MODES = ["floors-only", "full"] as const;

async function refused(t: Parameters<typeof r11Rig>[0], tool: string, line: string, child = false, rule = "delete-unknown-target"): Promise<void> {
  for (const mode of MODES) {
    const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode } }, child });
    const res = await r.call(tool, { command: line });
    assert.equal(res?.block, true, `${mode}: ${line}`);
    assert.match(String(res?.reason), new RegExp(`denied by the permission floor \\(${rule}\\)`), `${mode}: ${line}`);
  }
}

async function runs(t: Parameters<typeof r11Rig>[0], line: string): Promise<void> {
  const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode: "floors-only" } } });
  const res = await r.call("bash", { command: line });
  assert.ok(!(res?.block === true && /permission floor/.test(String(res?.reason))), `${line}: ${JSON.stringify(res)}`);
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

// ------------------------------------------------------------------ owner decision 2026-11-19: what the old Python delete check refused still is, in every mode (it ran for the foreman and for children alike)

test(`${FLOOR}: git push origin HEAD:$B (a variable destination) is refused; a literal destination and a colon-less $B were never refused`, async (t) => {
  await refused(t, "bash", "git push origin HEAD:$B", false, "git-push-force");
  await runs(t, "git push origin HEAD:feature/x");
  await runs(t, "git push origin $B");
});
test(`${FLOOR}: find $X -delete is refused (a literal start path asked before and still runs)`, async (t) => {
  await refused(t, "bash", "find $X -delete", false, "delete-unknown-target");
  await runs(t, "find build -delete");
});
test(`${FLOOR}: chmod -R and chown -R on a variable are refused`, async (t) => {
  for (const l of ["chmod -R 755 $X", "chown -R me $X"]) await refused(t, "bash", l, false, "unknown-write-target");
  await runs(t, "chmod -R 755 build");
});
test(`${FLOOR}: truncate -s 0 $X is refused`, async (t) => {
  await refused(t, "bash", "truncate -s 0 $X", false, "unknown-write-target");
  await runs(t, "truncate -s 0 f.log");
});
test(`${FLOOR}: a > redirect to a variable is refused; >> and a path below the variable were never refused`, async (t) => {
  await refused(t, "bash", "echo hi > $X", false, "unknown-write-target");
  await runs(t, "echo hi >> $X");
  await runs(t, "echo hi > $X/f");
});
test(`${FLOOR}: dd of=$X is refused`, async (t) => {
  await refused(t, "bash", "dd if=/dev/zero of=$X", false, "unknown-write-target");
});
test(`${FLOOR}: git clean with -e or --exclude is refused`, async (t) => {
  for (const l of ["git clean -fd -e keep", "git clean -fdx --exclude=keep", "git clean -fde keep"]) await refused(t, "bash", l, false, "git-clean-exclude");
  await runs(t, "git clean -fdx");
});

test(`${FLOOR}: the refusals of the old Python check hit a child as well as the foreman`, async (t) => {
  for (const l of ["find $X -delete", "chmod -R 755 $X", "truncate -s 0 $X", "echo hi > $X", "dd if=/dev/zero of=$X", "git clean -fd -e keep"]) {
    const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode: "floors-only" } }, child: true });
    const res = await r.call("bash", { command: l });
    assert.equal(res?.block, true, l);
    assert.match(String(res?.reason), /permission floor/, l);
  }
});

test(`${FLOOR}: a literal recursive PowerShell or cmd delete outside the worktree is the owner's question (a refusal for a child) in mode allow; inside it runs`, async (t) => {
  for (const [tool, l] of [["powershell", "Remove-Item -Recurse /var/stuff"], ["bash", "pwsh -c 'Remove-Item -Recurse /var/stuff'"], ["bash", "cmd /c rd /s /q /var/stuff"]] as const) {
    for (const child of [false, true]) {
      const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode: "floors-only" } }, child });
      const res = await r.call(tool, { command: l });
      assert.equal(res?.block, true, `${child ? "child" : "foreman"}: ${l}: ${JSON.stringify(res)}`);
      assert.match(String(res?.reason), /delete-outside|outside the worktree|dialog was dismissed/, `${child ? "child" : "foreman"}: ${l}: ${JSON.stringify(res)}`);
    }
  }
  await runs(t, "pwsh -c 'Remove-Item -Recurse build'");
});

test(`${FLOOR}: foreman_bg gets the same refusal as bash (guard parity of rm -rf -- "$1"/*)`, async (t) => {
  for (const mode of MODES) {
    const r = await r11Rig(t, {}, { config: { presence: { enabled: false }, gate: { mode } } });
    const res = await r.call("foreman_bg", { command: 'rm -rf -- "$1"/*' });
    assert.equal(res?.block, true, mode);
    assert.match(String(res?.reason), /permission floor \(delete-unknown-target\)/, mode);
  }
});

test(`${FLOOR}: a recursive flag of a later command or a later find is no flag of the remover in a runner string`, async (t) => {
  for (const l of ['sh -c "trash $L; grep -rn x ."', 'eval "trash $OBJ && gcc -Werror x.c"', 'bash -c "trash $F; find . -name y -print"']) await runs(t, l);
  for (const l of ['sh -c "trash $L; rm -rf $M"', 'eval "ls && rm -rf $D"', "find . -exec sh -c 'rm -rf \"$1\"; echo x' _ {} \\;"]) await refused(t, "bash", l, true);
});

test(`${FLOOR}: a PowerShell switch with a variable value is no variable operand (-Force:$f keeps the label), -Path:$p and -LiteralPath:$p are`, async (t) => {
  await runs(t, "pwsh -c 'Remove-Item -Recurse -Force:$f build'");
  await runs(t, "pwsh -c 'Remove-Item -Recurse -Confirm:$c build'");
  for (const l of ["Remove-Item -Recurse -Force:$f -Path:$p", "Remove-Item -Recurse -LiteralPath:$p"]) await refused(t, "powershell", l);
});
