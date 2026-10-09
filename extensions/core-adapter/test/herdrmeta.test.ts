import { test } from "node:test";
import assert from "node:assert/strict";
import { HerdrMeta, clearArgv, handoffSlug, installHerdrMeta, metaGate, metaText, reportArgv } from "../herdrmeta.ts";
import type { Registry } from "../session.ts";

const reg = (...entries: { parent: string; status: string }[]): Registry => ({ version: 1, sessions: entries.map((e, i) => ({ label: `c${i}`, child: `fm-c${i}-000000`, ...e })) });

test("argv: pane id first, source, display text, token and TTL; clear drops both", () => {
  assert.deepEqual(reportArgv("w1:p2", "proj · 2 children", 2), ["pane", "report-metadata", "w1:p2", "--source", "user:pi-foreman", "--display-agent", "proj · 2 children", "--token", "children=2", "--ttl-ms", "180000"]);
  assert.deepEqual(clearArgv("w1:p2"), ["pane", "report-metadata", "w1:p2", "--source", "user:pi-foreman", "--clear-display-agent", "--clear-token", "children"]);
});

test("child and parent text; the handoff slug drops the stamp and the collision suffix", () => {
  assert.equal(handoffSlug("/x/handoffs/20261009-101010-fix-ui-abc123/", "fm-fix-ui-abc123"), "fix-ui");
  assert.equal(handoffSlug("C:\\a\\handoffs\\20261009-101010-fix-abc123", "fm-fix-ffffff"), "fix-abc123");
  assert.equal(metaText("demo", "proj", 0), "proj › demo");
  assert.equal(metaText("proj", null, 1), "proj · 1 child");
  assert.equal(metaText("proj", null, 3), "proj · 3 children");
  assert.equal(metaText("proj", null, 0), null);
});

test("parent: reports while children are open, clears once when n drops to 0, clears on stop", () => {
  const calls: string[][] = [];
  let r = reg({ parent: "me", status: "open" }, { parent: "me", status: "closed" }, { parent: "other", status: "open" });
  const m = new HerdrMeta({ env: { HERDR_PANE_ID: "w1:p1" }, cwd: "/nowhere/proj", run: (a) => calls.push(a), registry: () => r, ownId: () => "me" });
  m.tick();
  assert.equal(calls[0][calls[0].indexOf("--display-agent") + 1], "proj · 1 child");
  assert.ok(calls[0].includes("children=1"));
  r = reg();
  m.tick();
  m.tick();
  assert.deepEqual(calls.slice(1), [clearArgv("w1:p1")]);
  m.stop();
  assert.equal(calls.length, 2, "nothing reported, nothing to clear");
});

test("child: re-reports '<parent> › <child>' and clears on stop", () => {
  const calls: string[][] = [];
  const env = { HERDR_PANE_ID: "w1:p9", PI_FOREMAN_HANDOFF_DIR: "/h/20261009-101010-demo", PI_FOREMAN_PARENT_INTERCOM: "top", PI_FOREMAN_PARENT_LABEL: "proj", PI_INTERCOM_STABLE_ID: "fm-demo-abc123" };
  const m = new HerdrMeta({ env, cwd: "/nowhere", run: (a) => calls.push(a), registry: () => reg(), ownId: () => "fm-demo-abc123" });
  m.tick();
  m.tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][calls[1].indexOf("--display-agent") + 1], "proj › demo");
  m.stop();
  assert.deepEqual(calls[2], clearArgv("w1:p9"));
});

test("gating: HERDR_ENV=1, a pane id, tui mode and herdr.groupTag", async () => {
  const on = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
  assert.equal(metaGate(on, "tui", true), true);
  assert.equal(metaGate(on, "rpc", true), false);
  assert.equal(metaGate(on, "tui", false), false);
  assert.equal(metaGate({ HERDR_PANE_ID: "w1:p1" }, "tui", true), false);
  assert.equal(metaGate({ HERDR_ENV: "1" }, "tui", true), false);
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>();
  const calls: string[][] = [];
  const env = { ...on, PI_FOREMAN_HANDOFF_DIR: "/h/20261009-101010-demo", PI_FOREMAN_PARENT_INTERCOM: "top", PI_FOREMAN_PARENT_LABEL: "proj", PI_CODING_AGENT_DIR: "/nowhere/agent" };
  const meta = installHerdrMeta({ on: (ev: string, h: never) => void handlers.set(ev, h) } as never, { env, run: (a) => calls.push(a) });
  const ctx = (mode: string) => ({ mode, cwd: "/nowhere", sessionManager: { getSessionId: () => "s1" } }) as never;
  meta.start(ctx("rpc"), true);
  meta.start(ctx("tui"), false);
  assert.equal(calls.length, 0);
  meta.start(ctx("tui"), true);
  assert.equal(calls.length, 1);
  await handlers.get("session_shutdown")!({}, ctx("tui"));
  assert.deepEqual(calls[1], clearArgv("w1:p1"));
});
