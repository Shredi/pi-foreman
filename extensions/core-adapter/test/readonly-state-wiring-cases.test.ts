// Run-end state hint, adapter wiring cases of plan readonly-target E (in-process, a fake git runner and hand-made `.git` dirs): which launches are
// pictured, which roots, the deadlines and their reasons, reload, child sessions, and that nothing else (run-end record, ladder) moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { runEndOf } from "../launchwait.ts";
import type { GitRunner } from "../readonlystate.ts";

const TYPE = "pi-foreman-readonly-state";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await sleep(25);
  return cond();
};

interface Probe {
  /** The directory of every git run, in order. */
  calls: string[];
  mode: "ok" | "hang";
  oid: string;
  /** Git runs killed by the picture deadline. */
  killed: number;
  active: Map<string, number>;
  /** The most directories with a git run in flight at once. */
  peakDirs: number;
}

/** Canned git output (no spawn): an empty index and a status that only names HEAD and the branch; `hang` runs end only when killed. */
const fakeGit = (p: Probe): GitRunner => (cwd, args, signal) => {
  p.calls.push(cwd);
  if (p.mode === "hang") {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        p.killed++;
        reject(new Error("killed"));
      });
    });
  }
  p.active.set(cwd, (p.active.get(cwd) ?? 0) + 1);
  p.peakDirs = Math.max(p.peakDirs, [...p.active.values()].filter((n) => n > 0).length);
  return new Promise((resolve) => {
    setTimeout(() => {
      p.active.set(cwd, (p.active.get(cwd) ?? 1) - 1);
      resolve(args.includes("ls-files") ? "" : `# branch.oid ${p.oid}\0# branch.head main\0`);
    }, 40);
  });
};

const OID_A = "a".repeat(40);
const OID_B = "b".repeat(40);

async function setup(t: { after(fn: () => void | Promise<void>): void }, o: { child?: boolean; deadlineMs?: number; outside?: boolean; workflow?: boolean } = {}) {
  const base = fs.realpathSync(mkTestTmp("pf-ro-wc-"));
  t.after(() => rmTestTmp(base));
  const repo = (name: string): string => {
    const d = path.join(base, name);
    fs.mkdirSync(path.join(d, ".git"), { recursive: true });
    fs.writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(d, ".git", "config"), "[core]\n");
    return d;
  };
  const a = repo("a");
  const b = repo("b");
  fs.mkdirSync(path.join(b, "sub"));
  const plain = path.join(base, "plain");
  fs.mkdirSync(plain);
  const probe: Probe = { calls: [], mode: "ok", oid: OID_A, killed: 0, active: new Map(), peakDirs: 0 };
  const sent: Array<{ customType?: string; content?: string }> = [];
  const ro = reviewAllowOpts();
  const rig = await r11Rig(t, {}, {
    ctx: { ...ro.ctx, cwd: o.outside ? plain : a },
    config: { ...ro.config, ...(o.workflow ? { safety: { subagents: { allowWorkflow: true } } } : {}) },
    ...(o.child ? { child: true } : {}),
    deps: { readonlyGit: fakeGit(probe), ...(o.deadlineMs ? { readonlyDeadlineMs: o.deadlineMs } : {}) },
    piExtra: { sendMessage: (m: { customType?: string; content?: string }) => void sent.push(m) },
  });
  const notices = (): Array<{ customType?: string; content?: string }> => sent.filter((m) => m.customType === TYPE);
  const traces = (): Record<string, unknown>[] => rig.events("readonly_state_diff");
  /** A launch that went through (asserted) and was started as run `runId`. */
  const run = async (input: Record<string, unknown>, runId: string) => {
    const l = await rig.launch(input);
    assert.equal(l.res, undefined, `launch refused: ${JSON.stringify(l.res)}`);
    await rig.started(l.id, input, runId);
    return l;
  };
  return { rig, a, b, plain, probe, sent, notices, traces, run, base };
}
type Env = Awaited<ReturnType<typeof setup>>;
/** A fresh input each time: the adapter adds launch bindings to the input object it sees, so a reused object grows into a ledger-guarded delegation. */
const rev = (): Record<string, unknown> => ({ agent: "reviewer", task: "look" });
const quiet = async (e: Env): Promise<void> => {
  await sleep(500);
  assert.equal(e.notices().length, 0, JSON.stringify(e.notices()));
};

test("the start picture is taken at the tool_call, before the launch result; a reviewer and an explorer run are compared", async (t) => {
  const e = await setup(t);
  const input = rev();
  const l = await e.rig.launch(input);
  assert.equal(l.res, undefined);
  assert.ok(e.probe.calls.length > 0 && e.probe.calls.every((c) => c === e.a), "pictured before any tool_result");
  await e.rig.started(l.id, input, "run-1");
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-1", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
  assert.match(e.notices()[0].content ?? "", /reviewer run run-1 ended and .*HEAD aaaaaaaa -> bbbbbbbb.*Nothing was blocked or undone/);
  assert.equal(e.traces().length, 1);
  assert.equal(e.traces()[0].outcome, "changed");
  assert.equal(typeof e.traces()[0].roots, "string", "the pictured roots ride on the trace (path-scrubbed like every trace string)");
  assert.ok(String(e.traces()[0].roots).length > 0);
  e.probe.oid = OID_A;
  const ex = { agent: "explorer", task: "look" };
  await e.run(ex, "run-2");
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-2", agent: "explorer", success: true });
  assert.ok(await until(() => e.notices().length === 2));
  assert.match(e.notices()[1].content ?? "", /explorer run run-2/);
});

