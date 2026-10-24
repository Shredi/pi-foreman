import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import type { LiveDot } from "../livestate.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function start(dots: (() => LiveDot[]) | undefined) {
  const agent = mkTestTmp("r53l-");
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd: agent, mode: "rpc", env: {} }, () => [], undefined, undefined, undefined, dots);
  assert.ok(l);
  const read = () => JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8")) as Record<string, unknown>;
  return { l, read, done: () => (l.stop(), rmTestTmp(agent)) };
}

test("dots are written with both sources; version stays 1", () => {
  const dots: LiveDot[] = [
    { n: 21, state: "run", label: "#21", src: "pr" },
    { n: null, state: "ok", label: "deploy", src: "ext" },
  ];
  const h = start(() => dots);
  h.l.flush();
  const f = h.read();
  assert.equal(f.v, 1);
  assert.deepEqual(f.dots, dots);
  h.done();
});

test("dots are absent when empty or without a provider, and a throwing provider is best effort", () => {
  for (const p of [undefined, () => [], () => { throw new Error("boom"); }]) {
    const h = start(p as never);
    h.l.flush();
    assert.equal("dots" in h.read(), false);
    h.done();
  }
});

test("dots are capped at 14, bad entries are dropped or normalised", () => {
  const many: LiveDot[] = Array.from({ length: 20 }, (_, i) => ({ n: i, state: "ok", label: `#${i}`, src: "pr" }));
  const h = start(() => [...many, { n: 1, state: "bogus" as never, label: "x", src: "pr" }]);
  h.l.flush();
  const d = h.read().dots as LiveDot[];
  assert.equal(d.length, 14);
  assert.deepEqual(d[13], many[13]);
  h.done();
  const e = start(() => [{ n: 7, state: "fail", label: "x".repeat(60), src: "ext" }, { n: 8, state: "none", label: "p", src: "pr" }]);
  e.l.flush();
  const got = e.read().dots as LiveDot[];
  assert.equal(got[0].n, null, "an external item has no number");
  assert.equal(got[0].label.length, 20);
  assert.equal(got[1].n, 8);
  e.done();
});

test("a change in the provider shows in the next write", () => {
  let dots: LiveDot[] = [];
  const h = start(() => dots);
  h.l.flush();
  assert.equal("dots" in h.read(), false);
  dots = [{ n: 3, state: "fail", label: "#3", src: "pr" }];
  h.l.touch();
  h.l.flush();
  assert.deepEqual(h.read().dots, dots);
  h.done();
});
