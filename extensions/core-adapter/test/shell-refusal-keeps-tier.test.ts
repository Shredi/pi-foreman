// D71 addendum: a refused foreman shell write (bash, bg_run) no longer raises the tier trivial -> standard and no longer marks the ceremony
// (an untriaged session's later trivial triage stays trivial). A refused edit tool call (scratchpad, readonly) and the bounded over-bound
// escalation are unchanged. The real adapter and the real shell write guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { world } from "./_r46world.ts";

const pyRes = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const py = pyRes.ok ? pyRes.info.executable : null;

type World = ReturnType<typeof world>;
const rig = async (t: Parameters<typeof world>[0], ceremony: Record<string, unknown>) => {
  const w = world(t, { ceremony });
  const cfgFile = path.join(w.project, "..", "agent", "foreman.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
  cfg.presence = { enabled: false };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const a = await w.adapter("startup");
  return { w, a };
};
const escalations = async (w: World) => (await w.traceEvents()).filter((e) => e.event === "triage_escalated");
const triage = async (a: Awaited<ReturnType<typeof rig>>["a"], tier: string): Promise<{ text: string; tier: string }> => {
  const r = (await a.tool("foreman_triage")!.execute("tr", { tier, reason: "test" }, undefined, undefined, a.ctx)) as { details: { tier?: string }; content: { text: string }[] };
  return { text: r.content[0].text, tier: String(r.details.tier) };
};

for (const mode of ["scratchpad", "readonly"]) {
  test(`${mode}: a refused bg_run with a relative log redirect at trivial keeps the tier`, { skip: !py }, async (t) => {
    const { w, a } = await rig(t, { default: "trivial", foremanEdits: mode });
    await triage(a, "trivial");
    const { block } = await a.call("bg_run", { command: "node x.mjs > watch.log 2>&1" });
    assert.ok(block?.block, "refused");
    assert.match(block.reason ?? "", /shell write into project files refused/);
    assert.doesNotMatch(block.reason ?? "", /The tier is now standard/);
    assert.deepEqual(await escalations(w), []);
    assert.equal((await triage(a, "trivial")).tier, "trivial");
  });

  test(`${mode}: a refused bash redirect at trivial keeps the tier`, { skip: !py }, async (t) => {
    const { w, a } = await rig(t, { default: "trivial", foremanEdits: mode });
    await triage(a, "trivial");
    const { block } = await a.call("bash", { command: "echo x > README.md" });
    assert.ok(block?.block, "refused");
    assert.doesNotMatch(block.reason ?? "", /The tier is now standard/);
    assert.deepEqual(await escalations(w), []);
    assert.equal((await triage(a, "trivial")).tier, "trivial");
  });

  test(`${mode}: an untriaged session, a refused shell write, then a trivial triage records trivial`, { skip: !py }, async (t) => {
    const { w, a } = await rig(t, { default: "standard", foremanEdits: mode });
    const { block } = await a.call("bash", { command: "echo x > README.md" });
    assert.ok(block?.block, "refused");
    assert.doesNotMatch(block.reason ?? "", /trivial counts as standard/);
    const r = await triage(a, "trivial");
    assert.equal(r.tier, "trivial");
    assert.doesNotMatch(r.text, /Recorded as standard, not trivial/);
    assert.deepEqual(await escalations(w), []);
  });
}

test("scratchpad: a refused edit of a project file at trivial still escalates to standard", async (t) => {
  const { w, a } = await rig(t, { default: "trivial", foremanEdits: "scratchpad" });
  await triage(a, "trivial");
  const file = path.join(w.project, "src", "a.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const a = 1;\n");
  const { block } = await a.call("edit", { path: file, edits: [{ oldText: "1", newText: "2" }] });
  assert.ok(block?.block, "refused");
  assert.match(block.reason ?? "", /The tier is now standard/);
  assert.ok((await escalations(w)).some((e) => e.reason === "edit_mode"));
});

test("bounded: an over-bound edit at trivial still escalates to standard", async (t) => {
  const { w, a } = await rig(t, { default: "trivial", foremanEdits: "bounded", trivialBound: { files: 2, lines: 1, newFiles: 0 } });
  await triage(a, "trivial");
  const file = path.join(w.project, "src", "a.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "a\nb\nc\n");
  const { block } = await a.call("edit", { path: file, edits: [{ oldText: "a\nb\nc\n", newText: "x\ny\nz\n" }] });
  assert.ok(block?.block, "refused");
  const esc = await escalations(w);
  assert.equal(esc.length, 1, JSON.stringify(esc));
  assert.equal(esc[0].reason, undefined, "the bound escalation, not the edit-mode one");
  assert.equal(esc[0].to, "standard");
});
