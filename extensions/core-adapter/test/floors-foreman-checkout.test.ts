// A worktree child never writes into the foreman's checkout (ceremony-fixes-2 item 1): floor `foreman-checkout`.
// The case table is tests/fixtures/foreman-checkout-cases.json, shared with the child git guard's Python test.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lineFloors, pathFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

interface ShellCase { name: string; line: string; cwd?: string; floor: "deny" | "allow" | null }
interface ToolCase { name: string; tool: string; input: Record<string, string>; cwd?: string; floor: "deny" | "allow" }
const table = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "tests", "fixtures", "foreman-checkout-cases.json"), "utf8")) as { shell: ShellCase[]; tool: ToolCase[] };

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-fc-")));
const root = path.join(tmp, "foreman");
const wt = path.join(tmp, "foreman-wt");
const nested = path.join(root, ".worktrees", "child");
for (const d of [path.join(root, "src"), path.join(root, ".workflow", "scratch"), wt, nested]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(path.join(root, "src"), path.join(wt, "link"));
fs.writeFileSync(path.join(nested, ".git"), "gitdir: ../../.git/worktrees/child\n");
fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../foreman/.git/worktrees/wt\n");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sub = (s: string): string => s.replaceAll("{root}", root).replaceAll("{wt}", wt).replaceAll("{nested}", nested);
const envFor = (cwd: string, extra: Partial<FloorEnv> = {}): FloorEnv => ({ cwd, home: "/h/me", writeRoots: [cwd, os.tmpdir()], currentBranch: () => "feature/x", remoteHead: () => "main", child: true, foremanRoot: root, ...extra });
const shell = (line: string, e: FloorEnv) => lineFloors(line, parseShell(line, { cwd: e.cwd }), e);

test("the shared case table: shell lines", () => {
  for (const c of table.shell) {
    if (c.floor === null) continue;
    const e = envFor(sub(c.cwd ?? "{wt}"));
    const h = shell(sub(c.line), e);
    if (c.floor === "deny") {
      assert.equal(h?.rule, "floor-foreman-checkout", c.name);
      assert.equal(h?.kind, "deny", c.name);
      assert.match(h?.reason ?? "", /this child runs in its own worktree/, c.name);
      assert.ok((h?.reason ?? "").includes(`the foreman's checkout ${root} is read-only for it`), c.name);
      assert.ok((h?.reason ?? "").includes(e.cwd), c.name);
    } else assert.equal(h?.rule, undefined, `${c.name}: ${h?.reason}`);
  }
});

test("the shared case table: path tools", () => {
  for (const c of table.tool) {
    const e = envFor(sub(c.cwd ?? "{wt}"));
    const input = Object.fromEntries(Object.entries(c.input).map(([k, v]) => [k, sub(v)]));
    const h = pathFloors(input, e, c.tool);
    if (c.floor === "deny") {
      assert.equal(h?.rule, "floor-foreman-checkout", c.name);
      assert.match(h?.reason ?? "", /^pi-foreman: write to .* denied: this child runs in its own worktree/, c.name);
    } else assert.equal(h?.rule, undefined, `${c.name}: ${h?.reason}`);
  }
});

test("not a child, or no foreman root: the floor is off", () => {
  for (const e of [envFor(wt, { child: false }), envFor(wt, { foremanRoot: undefined })]) {
    assert.equal(shell(`cat x > ${root}/f`, e)?.rule, undefined);
    assert.equal(pathFloors({ path: `${root}/src/a.ts` }, e, "edit")?.rule, undefined);
  }
});

test("win32: drive letter, case folding and backslashes", () => {
  const w = (cwd: string): FloorEnv => ({ cwd, platform: "win32", home: "C:\\Users\\me", writeRoots: [cwd], currentBranch: () => "x", remoteHead: () => "main", child: true, foremanRoot: "C:\\Work\\Foreman" });
  const e = w("C:\\Work\\Foreman.wt\\child");
  assert.equal(shell("echo x > c:/work/foreman/src/f", e)?.rule, "floor-foreman-checkout");
  assert.equal(shell('echo x > "C:\\WORK\\FOREMAN\\src\\f"', e)?.rule, "floor-foreman-checkout");
  assert.equal(pathFloors({ path: "c:\\work\\foreman\\src\\a.ts" }, e, "edit")?.rule, "floor-foreman-checkout");
  assert.equal(pathFloors({ path: "C:/WORK/FOREMAN/src/a.ts" }, e, "write")?.rule, "floor-foreman-checkout");
  assert.equal(shell("echo x > c:/work/foreman/.WORKFLOW/scratch/n.md", e)?.rule, undefined);
  assert.equal(pathFloors({ path: "C:\\Work\\Foreman\\.workflow\\LEDGER-x.md" }, e, "write")?.rule, "floor-foreman-checkout");
  assert.equal(pathFloors({ path: "C:\\Work\\Foreman.wt\\child\\src\\a.ts" }, e, "edit")?.rule, undefined);
  assert.equal(shell('echo x > "C:\\Work\\Foreman.wt\\child\\f"', e)?.rule, undefined);
});
