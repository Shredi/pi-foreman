// R37 item 4: a write outside the session's workspace (ruling files and a ledger inside a child's handoff dir) never
// binds a ledger and never counts toward the heavy file count, so the tier does not change. Control: nine writes
// inside the workspace still escalate, and the tier trace event carries a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { boundLedger } from "../marker.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.9" : false;

type Rig = Awaited<ReturnType<typeof r11Rig>>;
const write = (a: Rig, file: string, text = "x\n") => a.toolDoing("write", { path: file }, () => fs.writeFileSync(file, text));
const edit = (a: Rig, file: string) => a.toolDoing("edit", { path: file }, () => fs.appendFileSync(file, "- [x] 1. done\n"));
const bound = (a: Rig) => boundLedger(path.join(a.agentDir, "pi-foreman", "state"), a.sessionId);

test("r37: ruling files and a ledger in a child's handoff dir change neither tier nor binding", { skip }, async (t) => {
  const a = await r11Rig(t);
  const dir = a.handoff("round", "parent");
  fs.mkdirSync(path.join(dir, ".workflow"), { recursive: true });
  const childLedger = path.join(dir, ".workflow", "LEDGER-x.md");
  fs.writeFileSync(childLedger, "# x\n\nTier: heavy\n\n- [ ] 1. work\n");
  for (const [n, text] of [["brief.md", "brief\n"], ["plan.md", "plan\n"], ["ruling.md", "APPROVED\n"], ["round-state.json", "{}\n"]]) fs.writeFileSync(path.join(dir, n), text);

  // the parent's own ledger is the binding
  const own = path.join(a.project, ".workflow", "LEDGER-own.md");
  await write(a, own, "# own\n");
  const real = fs.realpathSync.native(own);
  assert.equal(bound(a), real);
  const tiers = a.events("tier").length;

  for (let i = 1; i <= 12; i++) await write(a, path.join(dir, `ruling-${i}.md`), `go on ${i}\n`);
  await write(a, childLedger, "# x\n\nTier: heavy\n\n- [x] 1. work\n");
  await edit(a, childLedger);

  assert.equal(bound(a), real, "the bound ledger is unchanged");
  assert.equal(a.events("tier").length, tiers, "no tier event");
  assert.ok(a.events("guard").some((r) => r.guard === "ledger_bind" && r.decision === "skip" && r.reason === "outside_workspace"), "the skip is traced");
  assert.equal(a.events("tier").filter((r) => r.tier === "heavy").length, 0);
});

test("r37 control: nine writes inside the workspace still escalate, and the tier event carries a reason", { skip }, async (t) => {
  const a = await r11Rig(t);
  fs.mkdirSync(path.join(a.project, "src"), { recursive: true });
  for (let i = 1; i <= 9; i++) await write(a, path.join(a.project, "src", `f${i}.ts`), "export {};\n");
  const heavy = a.events("tier").filter((r) => r.tier === "heavy");
  assert.equal(heavy.length, 1);
  assert.match(String(heavy[0].reason), /^more /, "the reason is traced (the trace scrubber shortens the path-like words)");
});
