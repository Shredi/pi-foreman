// D10: a quiet `foreman:closed` never reaches the parent's `parseInbound` in an idle session, so a foreman_wait on that child resolves from the
// registry: the ChildBlocked pass calls `childClosed` once, on the first pass that sees an entry turn closed (childblocked.ts).
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { WaitRuntime } from "../wait.ts";
import { writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

function rig() {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "d10-cc-")));
  const calls: [string, string][] = [];
  const mk = () => new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: () => undefined, childClosed: (l, p) => void calls.push([l, p]) });
  const reg = (entry: Record<string, unknown> = {}, extra: SessionEntry[] = []) =>
    writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", status: "open", ...entry }, ...extra] });
  return { agentDir, calls, mk, reg, cleanup: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

test("an entry turning closed calls childClosed once with its label and result path", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ result: "/h/result.md" });
  const cb = r.mk();
  cb.tick();
  assert.equal(r.calls.length, 0, "open: nothing");
  r.reg({ status: "closed", result: "/h/result.md" });
  cb.tick();
  cb.tick();
  assert.deepEqual(r.calls, [["job", "/h/result.md"]]);
});

test("an entry whose last.kind is closed (parseInbound read the line) says nothing", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg();
  const cb = r.mk();
  cb.tick();
  r.reg({ status: "closed", last: { kind: "closed", path: "x", at: "2026-11-21T08:00:00Z" } });
  cb.tick();
  cb.tick();
  assert.equal(r.calls.length, 0);
});

test("a child that left the registry, or a remote one, says nothing", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({}, [{ label: "far", child: "fm-far-1", parent: "fm-parent", status: "open", machine: "m1" }]);
  const cb = r.mk();
  cb.tick();
  writeRegistry(r.agentDir, { version: 1, sessions: [{ label: "far", child: "fm-far-1", parent: "fm-parent", status: "closed", machine: "m1" }] });
  cb.tick();
  assert.equal(r.calls.length, 0);
});

test("the seen set survives a reload: the transition is noticed by the new instance, once", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg();
  r.mk().tick();
  r.reg({ status: "closed" });
  const again = r.mk();
  again.tick();
  assert.deepEqual(r.calls, [["job", ""]]);
  r.mk().tick();
  assert.equal(r.calls.length, 1, "not again after another reload");
});

test("a closed entry never seen open is not noticed", (t) => {
  const r = rig();
  t.after(r.cleanup);
  r.reg({ status: "closed" });
  r.mk().tick();
  assert.equal(r.calls.length, 0);
});

// The wiring of index.ts: childClosed -> the wait runtime's childNotice.
test("childNotice resolves a wait on the label and on any, once; no wait, no call; a later wait gets nothing", (t) => {
  const r = rig();
  t.after(r.cleanup);
  const resolved: string[] = [];
  const stub = {
    waits: new Map<string, { id: string; kind: string; label: string }>(),
    resolve: (id: string, outcome: string) => {
      resolved.push(`${id}: ${outcome}`);
      stub.waits.delete(id);
    },
    drop: () => undefined,
    d: { trace: () => undefined },
    governor: { check: () => undefined },
    disposed: false,
  };
  const childNotice = (label: string, kind: string, p: string): boolean => (WaitRuntime.prototype.childNotice as unknown as (this: typeof stub, l: string, k: string, p: string) => boolean).call(stub, label, kind, p);
  const cb = new ChildBlocked({ agentDir: r.agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: () => undefined, childClosed: (l, p) => void childNotice(l, "closed", p) });
  // 1: a wait on the label
  r.reg({ result: "/h/r.md" });
  cb.tick();
  stub.waits.set("w1", { id: "w1", kind: "child", label: "job" });
  r.reg({ status: "closed", result: "/h/r.md" });
  cb.tick();
  assert.deepEqual(resolved, ["w1: child job: closed /h/r.md"]);
  cb.tick();
  assert.equal(resolved.length, 1, "once");
  // 2: a wait on any
  r.reg({ label: "job2", child: "fm-job-2" });
  cb.tick();
  stub.waits.set("w2", { id: "w2", kind: "child", label: "any" });
  r.reg({ label: "job2", child: "fm-job-2", status: "closed" });
  cb.tick();
  assert.equal(resolved.length, 2);
  assert.match(resolved[1], /^w2: child job2: closed/);
  // 3: a wait started after the transition pass gets nothing
  stub.waits.set("w3", { id: "w3", kind: "child", label: "any" });
  cb.tick();
  cb.tick();
  assert.equal(resolved.length, 2);
  // 4: no wait at all: the call finds nothing
  stub.waits.clear();
  assert.equal(childNotice("job", "closed", ""), false);
});