test("a tasks launch and a chain launch of read-only roles are compared; an unchanged one is a trace record only", async (t) => {
  const e = await setup(t);
  await e.run({ tasks: [{ agent: "reviewer", task: "x" }, { agent: "explorer", task: "y" }] }, "run-t");
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-t", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
  assert.equal(e.traces()[0].outcome, "changed");
  e.probe.oid = OID_A;
  const before = e.probe.calls.length;
  await e.run({ chain: [{ agent: "reviewer", task: "x" }] }, "run-c");
  assert.ok(e.probe.calls.length > before, "the chain launch was pictured");
  e.rig.end({ runId: "run-c", agent: "reviewer", success: true });
  assert.ok(await until(() => e.traces().length === 2));
  assert.equal(e.traces()[1].outcome, "unchanged");
  assert.equal(e.notices().length, 1);
});

test("a failed and a stopped run end are compared too", async (t) => {
  const e = await setup(t);
  for (const [i, data] of [{ success: false }, { stopped: true }].entries()) {
    e.probe.oid = OID_A;
    await e.run(rev(), `run-f${i}`);
    e.probe.oid = OID_B;
    e.rig.end({ runId: `run-f${i}`, agent: "reviewer", ...data });
    assert.ok(await until(() => e.notices().length === i + 1), JSON.stringify(data));
  }
});

test("builder launches, mixed builder+reviewer tasks (either order) and a builder resume send no notice and no trace", async (t) => {
  const e = await setup(t);
  const inputs: Array<[string, Record<string, unknown>]> = [
    ["rb", { agent: "builder", task: "build" }],
    ["rm1", { tasks: [{ agent: "builder", task: "b" }, { agent: "reviewer", task: "r" }] }],
    ["rm2", { tasks: [{ agent: "reviewer", task: "r" }, { agent: "builder", task: "b" }] }],
  ];
  for (const [id, input] of inputs) await e.run(input, id);
  await e.run({ action: "resume", id: "rb", message: "more" }, "rb2");
  assert.equal(e.probe.calls.length, 0, "no git run for any of them");
  e.probe.oid = OID_B;
  for (const id of ["rb", "rm1", "rm2", "rb2"]) e.rig.end({ runId: id, agent: id.startsWith("rm") ? "reviewer" : "builder", success: true });
  await quiet(e);
  assert.equal(e.traces().length, 0);
});

test("a workflow launch and a resume of an unknown target are not pictured", async (t) => {
  const e = await setup(t, { workflow: true });
  await e.run({ workflow: "w.js", task: "x" }, "run-w");
  // the adapter refuses a resume of a run this session did not launch before the hint sees it; either way nothing is pictured
  const unknown = await e.rig.launch({ action: "resume", id: "nobody", message: "x" });
  assert.ok(unknown.res?.block);
  assert.equal(e.probe.calls.length, 0);
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-w", agent: "reviewer", success: true });
  await quiet(e);
  assert.equal(e.traces().length, 0);
});

test("a refused launch takes no start picture; an errored launch result leaves no start entry behind", async (t) => {
  const e = await setup(t);
  const bad = await e.rig.launch({ agent: "no-such-role", task: "x" });
  assert.ok(bad.res?.block, "the launch is refused");
  assert.equal(e.probe.calls.length, 0);
  const input = rev();
  const l = await e.rig.launch(input);
  const picked = e.probe.calls.length;
  assert.ok(picked > 0);
  await e.rig.errored(l.id, input);
  e.rig.end({ runId: "ghost", agent: "reviewer", success: true });
  assert.ok(await until(() => e.traces().length === 1));
  assert.equal(e.traces()[0].reason, "no start entry");
  assert.equal(e.probe.calls.length, picked, "no end picture for a run that never started");
});

test("a child session is not pictured", async (t) => {
  const e = await setup(t, { child: true });
  await e.rig.launch(rev());
  assert.equal(e.probe.calls.length, 0);
  e.rig.end({ runId: "run-k", agent: "reviewer", success: true });
  await quiet(e);
  assert.equal(e.traces().length, 0);
});

test("launch cwds resolve like pi-subagents: a top-level cwd against the session cwd, a step cwd against the launch cwd; only that root is pictured", async (t) => {
  const e = await setup(t);
  await e.run({ cwd: "../b", tasks: [{ agent: "reviewer", task: "x", cwd: "sub" }, { agent: "explorer", task: "y" }] }, "run-d");
  assert.ok(e.probe.calls.length > 0);
  assert.ok(e.probe.calls.every((c) => c === e.b), `only b: ${[...new Set(e.probe.calls)].join(",")}`);
});

