// A high-stakes run that times out after a reload is kept incomplete with the head and tree stored at its launch, so it resumes at that head and
// is refused once the head moved; the slots of the checkout are not touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { used, emptyState } from "../highstakes.ts";
import { build, commitIn, launch, persisted, setup, tick } from "./_hsrig.ts";

type Hs = { runs?: unknown[]; incomplete?: { runId: string; head: string | null; tree: string | null }; runIds?: { id: string; head?: string | null; tree?: string | null }[] };

async function reloadedTimeout(t: Parameters<typeof setup>[0]) {
  const { w, a } = await setup(t, { onMain: true });
  w.state.answer = "allow once";
  await build(a, { size: { files: ["src/a/x.ts"] }, risk: ["design"] });
  const first = await launch(a, "reviewer", "[high-stakes] review the whole change");
  assert.equal(first.blocked, null, String(first.blocked));
  await persisted(w, (hs: Hs) => !!hs?.runIds?.some((r) => r.id === `run-${first.id}` && typeof r.head === "string" && "tree" in r));
  await a.down();
  const b = await w.adapter("reload");
  await tick(50);
  // the run times out (no success) in the new process, which never saw its launch
  await b.endEvent({ runId: `run-${first.id}`, agent: "reviewer", success: false, status: "failed", results: [{ agent: "reviewer", status: "failed", success: false, output: "" }] });
  await persisted(w, (hs: Hs) => hs?.incomplete?.runId === `run-${first.id}`);
  return { w, b, first };
}

const resume = (b: Awaited<ReturnType<typeof reloadedTimeout>>["b"], first: { id: string }) => launch(b, "reviewer", "continue", { action: "resume", id: `run-${first.id}` });

test("a high-stakes run that times out after a reload is incomplete with its launch head; a resume at the same HEAD is allowed and takes no slot", async (t) => {
  const { w, b, first } = await reloadedTimeout(t);
  const hs = w.ceremonyEntries().at(-1)!.data as { highStakes: Hs & { runs: unknown[] } };
  const stored = hs.highStakes.runIds!.find((r) => r.id === `run-${first.id}`)!;
  assert.equal(hs.highStakes.incomplete!.head, stored.head, "the launch head, not the head at the end");
  assert.equal(hs.highStakes.incomplete!.tree, stored.tree);
  assert.equal(hs.highStakes.runs.length, 0, "no slot used");
  const r = await resume(b, first);
  assert.equal(r.blocked, null, String(r.blocked));
  assert.equal(used({ ...emptyState(), runs: hs.highStakes.runs as never }, w.project), false);
});

test("after the reload the timed-out run is refused a resume once HEAD moved", async (t) => {
  const { w, b, first } = await reloadedTimeout(t);
  const cwd = (w.ceremonyEntries().at(-1)!.data as { highStakes: { incomplete: { cwd: string } } }).highStakes.incomplete.cwd; // the checkout the run was launched in
  commitIn(cwd, "src/a/moved.ts");
  const r = await resume(b, first);
  assert.match(String(r.blocked), /head moved since the high-stakes run was launched/);
});
