// R28 item 7: the core's ledger_bind.py rebinds on every Write/Edit (core re-vendored at c9522fb), so the adapter keeps
// the rule that only a Write rebinds a live binding. Port of tests/test_ledger_bind.py (the bash `ledger -f` case has no
// adapter counterpart: the adapter has no bash bind).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { boundLedger } from "../marker.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

test("R28: write rebinds, edit keeps a live binding, a write rebinds again", { skip }, async (t) => {
  const a = await r11Rig(t);
  const wf = path.join(a.project, ".workflow");
  const todo = path.join(wf, "LEDGER-todo.md");
  const r28 = path.join(wf, "LEDGER-r28.md");
  const bound = () => boundLedger(path.join(a.agentDir, "pi-foreman", "state"), a.sessionId);
  // the marker holds Python's realpath (the long, canonical name on win32); os.tmpdir() may be an 8.3 name there
  const real = (file: string) => fs.realpathSync.native(file);
  const write = (file: string) => a.toolDoing("write", { path: file }, () => fs.writeFileSync(file, "# ledger\n"));
  const edit = (file: string) => a.toolDoing("edit", { path: file }, () => fs.appendFileSync(file, "- [x] 1. done\n"));
  await write(todo);
  assert.equal(bound(), real(todo));
  await write(r28);
  assert.equal(bound(), real(r28));
  await edit(todo);
  assert.equal(bound(), real(r28), "ticking the backlog keeps the round ledger");
  assert.ok(a.events("guard").some((r) => r.guard === "ledger_bind" && r.decision === "skip"), "the skip is traced");
  await write(todo);
  assert.equal(bound(), real(todo));
});

test("R28: edit binds when unbound, or when the bound file is gone", { skip }, async (t) => {
  const a = await r11Rig(t);
  const wf = path.join(a.project, ".workflow");
  const todo = path.join(wf, "LEDGER-todo.md");
  const r28 = path.join(wf, "LEDGER-r28.md");
  fs.writeFileSync(todo, "# todo\n");
  fs.writeFileSync(r28, "# r28\n");
  const bound = () => boundLedger(path.join(a.agentDir, "pi-foreman", "state"), a.sessionId);
  const real = (file: string) => fs.realpathSync.native(file);
  await a.toolDoing("edit", { path: todo }, () => fs.appendFileSync(todo, "- [x] 1. done\n"));
  assert.equal(bound(), real(todo));
  fs.unlinkSync(todo);
  await a.toolDoing("edit", { path: r28 }, () => fs.appendFileSync(r28, "- [x] 1. done\n"));
  assert.equal(bound(), real(r28));
});