test("two roots are pictured in parallel", async (t) => {
  const e = await setup(t);
  await e.run({ tasks: [{ agent: "reviewer", task: "x" }, { agent: "reviewer", task: "y", cwd: "../b" }] }, "run-p");
  assert.ok(e.probe.calls.includes(e.a) && e.probe.calls.includes(e.b));
  assert.ok(e.probe.peakDirs >= 2, `peak ${e.probe.peakDirs}`);
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-p", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
  assert.equal(e.notices().length, 1, "one notice for the run");
  assert.ok((e.notices()[0].content ?? "").includes(e.a) && (e.notices()[0].content ?? "").includes(e.b));
});

test("a resume reuses the roots of its launch, not the session cwd", async (t) => {
  const e = await setup(t);
  await e.run({ cwd: "../b", agent: "reviewer", task: "x" }, "run-r1");
  e.rig.end({ runId: "run-r1", agent: "reviewer", success: true });
  assert.ok(await until(() => e.traces().length === 1));
  e.probe.calls.length = 0;
  await e.run({ action: "resume", id: "run-r1", message: "again" }, "run-r2");
  assert.ok(e.probe.calls.length > 0);
  assert.ok(e.probe.calls.every((c) => c === e.b), [...new Set(e.probe.calls)].join(","));
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-r2", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
});

test("a launch outside git sends nothing at run end", async (t) => {
  const e = await setup(t, { outside: true });
  await e.run(rev(), "run-o");
  assert.equal(e.probe.calls.length, 0);
  e.rig.end({ runId: "run-o", agent: "reviewer", success: true });
  await quiet(e);
  assert.equal(e.traces().length, 0);
});

test("a reload loses the start entry: no notice, a trace with reason `no start entry`", async (t) => {
  const e = await setup(t);
  await e.run(rev(), "run-l");
  await e.rig.restart();
  e.probe.oid = OID_B;
  e.rig.end({ runId: "run-l", agent: "reviewer", success: true });
  assert.ok(await until(() => e.traces().length === 1));
  await quiet(e);
  assert.deepEqual([e.traces()[0].outcome, e.traces()[0].reason], ["not_compared", "no start entry"]);
});

test("a workflow child's run end (no start entry) sends nothing, not even a trace", async (t) => {
  const e = await setup(t);
  e.rig.end({ runId: "wf-child", agent: "reviewer", success: true, awaitedByWorkflow: true });
  e.rig.end({ runId: "wf-child2", agent: "explorer", success: true, parentWorkflowRunId: "wf" });
  await quiet(e);
  assert.equal(e.traces().length, 0);
});

test("a start picture past the deadline: its git runs are killed, the run end says `not compared` with reason `start unreadable` and runs no git", async (t) => {
  const e = await setup(t, { deadlineMs: 150 });
  e.probe.mode = "hang";
  const input = rev();
  const l = await e.rig.launch(input);
  assert.equal(l.res, undefined);
  assert.ok(e.probe.killed > 0, "the hung git runs were killed");
  await e.rig.started(l.id, input, "run-s");
  e.probe.mode = "ok";
  const ran = e.probe.calls.length;
  e.rig.end({ runId: "run-s", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
  assert.match(e.notices()[0].content ?? "", /was not compared: start unreadable/);
  assert.deepEqual([e.traces()[0].outcome, e.traces()[0].reason], ["not_compared", "start unreadable"]);
  assert.equal(e.probe.calls.length, ran, "no end picture without a start");
});

test("an end picture past the deadline: its git runs are killed, the notice says `not compared`, reason `end unreadable`", async (t) => {
  const e = await setup(t, { deadlineMs: 150 });
  await e.run(rev(), "run-e");
  e.probe.mode = "hang";
  e.rig.end({ runId: "run-e", agent: "reviewer", success: true });
  assert.ok(await until(() => e.notices().length === 1));
  assert.ok(e.probe.killed > 0);
  assert.match(e.notices()[0].content ?? "", /was not compared: end unreadable/);
  assert.deepEqual([e.traces()[0].outcome, e.traces()[0].reason], ["not_compared", "end unreadable"]);
});

test("the run-end record and the ladder do not move: runEndOf is unchanged and the event data is not touched", async (t) => {
  const data = Object.freeze({ runId: "run-x", agent: "reviewer", success: true, asyncDir: "/d", results: Object.freeze([{ agent: "reviewer", summary: "ok" }]) });
  assert.deepEqual(runEndOf(data), { runId: "run-x", status: "completed", role: "reviewer", summary: "ok", resultPath: "/d" });
  const e = await setup(t);
  await e.run(rev(), "run-x");
  e.probe.oid = OID_B;
  e.rig.end(data as unknown as Record<string, unknown>);
  assert.ok(await until(() => e.notices().length === 1));
  const others = e.rig.trace().filter((r) => r.event !== "readonly_state_diff" && typeof r.event === "string" && /ladder|climb|stop|marker|retry/i.test(r.event));
  assert.deepEqual(others, []);
});
