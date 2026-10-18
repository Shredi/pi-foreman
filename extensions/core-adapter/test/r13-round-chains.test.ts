import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chainKey, checkLaunch, onReviewDone, RoundChains } from "../rounds.ts";

const CFG = { standard: 1, heavy: 2 };
const B = [["builder"]];
const R = [["reviewer"]];

/** One launch on the chain `input` names: the same walk index.ts does. Returns the block text or undefined. */
function launch(c: RoundChains, input: Record<string, unknown>, steps: string[][], dirs: string[] = []): string | undefined {
  c.enter(chainKey(input, c.key));
  c.applyRuling(dirs);
  const r = checkLaunch(c.state, steps, "standard", CFG, c.key);
  if (r.block) c.refusal = { key: c.key, at: Date.now() };
  else c.state = r.next;
  return r.block;
}

/** A chain whose limit (standard: 1) is reached and the next builder refused. */
function refusedP1(): { c: RoundChains; text: string } {
  const c = new RoundChains();
  launch(c, { agent: "builder", task: "P1 item 1" }, B);
  launch(c, { agent: "reviewer", task: "P1 review" }, R);
  c.state = onReviewDone(c.state, "fail");
  assert.equal(launch(c, { agent: "builder", task: "P1 fix" }, B), undefined);
  c.state = onReviewDone(c.state, "fail");
  const text = launch(c, { agent: "builder", task: "P1 fix again" }, B);
  assert.ok(text);
  return { c, text };
}

function tmpDir(t: { after: (f: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "r13-chain-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("chains (a): P1 at the limit does not block a P2 builder", () => {
  const { c, text } = refusedP1();
  assert.match(text, /chain P1/);
  assert.equal(launch(c, { agent: "builder", task: "P2 item 3" }, B), undefined);
  assert.equal(c.key, "P2");
  assert.equal(c.state.used, 0);
});

test("chains (a2): back on P1 the count is still at the limit", () => {
  const { c } = refusedP1();
  launch(c, { agent: "builder", task: "P2 item 3" }, B);
  assert.ok(launch(c, { agent: "builder", task: "P1 once more" }, B));
});

test("chains (b): the ruling line unblocks the same chain exactly once", async (t) => {
  const { c } = refusedP1();
  const dir = tmpDir(t);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "APPROVED\nrevision-round: +1\n");
  assert.equal(launch(c, { agent: "builder", task: "P1 fix 3" }, B, [dir]), undefined);
  c.state = onReviewDone(c.state, "fail");
  const text = launch(c, { agent: "builder", task: "P1 fix 4" }, B, [dir]);
  assert.ok(text, "the same ruling does not count twice");
  assert.match(text, /revision-round: \+1/);
  assert.match(text, /owner prompt/);
  assert.match(text, /chain P1/);
});

test("chains (c): a ruling older than the refusal is ignored", async (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "revision-round: +1\n");
  await new Promise((r) => setTimeout(r, 20));
  const { c } = refusedP1();
  assert.ok(launch(c, { agent: "builder", task: "P1 fix 3" }, B, [dir]));
});

test("chains: a ruling without the line, and an owner prompt (clear), behave as before", async (t) => {
  const { c } = refusedP1();
  const dir = tmpDir(t);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, "ruling-1.md"), "APPROVED\n");
  assert.ok(launch(c, { agent: "builder", task: "P1 fix 3" }, B, [dir]));
  c.clear();
  assert.equal(c.key, "P1");
  assert.equal(c.state.used, 0);
});

test("chainKey: phase named in task, chain step or parallel entry; none keeps the current key", () => {
  assert.equal(chainKey({ task: "do P3 now" }, "P1"), "P3");
  assert.equal(chainKey({ chain: [{ agent: "builder", task: "phase 4 work" }] }), "P4");
  assert.equal(chainKey({ chain: [{ parallel: [{ agent: "builder", task: "P5" }] }] }), "P5");
  assert.equal(chainKey({ agent: "builder", task: "no phase" }, "P2"), "P2");
  assert.equal(chainKey({}), "main");
});
