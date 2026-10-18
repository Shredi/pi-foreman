// R6 lane 4 security revision 2: a session cannot write its own parent's ruling (refused up front, per session).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-selfrul-")));
  const mk = (name: string, parent: string, child: string) => {
    const d = path.join(root, "handoffs", name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "parent"), `${parent}\n`);
    fs.writeFileSync(path.join(d, "child"), `${child}\n`);
    return d;
  };
  const up = mk("up", "other", "me");
  const down = mk("down", "me", "kid");
  return { root, up, down, dirs: childHandoffDirs(path.join(root, "handoffs"), "me") };
}
const refuse = (r: ReturnType<typeof rig>, tool: string, input: Record<string, unknown>, cwd = r.root) => selfRulingRefusal(tool, input, cwd, r.dirs);

test("self ruling: write, edit, foreman_copy dst and foreman_move dst into the child-side dir are refused", async () => {
  const r = rig();
  const f = path.join(r.up, "ruling-1.md");
  assert.equal(await refuse(r, "write", { path: f }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "edit", { path: path.join(r.up, "ruling.md") }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "foreman_copy", { src: "a", dst: f }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "foreman_move", { src: "a", dst: f }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "write", { path: "ruling.md" }, r.up), SELF_RULING_REASON);
});

test("self ruling: shell redirect, cp, backgrounded job and foreman_bg/bg_run naming the path are refused", async () => {
  const r = rig();
  const f = path.join(r.up, "ruling.md");
  for (const tool of ["bash", "powershell", "foreman_bg", "bg_run"]) assert.equal(await refuse(r, tool, { command: `echo APPROVED > ${f}` }), SELF_RULING_REASON, tool);
  assert.equal(await refuse(r, "bash", { command: `cp x ${f}` }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "bash", { command: `(sleep 2; printf APPROVED > "${f}") &` }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "bash", { command: "cp x ruling.md" }, r.up), SELF_RULING_REASON);
  assert.equal(await refuse(r, "bash", { command: `cat ${f} & cp x ${f}` }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "bash", { command: `cd ${r.up} && cp x ruling*.md` }), SELF_RULING_REASON);
  assert.equal(await refuse(r, "foreman_bg", { command: `sleep 3 && cp x ${f}` }), SELF_RULING_REASON);
});

test("self ruling: pure reads of the ruling and the dir stay allowed", async () => {
  const r = rig();
  assert.equal(await refuse(r, "bash", { command: `cat ${path.join(r.up, "ruling-1.md")}` }), undefined);
  assert.equal(await refuse(r, "bash", { command: `ls ${r.up}` }), undefined);
  assert.equal(await refuse(r, "bash", { command: `head -3 ${path.join(r.up, "ruling.md")} | wc -l` }), undefined);
});

test("self ruling: parent-side dirs, unrelated shell commands and the harness .seen write are unaffected", async () => {
  const r = rig();
  assert.equal(await refuse(r, "write", { path: path.join(r.down, "ruling.md") }), undefined);
  assert.equal(await refuse(r, "bash", { command: `echo APPROVED > ${path.join(r.down, "ruling-2.md")}` }), undefined);
  assert.equal(await refuse(r, "write", { path: path.join(r.up, ".seen") }), undefined);
  assert.equal(await refuse(r, "bash", { command: "rm *.o" }), undefined);
  assert.equal(await refuse(r, "write", { path: path.join(r.up, "result.md") }), undefined);
});
