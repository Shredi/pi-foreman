// PR B follow-up: T2 rows ps-remove-splat and ps-remove-pipeline-recurse (judge-first), and the cmd switch clusters (`/s/q`) and `-Recurse:$true` of the PowerShell units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, unknownTargetDelete, type FloorEnv } from "../floors.ts";
import { parseShell, type ShellSegment } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "C:\\Users\\me", platform: "linux", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], scratch: [], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const PS_SEG: ShellSegment = { program: "powershell", argv: [], redirects: [], heredoc: false, cwd: env.cwd, wrappers: [], opaque: "foreign_shell" };
const segsOf = (line: string, tool: string): ShellSegment[] => (tool === "powershell" ? [PS_SEG] : parseShell(line, { cwd: env.cwd, platform: "linux" }));
const floor = (line: string, tool = "bash"): string | null => lineFloors(line, segsOf(line, tool), env)?.rule ?? null;
const label = (line: string, tool = "bash"): string | null => unknownTargetDelete(line, segsOf(line, tool), env)?.name ?? null;
const LABEL = "danger-delete-unknown-target";

test("Remove-Item with a splatted list and a delete fed by a recursive listing are judge-first (powershell tool, pwsh -c)", () => {
  for (const l of ["Remove-Item @p", "ri @p", "Get-ChildItem C:\\x -Recurse | Remove-Item -Force"]) {
    assert.equal(label(l, "powershell"), LABEL, `ps tool: ${l}`);
    assert.equal(floor(l, "powershell"), null, `ps tool floor: ${l}`);
    const bash = `pwsh -c '${l}'`;
    assert.equal(label(bash), LABEL, `pwsh -c: ${l}`);
    assert.equal(floor(bash), null, `pwsh -c floor: ${l}`);
  }
  for (const l of ["Remove-Item x.txt", "Get-ChildItem C:\\x | Remove-Item y.txt", "Get-ChildItem -Recurse"]) assert.equal(label(l, "powershell"), null, l);
});

test("cmd switch clusters and -Recurse:$true: system targets are floored, others get the label only", () => {
  for (const l of ["rd /s/q C:\\Windows", "rd /S/Q C:\\Windows", "rd /q/s C:\\Windows", "del /s/q %USERPROFILE%", "Remove-Item -Recurse:$true C:\\Windows"]) {
    assert.equal(floor(l, "powershell"), "floor-rm-system", `ps tool: ${l}`);
    const bash = `pwsh -c '${l}'`;
    assert.equal(floor(bash), "floor-rm-system", `pwsh -c: ${l}`);
  }
  assert.equal(floor("cmd /c rd /s/q C:\\\\Windows"), "floor-rm-system");
  for (const l of ["rd /s/q build", "Remove-Item -Recurse:$true build"]) {
    assert.equal(floor(l, "powershell"), null, `floor: ${l}`);
    assert.equal(label(l, "powershell"), LABEL, `label: ${l}`);
  }
});
