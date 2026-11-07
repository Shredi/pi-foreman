import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { handoffPlanPath, planVersionHash, readHandoffPlan } from "../checkpoint.ts";
import { LiveState, liveDir } from "../livestate.ts";
import { createEngine, fenceSha } from "../mermaid.ts";
import type { Engine } from "../mermaid.ts";
import { r11Rig } from "./_r11rig.ts";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, parseNoteJson, parsePlanJson, Show, titleOf } from "../show.ts";
import type { NoteJson } from "../show.ts";
import type { PlanJson, ShowInit, ShowIo } from "../show.ts";

const A = "# Plan A\n\n## Goal\nShip it.\n";
const B = "# Plan A\n\n## Goal\nShip it, twice.\n";
const C = "# Plan A\n\n## Goal\nShip it, thrice.\n";

function env(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync.native(mkTestTmp("pf-show-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  const scratch = path.join(ws, ".workflow/scratch");
  const handoff = path.join(root, "handoffs", "20260101-120000-job");
  for (const d of [path.join(ws, ".git"), scratch, handoff, path.join(root, "agent")]) fs.mkdirSync(d, { recursive: true });
  const plan = (topic = "widget") => path.join(scratch, `plan-${topic}.md`);
  const start = (over: Partial<ShowInit> = {}, id = "sess-1") => {
    const traces: Record<string, unknown>[] = [];
    const show = Show.start({ agentDir: path.join(root, "agent"), sessionId: id, cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: null, trace: (r) => void traces.push(r), ...over });
    return { show: show!, traces };
  };
  return { root, ws, scratch, handoff, plan, start };
}

const json = (show: Show, file = "plan.json") => JSON.parse(fs.readFileSync(path.join(show.dir, file), "utf8")) as PlanJson;
const text = (show: Show, file: string) => fs.readFileSync(path.join(show.dir, file), "utf8");
const names = (show: Show) => fs.readdirSync(show.dir).sort();

test("show: a plan write publishes plan.json with the version hash, title and live field", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  assert.deepEqual(show.field(), { dir: path.join(e.scratch, "show", "sess-1") });
  assert.equal(show.planWritten(e.plan()), true);
  await show.idle();
  const j = json(show);
  assert.equal(j.path, e.plan());
  assert.equal(j.title, "Plan A");
  assert.equal(j.v, 1);
  assert.equal(j.hash, planVersionHash(Buffer.from(A)));
  assert.deepEqual([j.ruledPath, j.ruledHash, j.prevHash, j.fences], [null, null, null, []]);
  assert.deepEqual(Object.keys(j), ["path", "title", "v", "at", "hash", "ruledPath", "ruledHash", "prevHash", "fences"]);
  assert.deepEqual(names(show), ["plan.json"]);
  assert.deepEqual(show.field(), { dir: show.dir, plan: 1 });
});

test("show: a plan write outside the scratch plan names is not tracked", async (t) => {
  const e = env(t);
  fs.writeFileSync(path.join(e.ws, "notes.md"), A);
  const { show } = e.start();
  assert.equal(show.planWritten(path.join(e.ws, "notes.md")), false);
  assert.equal(show.planWritten(42), false);
  await show.idle();
  assert.equal(fs.existsSync(show.dir), false);
});

test("show: v rises on a body change, an appended ruling is no new version", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  show.planWritten(e.plan());
  await show.idle();
  fs.writeFileSync(e.plan(), A + "\n## Ruling\nAPPROVED\n");
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(json(show).v, 1);
  fs.writeFileSync(e.plan(), B);
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(json(show).v, 2);
  assert.equal(show.field().plan, 2);
});

test("show: v is read back from plan.json at session start", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const first = e.start().show;
  first.planWritten(e.plan());
  await first.idle();
  fs.writeFileSync(e.plan(), B);
  first.planWritten(e.plan());
  await first.idle();
  const again = e.start().show;
  assert.deepEqual(again.field(), { dir: first.dir, plan: 2 });
  fs.writeFileSync(e.plan(), C);
  again.planWritten(e.plan());
  await again.idle();
  assert.equal(json(again).v, 3);
});

test("show: foreman_checkpoint rolls the snapshots (first roll has no prev, the second moves ruled to prev)", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  show.checkpointed(e.plan());
  await show.idle();
  let j = json(show);
  assert.equal(text(show, "plan.ruled.md"), A);
  assert.deepEqual([j.ruledPath, j.ruledHash, j.prevHash], [e.plan(), planVersionHash(Buffer.from(A)), null]);
  assert.deepEqual(names(show), ["plan.json", "plan.ruled.md"]);
  fs.writeFileSync(e.plan(), B);
  show.planWritten(e.plan()); // a plain save never rolls
  await show.idle();
  assert.equal(text(show, "plan.ruled.md"), A);
  assert.equal(json(show).ruledHash, planVersionHash(Buffer.from(A)));
  assert.equal(json(show).hash, planVersionHash(Buffer.from(B)));
  show.checkpointed(e.plan());
  await show.idle();
  j = json(show);
  assert.equal(text(show, "plan.ruled.md"), B);
  assert.equal(text(show, "plan.prev.md"), A);
  assert.deepEqual([j.ruledHash, j.prevHash, j.hash, j.v], [planVersionHash(Buffer.from(B)), planVersionHash(Buffer.from(A)), planVersionHash(Buffer.from(B)), 2]);
  assert.deepEqual(names(show), ["plan.json", "plan.prev.md", "plan.ruled.md"]);
});

test("show: a roll at the ruled version is a no-op", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  show.checkpointed(e.plan());
  await show.idle();
  const before = fs.readFileSync(path.join(show.dir, "plan.json"), "utf8");
  show.checkpointed(e.plan());
  await show.idle();
  assert.equal(fs.readFileSync(path.join(show.dir, "plan.json"), "utf8"), before);
  assert.equal(fs.existsSync(path.join(show.dir, "plan.prev.md")), false);
});

test("show: a [plan-review] launch rolls the plan its task names, any other path leaves tracking alone", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan("one"), A);
  fs.writeFileSync(e.plan("two"), B);
  fs.writeFileSync(path.join(e.ws, "plan-elsewhere.md"), C);
  const { show } = e.start();
  show.planWritten(e.plan("one"));
  await show.idle();
  show.planReviewLaunched(`[plan-review] review ${path.join(e.ws, "plan-elsewhere.md")} and plan-missing.md and the code`);
  show.planReviewLaunched("review something else");
  await show.idle();
  assert.equal(fs.existsSync(path.join(show.dir, "plan.ruled.md")), false);
  assert.equal(json(show).path, e.plan("one"));
  show.planReviewLaunched("[plan-review] review .workflow/scratch/plan-two.md");
  await show.idle();
  assert.equal(json(show).path, e.plan("two")); // switched to the named plan, then rolled
  assert.equal(json(show).ruledPath, e.plan("two"));
  assert.equal(text(show, "plan.ruled.md"), B);
  show.planReviewLaunched("[plan-review] review plan-one.md");
  await show.idle();
  assert.equal(json(show).path, e.plan("one"));
  assert.equal(text(show, "plan.ruled.md"), A);
  assert.equal(fs.existsSync(path.join(show.dir, "plan.prev.md")), false); // the path change deleted both snapshots first
});

test("show: a child's Plan from notice and the foreman:plan alias roll the handoff plan, other messages do not", async (t) => {
  const e = env(t);
  const hp = path.join(e.handoff, "plan.md");
  fs.writeFileSync(hp, A);
  const { show } = e.start({ handoffDir: e.handoff });
  assert.equal(show.planWritten(hp), true);
  await show.idle();
  assert.equal(json(show).path, hp);
  show.planSent(`Plan: ${hp}`);
  show.planSent(42);
  await show.idle();
  assert.equal(fs.existsSync(path.join(show.dir, "plan.ruled.md")), false);
  show.planSent(`Plan from job: ${hp}`);
  await show.idle();
  assert.equal(text(show, "plan.ruled.md"), A);
  fs.writeFileSync(hp, B);
  show.planSent(`foreman:plan ${hp}`);
  await show.idle();
  assert.equal(text(show, "plan.ruled.md"), B);
  assert.equal(text(show, "plan.prev.md"), A);
});

test("show: a [plan-review] task naming the handoff plan as written or as its realpath rolls it", async (t) => {
  const e = env(t);
  const link = path.join(e.root, "link-to-handoff");
  fs.symlinkSync(e.handoff, link);
  const hp = path.join(e.handoff, "plan.md");
  fs.writeFileSync(hp, A);
  const { show } = e.start({ handoffDir: link });
  show.planWritten(hp);
  await show.idle();
  show.planReviewLaunched(`[plan-review] read ${path.join(link, "plan.md")}`);
  await show.idle();
  assert.equal(text(show, "plan.ruled.md"), A);
  fs.writeFileSync(hp, B);
  show.planReviewLaunched(`[plan-review] read ${hp}`);
  await show.idle();
  assert.equal(text(show, "plan.ruled.md"), B);
});

test("show: a path change deletes both snapshots and clears ruledPath", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan("one"), A);
  fs.writeFileSync(e.plan("two"), B);
  const { show } = e.start();
  show.checkpointed(e.plan("one"));
  await show.idle();
  fs.writeFileSync(e.plan("one"), C);
  show.checkpointed(e.plan("one"));
  await show.idle();
  assert.deepEqual(names(show), ["plan.json", "plan.prev.md", "plan.ruled.md"]);
  show.planWritten(e.plan("two"));
  await show.idle();
  const j = json(show);
  assert.deepEqual(names(show), ["plan.json"]);
  assert.deepEqual([j.path, j.ruledPath, j.ruledHash, j.prevHash, j.v], [e.plan("two"), null, null, null, 3]);
});

test("show: two sessions in one checkout publish into separate show dirs", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan("one"), A);
  fs.writeFileSync(e.plan("two"), B);
  const a = e.start({}, "sess-a").show;
  const b = e.start({}, "sess-b").show;
  a.checkpointed(e.plan("one"));
  b.checkpointed(e.plan("two"));
  await Promise.all([a.idle(), b.idle()]);
  assert.notEqual(a.dir, b.dir);
  assert.equal(text(a, "plan.ruled.md"), A);
  assert.equal(text(b, "plan.ruled.md"), B);
  assert.equal(json(a).path, e.plan("one"));
  assert.equal(json(b).path, e.plan("two"));
});

test("show: the scratch root disabled (or an unsafe session id) means no show dir and no field", (t) => {
  const e = env(t);
  assert.equal(Show.start({ agentDir: e.root, sessionId: "s", cwd: e.ws, home: e.root, platform: process.platform, scratchDir: "../outside", handoffDir: null }), null);
  assert.equal(Show.start({ agentDir: e.root, sessionId: "../s", cwd: e.ws, home: e.root, platform: process.platform, scratchDir: ".workflow/scratch", handoffDir: null }), null);
  assert.equal(fs.existsSync(path.join(e.ws, "..", "outside")), false);
});

// ------------------------------------------------------------ roll order, failure injected at each step
type Call = { op: "writeFile" | "rename"; from: string; to?: string };
const base = (f: string) => path.basename(f);

/** Fail the nth call whose predicate matches (default: every match from the first), once or always. */
function failing(match: (c: Call) => boolean, code: string, state: { on: boolean }): Partial<ShowIo> {
  const fail = (c: Call) => {
    if (state.on && match(c)) throw Object.assign(new Error(code), { code });
  };
  return {
    writeFile: async (file, data) => {
      fail({ op: "writeFile", from: file });
      await fs.promises.writeFile(file, data, { flag: "wx" });
    },
    rename: async (from, to) => {
      fail({ op: "rename", from, to });
      await fs.promises.rename(from, to);
    },
  };
}

const steps: [string, (c: Call) => boolean][] = [
  ["step 1: the temp copy of the new ruled plan", (c) => c.op === "writeFile" && base(c.from).startsWith("plan.ruled.md.")],
  ["step 2: ruled -> prev", (c) => c.op === "rename" && base(c.from) === "plan.ruled.md" && base(c.to!) === "plan.prev.md"],
  ["step 3: temp -> ruled", (c) => c.op === "rename" && base(c.from).startsWith("plan.ruled.md.") && base(c.to!) === "plan.ruled.md"],
  ["step 4: plan.json", (c) => c.op === "rename" && base(c.to!) === "plan.json"],
];

for (const [name, match] of steps) {
  test(`show: roll failure at ${name} leaves plan.json untouched, and the queue goes on`, async (t) => {
    const e = env(t);
    const state = { on: false };
    fs.writeFileSync(e.plan(), A);
    const { show, traces } = e.start({ io: failing(match, "EIO", state) });
    show.checkpointed(e.plan());
    await show.idle();
    const before = fs.readFileSync(path.join(show.dir, "plan.json"), "utf8");
    fs.writeFileSync(e.plan(), B);
    state.on = true;
    show.checkpointed(e.plan());
    await show.idle();
    assert.equal(fs.readFileSync(path.join(show.dir, "plan.json"), "utf8"), before, "plan.json bytes");
    assert.deepEqual(traces.map((r) => [r.event, r.kind, r.errorKind]), [["show_error", "checkpoint", "EIO"]]);
    assert.deepEqual(names(show).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
    if (name.startsWith("step 3")) {
      assert.equal(fs.existsSync(path.join(show.dir, "plan.ruled.md")), false, "no comparison snapshot, so no marks");
      assert.equal(text(show, "plan.prev.md"), A);
    }
    // the chain is not stalled: the next roll repairs (step 2 skips on ENOENT after a step-3 failure)
    state.on = false;
    fs.writeFileSync(e.plan(), C);
    show.checkpointed(e.plan());
    await show.idle();
    const j = json(show);
    assert.equal(text(show, "plan.ruled.md"), C);
    assert.equal(j.ruledHash, planVersionHash(Buffer.from(C)));
    // prev holds what ruled held (after a failed step 4 that is B, which plan.json never named)
    const was = name.startsWith("step 4") ? B : A;
    assert.equal(j.prevHash, planVersionHash(Buffer.from(was)));
    assert.equal(text(show, "plan.prev.md"), was);
  });
}

test("show: an EPERM on rename is retried once after a delay, a second EPERM keeps the old file", async (t) => {
  const e = env(t);
  const seen: string[] = [];
  let planJsonFails = 1;
  const io: Partial<ShowIo> = {
    rename: async (from, to) => {
      seen.push(base(to));
      if (base(to) === "plan.json" && planJsonFails-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" });
      await fs.promises.rename(from, to);
    },
  };
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start({ io });
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(seen, ["plan.json", "plan.json"]);
  assert.equal(json(show).v, 1);
  assert.deepEqual(traces, []);
  const before = fs.readFileSync(path.join(show.dir, "plan.json"), "utf8");
  fs.writeFileSync(e.plan(), B);
  planJsonFails = 2;
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(fs.readFileSync(path.join(show.dir, "plan.json"), "utf8"), before);
  assert.equal(traces[0]?.errorKind, "EPERM");
  assert.deepEqual(names(show), ["plan.json"]);
});

test("show: plan.json is written atomically (temp then rename, no temp left)", async (t) => {
  const e = env(t);
  const ops: string[] = [];
  const io: Partial<ShowIo> = {
    writeFile: async (file, data) => {
      ops.push(`write ${base(file).replace(/\.\d+\.\d+\.tmp$/, ".tmp")}`);
      await fs.promises.writeFile(file, data, { flag: "wx" });
    },
    rename: async (from, to) => {
      ops.push(`rename ${base(from).replace(/\.\d+\.\d+\.tmp$/, ".tmp")} ${base(to)}`);
      await fs.promises.rename(from, to);
    },
  };
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start({ io });
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(ops, ["write plan.json.tmp", "rename plan.json.tmp plan.json"]);
  assert.deepEqual(names(show), ["plan.json"]);
});

// ------------------------------------------------------------ guarded handoff reads
test("show: a symlinked handoff plan is refused, path is cleared and the live plan version goes", async (t) => {
  const e = env(t);
  const hp = path.join(e.handoff, "plan.md");
  fs.writeFileSync(hp, A);
  const { show } = e.start({ handoffDir: e.handoff });
  show.planWritten(hp);
  await show.idle();
  assert.equal(show.field().plan, 1);
  const foreign = path.join(e.root, "foreign.md");
  fs.writeFileSync(foreign, "# not mine\n");
  fs.rmSync(hp);
  fs.symlinkSync(foreign, hp);
  show.planWritten(hp);
  await show.idle();
  const j = json(show);
  assert.equal(j.path, null);
  assert.equal(j.hash, planVersionHash(Buffer.from(A))); // the foreign bytes were never hashed
  assert.deepEqual(show.field(), { dir: show.dir });
  assert.equal(fs.readdirSync(show.dir).some((n) => fs.readFileSync(path.join(show.dir, n), "utf8").includes("not mine")), false);
  show.checkpointed(hp); // a ruling point does not copy it either
  await show.idle();
  assert.equal(fs.existsSync(path.join(show.dir, "plan.ruled.md")), false);
});

test("show: a hard-linked handoff plan is refused and the path is cleared", async (t) => {
  const e = env(t);
  const hp = path.join(e.handoff, "plan.md");
  fs.writeFileSync(hp, A);
  const { show } = e.start({ handoffDir: e.handoff });
  show.planWritten(hp);
  await show.idle();
  fs.linkSync(hp, path.join(e.root, "other-name.md"));
  show.planSent(`Plan from job: ${hp}`);
  await show.idle();
  assert.equal(json(show).path, null);
  assert.equal(fs.existsSync(path.join(show.dir, "plan.ruled.md")), false);
  assert.equal(show.field().plan, undefined);
});

test("show: a vanished plan clears the path; the same plan back restores it without a new version", async (t) => {
  const e = env(t);
  fs.writeFileSync(e.plan(), A);
  const { show } = e.start();
  show.planWritten(e.plan());
  await show.idle();
  fs.rmSync(e.plan());
  show.planWritten(e.plan());
  await show.idle();
  assert.equal(json(show).path, null);
  fs.writeFileSync(e.plan(), A);
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual([json(show).path, json(show).v], [e.plan(), 1]);
});

test("readHandoffPlan: regular file ok; symlink, hard link, oversize, missing and relative dir refused", (t) => {
  const e = env(t);
  const hp = path.join(e.handoff, "plan.md");
  assert.match(("error" in readHandoffPlan(e.handoff, process.platform) ? (readHandoffPlan(e.handoff, process.platform) as { error: string }).error : ""), /does not exist/);
  fs.writeFileSync(hp, A);
  const ok = readHandoffPlan(e.handoff, process.platform);
  assert.ok("plan" in ok);
  assert.equal(ok.plan.hash, planVersionHash(Buffer.from(A)));
  assert.equal(ok.plan.path, hp);
  assert.ok("error" in readHandoffPlan("relative/dir", process.platform));
  fs.writeFileSync(hp, "x".repeat(256 * 1024 + 1));
  assert.match((readHandoffPlan(e.handoff, process.platform) as { error: string }).error, /larger than 256 KiB/);
  fs.rmSync(hp);
  fs.symlinkSync(path.join(e.root, "x.md"), hp);
  assert.ok("error" in readHandoffPlan(e.handoff, process.platform));
  fs.rmSync(hp);
  fs.writeFileSync(hp, A);
  fs.linkSync(hp, path.join(e.root, "twin.md"));
  assert.match((readHandoffPlan(e.handoff, process.platform) as { error: string }).error, /hard link/);
});

test("readHandoffPlan: a symlinked handoff dir resolves to its real dir, a swapped plan.md inside it does not", (t) => {
  const e = env(t);
  const link = path.join(e.root, "via-link");
  fs.symlinkSync(e.handoff, link);
  fs.writeFileSync(path.join(e.handoff, "plan.md"), A);
  const r = readHandoffPlan(link, process.platform);
  assert.ok("plan" in r);
  assert.equal(r.plan.path, path.join(e.handoff, "plan.md"));
});

test("handoffPlanPath: only <handoff dir>/plan.md matches (as written or by realpath)", (t) => {
  const e = env(t);
  const link = path.join(e.root, "via-link");
  fs.symlinkSync(e.handoff, link);
  const o = { cwd: e.ws, home: e.root, platform: process.platform };
  const real = path.join(e.handoff, "plan.md");
  assert.equal(handoffPlanPath(real, e.handoff, o), real);
  assert.equal(handoffPlanPath(path.join(link, "plan.md"), e.handoff, o), real);
  assert.equal(handoffPlanPath(real, link, o), real);
  assert.equal(handoffPlanPath(path.join(e.handoff, "result.md"), e.handoff, o), null);
  assert.equal(handoffPlanPath(path.join(e.handoff, "sub", "plan.md"), e.handoff, o), null);
  assert.equal(handoffPlanPath(real, null, o), null);
  assert.equal(handoffPlanPath(real, "relative", o), null);
});

// ------------------------------------------------------------ pruning, live field, helpers
test("show: show dirs whose live file is gone are pruned at session start", (t) => {
  const e = env(t);
  const agent = path.join(e.root, "agent");
  fs.mkdirSync(liveDir(agent), { recursive: true });
  fs.writeFileSync(path.join(liveDir(agent), "alive.json"), "{}");
  for (const id of ["alive", "dead", "sess-1"]) {
    fs.mkdirSync(path.join(e.scratch, "show", id), { recursive: true });
    fs.writeFileSync(path.join(e.scratch, "show", id, "plan.json"), "{}");
  }
  e.start({}, "sess-1");
  assert.deepEqual(fs.readdirSync(path.join(e.scratch, "show")).sort(), ["alive", "sess-1"]);
});

test("show: a symlinked show root is not pruned through the link at session start", (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  const victims = ["victim-a", "victim-b"];
  for (const v of victims) {
    fs.mkdirSync(path.join(outside, v), { recursive: true });
    fs.writeFileSync(path.join(outside, v, "keep.txt"), "x");
  }
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  e.start({}, "sess-1");
  assert.deepEqual(fs.readdirSync(outside).sort(), victims);
  for (const v of victims) assert.equal(fs.readFileSync(path.join(outside, v, "keep.txt"), "utf8"), "x");
});

test("show: a symlinked show root gets no session dir and no write behind the link", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start();
  assert.equal(show.planWritten(e.plan()), true);
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(traces.some((r) => r.event === "show_error" && r.kind === "refresh"), true);
});

test("show: a symlinked session dir gets no write behind the link", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(e.scratch, "show"));
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show", "sess-1"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start();
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(traces.some((r) => r.event === "show_error"), true);
});

const FOREIGN_JSON = (p: string) => JSON.stringify({ path: p, title: "x", v: 4, at: "2026-01-01T00:00:00.000Z", hash: "h", ruledPath: p, ruledHash: "h", prevHash: null, fences: [] }) + "\n";

test("show: a symlinked session dir holding a foreign plan.json loses no file and gets no new one", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  const seeded = { "plan.json": FOREIGN_JSON(path.join(e.scratch, "plan-elsewhere.md")), "plan.ruled.md": "ruled", "plan.prev.md": "prev" };
  for (const [n, c] of Object.entries(seeded)) fs.writeFileSync(path.join(outside, n), c);
  fs.mkdirSync(path.join(e.scratch, "show"));
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show", "sess-1"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start();
  assert.equal(show.plan, null);
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside).sort(), Object.keys(seeded).sort());
  for (const [n, c] of Object.entries(seeded)) assert.equal(fs.readFileSync(path.join(outside, n), "utf8"), c);
  assert.equal(traces.some((r) => r.event === "show_error" && r.kind === "refresh" && r.errorKind === "ENOTDIR"), true);
});

test("show: a symlinked show root holding sess/plan.json is not read and loses no file", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(path.join(outside, "sess-1"), { recursive: true });
  const seeded = { "plan.json": FOREIGN_JSON(path.join(e.scratch, "plan-elsewhere.md")), "plan.ruled.md": "ruled", "plan.prev.md": "prev" };
  for (const [n, c] of Object.entries(seeded)) fs.writeFileSync(path.join(outside, "sess-1", n), c);
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  fs.writeFileSync(e.plan(), A);
  const { show, traces } = e.start();
  assert.equal(show.plan, null);
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), ["sess-1"]);
  assert.deepEqual(fs.readdirSync(path.join(outside, "sess-1")).sort(), Object.keys(seeded).sort());
  for (const [n, c] of Object.entries(seeded)) assert.equal(fs.readFileSync(path.join(outside, "sess-1", n), "utf8"), c);
  assert.equal(traces.some((r) => r.event === "show_error" && r.kind === "refresh" && r.errorKind === "ENOTDIR"), true);
});

test("livestate: the show field is written whole (no truncation) and only when set", (t) => {
  const e = env(t);
  const agent = path.join(e.root, "agent");
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd: e.ws, mode: "rpc", env: {} }, () => [])!;
  assert.equal("show" in l.snapshot(), false);
  const dir = path.join(e.root, "a".repeat(400), "show", "s1");
  l.show = () => ({ dir, plan: 3 });
  l.flush();
  const on = JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8"));
  assert.deepEqual(on.show, { dir, plan: 3 });
  l.show = () => {
    throw new Error("boom");
  };
  assert.equal("show" in l.snapshot(), false);
  l.stop();
});

test("show: titleOf and parsePlanJson", () => {
  assert.equal(titleOf(Buffer.from("intro\n# Real title #\ntext\n")), "Real title");
  assert.equal(titleOf(Buffer.from("\n\nfirst line\n")), "first line");
  assert.equal(titleOf(Buffer.from("# " + "x".repeat(300))).length, 120);
  assert.equal(titleOf(Buffer.from("")), "plan");
  const ok: PlanJson = { path: null, title: "t", v: 1, at: "x", hash: "h", ruledPath: null, ruledHash: null, prevHash: null, fences: [] };
  assert.deepEqual(parsePlanJson(JSON.stringify(ok)), ok);
  assert.equal(parsePlanJson(JSON.stringify({ ...ok, v: 0 })), null);
  assert.equal(parsePlanJson(JSON.stringify({ ...ok, fences: [1] })), null);
  assert.equal(parsePlanJson("not json"), null);
});

// ---- notes and diagram sidecars (item 6, item 7) ----

const GOOD_SVG = '<svg width="10" height="10"><rect fill="var(--bg)"/></svg>';
const MM = "graph TD\nA-->B";
const withFence = (text = MM) => `# Doc\n\n\`\`\`mermaid\n${text}\n\`\`\`\n\n\`\`\`ts title=x\nlet a = 1;\n\`\`\`\n`;
const noteJson = (show: Show) => parseNoteJson(text(show, "note.json")) as NoteJson;
const stubEngine = (svg = GOOD_SVG, gate?: Promise<void>): Engine => ({ render: async () => { await gate; return svg; }, close: () => undefined });

test("note: writes note.md and note.json last, v increments, the live field carries note", async (t) => {
  const e = env(t);
  let changes = 0;
  const { show, traces } = e.start({ onChange: () => void changes++ });
  const r = await show.note("First", "hello\n```ts title=x\nlet a;\n```\n");
  assert.equal(r.v, 1);
  assert.equal(r.diagrams, 0);
  assert.equal(r.path, path.join(show.dir, "note.md"));
  assert.equal(text(show, "note.md"), "hello\n```ts title=x\nlet a;\n```\n"); // info strings survive untouched
  const j = noteJson(show);
  assert.deepEqual(Object.keys(j), ["v", "title", "at", "hash", "prevHash", "fences", "diagrams"]);
  assert.equal(j.prevHash, null);
  assert.ok(!Number.isNaN(Date.parse(j.at)));
  assert.deepEqual(show.field(), { dir: show.dir, note: 1 });
  assert.ok(changes >= 1);
  assert.equal((await show.note("First", "again")).v, 2);
  assert.equal((await show.note("Other", "x")).v, 3);
  assert.equal(traces.filter((x) => x.event === "show_note").length, 3);
  assert.ok(names(show).every((n) => !n.endsWith(".tmp")));
});

test("note: the previous text rolls to note.prev.md only while the title is the same", async (t) => {
  const e = env(t);
  const { show } = e.start();
  await show.note("T", "one");
  assert.ok(!names(show).includes("note.prev.md"));
  await show.note("T", "two");
  assert.equal(text(show, "note.prev.md"), "one");
  assert.equal(text(show, "note.md"), "two");
  assert.equal(noteJson(show).prevHash, planVersionHash(Buffer.from("one")) === "" ? null : noteJson(show).prevHash);
  assert.match(noteJson(show).prevHash ?? "", /^[0-9a-f]{64}$/);
  await show.note("Different", "three");
  assert.ok(!names(show).includes("note.prev.md"));
  assert.equal(noteJson(show).prevHash, null);
  assert.equal(noteJson(show).v, 3);
});

test("note: v continues across a reload of the session", async (t) => {
  const e = env(t);
  await e.start().show.note("T", "one");
  const again = e.start().show;
  assert.deepEqual(again.field(), { dir: again.dir, note: 1 });
  assert.equal((await again.note("T", "two")).v, 2);
});

test("note: a title or text over the cap is refused and nothing is written", async (t) => {
  const e = env(t);
  const { show } = e.start();
  await assert.rejects(show.note("x".repeat(NOTE_TITLE_MAX + 1), "a"));
  await assert.rejects(show.note("", "a"));
  await assert.rejects(show.note("T", "x".repeat(NOTE_MAX_BYTES + 1)));
  assert.ok(!fs.existsSync(path.join(show.dir, "note.md")));
  assert.ok(!fs.existsSync(path.join(show.dir, "note.json")));
  assert.equal((await show.note("T", "x".repeat(NOTE_MAX_BYTES))).v, 1); // exactly the cap is fine
});

test("note: a symlinked show root is refused and nothing is written behind the link", async (t) => {
  const e = env(t);
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(e.scratch, "show"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  const { show } = e.start();
  await assert.rejects(show.note("T", withFence()));
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("diagrams: a note's sidecars are written after the result, named <sha>-dark|light.svg, and listed in note.json", async (t) => {
  const e = env(t);
  let release!: () => void;
  const gate = new Promise<void>((res) => void (release = res));
  const { show } = e.start({ engine: () => stubEngine(GOOD_SVG, gate) });
  const r = await show.note("T", withFence()); // resolves while the render is still gated
  assert.equal(r.diagrams, 1);
  assert.deepEqual(noteJson(show).diagrams, []);
  assert.ok(!fs.existsSync(path.join(show.dir, "diagrams")) || fs.readdirSync(path.join(show.dir, "diagrams")).length === 0);
  release();
  await show.idle();
  const sha = fenceSha(MM);
  assert.deepEqual(fs.readdirSync(path.join(show.dir, "diagrams")).sort(), [`${sha}-dark.svg`, `${sha}-light.svg`]);
  const j = noteJson(show);
  assert.deepEqual(j.fences, [sha]);
  assert.deepEqual(j.diagrams, [{ sha, dark: `diagrams/${sha}-dark.svg`, light: `diagrams/${sha}-light.svg` }]);
  assert.equal(j.v, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(show.dir, "diagrams", `${sha}-dark.svg`), "utf8"), /var\(/);
  // the same fence in the next note is not rendered again
  let calls = 0;
  const e2 = e.start({ engine: () => ({ render: async () => (calls++, GOOD_SVG), close: () => undefined }) }, "sess-1");
  await e2.show.note("T", withFence() + "more\n");
  await e2.show.idle();
  assert.equal(calls, 0);
  assert.deepEqual(noteJson(e2.show).fences, [sha]);
});

test("diagrams: a plan with a mermaid fence gets its sidecars listed in plan.json (fences and diagrams)", async (t) => {
  const e = env(t);
  const { show } = e.start({ engine: () => stubEngine() });
  fs.writeFileSync(e.plan(), withFence());
  show.planWritten(e.plan());
  await show.idle();
  const sha = fenceSha(MM);
  const p = json(show);
  assert.deepEqual(p.fences, [sha]);
  assert.deepEqual(p.diagrams, [{ sha, dark: `diagrams/${sha}-dark.svg`, light: `diagrams/${sha}-light.svg` }]);
  assert.equal(p.v, 1);
  fs.writeFileSync(e.plan(), "# Doc\nno fences now\n");
  show.planWritten(e.plan());
  await show.idle();
  assert.deepEqual(json(show).fences, []);
  assert.equal(json(show).diagrams, undefined);
});

test("diagrams: a refused SVG leaves no sidecar and the note stays published", async (t) => {
  const e = env(t);
  const { show } = e.start({ engine: () => stubEngine("<svg><script>x</script></svg>") });
  await show.note("T", withFence());
  await show.idle();
  assert.deepEqual(noteJson(show).fences, []);
  assert.deepEqual(fs.existsSync(path.join(show.dir, "diagrams")) ? fs.readdirSync(path.join(show.dir, "diagrams")) : [], []);
});

test("diagrams: a missing module is traced once per session and the fences stay code blocks", async (t) => {
  const e = env(t);
  const { show, traces } = e.start({ engine: (onMissing) => createEngine({ useWorker: false, load: async () => null, onMissing }) });
  await show.note("T", withFence());
  await show.idle();
  await show.note("T", withFence() + "x\n");
  await show.idle();
  assert.equal(traces.filter((x) => x.event === "show_diagram" && x.outcome === "module_missing").length, 1);
  assert.deepEqual(noteJson(show).diagrams, []);
  assert.ok(!fs.existsSync(path.join(show.dir, "diagrams", `${fenceSha(MM)}-dark.svg`)));
});

test("diagrams: a symlinked diagrams dir is not written through", async (t) => {
  const e = env(t);
  const { show } = e.start({ engine: () => stubEngine() });
  await show.note("T", "plain");
  const outside = path.join(e.root, "outside");
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, path.join(show.dir, "diagrams"), "dir");
  } catch (err) {
    if (process.platform === "win32") return t.skip(`symlink creation denied: ${(err as Error).message}`);
    throw err;
  }
  await show.note("T", withFence());
  await show.idle();
  assert.deepEqual(fs.readdirSync(outside), []);
});

async function showTool(t: { after(fn: () => void | Promise<void>): void }, child = false) {
  const tools = new Map<string, { description: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> }>();
  const rig = await r11Rig(t, {}, { child, piExtra: { registerTool: (d: { name: string }) => void tools.set(d.name, d as never) } });
  const call = (params: Record<string, unknown>) => tools.get("foreman_show")!.execute("id", params, undefined, undefined, rig.ctx);
  return { rig, tools, call };
}

test("foreman_show: registered for the foreman, with a description that names its use; never for a child", async (t) => {
  const { tools } = await showTool(t);
  const d = tools.get("foreman_show")!;
  assert.ok(d);
  assert.match(d.description, /explain/);
  assert.match(d.description, /replaces the previous note/);
  assert.match(d.description, /mermaid/);
  assert.match(d.description, /never a file path/);
  const child = await showTool(t, true);
  assert.ok(!child.tools.has("foreman_show"));
});

test("foreman_show: result line, trace event, replacement semantics, cap refusals", async (t) => {
  const { rig, call } = await showTool(t);
  const r1 = await call({ title: "Design", markdown: "# hi\n" });
  assert.ok(!r1.isError, r1.content[0].text);
  assert.match(r1.content[0].text, /^shown: Design \(v1, 0 diagrams\) at .*note\.md\./);
  const r2 = await call({ title: "Design", markdown: "```mermaid\ngraph TD\nA-->B\n```\n" });
  assert.match(r2.content[0].text, /^shown: Design \(v2, 1 diagram\) at /);
  assert.match(r2.content[0].text, /pi-foreman-plan/); // the layout hint
  assert.equal(rig.events("show_note").length, 2);
  const long = await call({ title: "x".repeat(NOTE_TITLE_MAX + 1), markdown: "a" });
  assert.ok(long.isError);
  assert.match(long.content[0].text, /120/);
  const big = await call({ title: "T", markdown: "x".repeat(NOTE_MAX_BYTES + 1) });
  assert.ok(big.isError);
  assert.match(big.content[0].text, /262144/);
  assert.equal(rig.events("show_note").length, 2);
});

test("foreman_show: the result says no panel can show the note when no Herdr pane is known", async (t) => {
  const saved = [process.env.HERDR_PANE_ID, process.env.HC_TERMINAL_ID];
  t.after(() => {
    for (const [k, v] of [["HERDR_PANE_ID", saved[0]], ["HC_TERMINAL_ID", saved[1]]] as const) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const { call } = await showTool(t);
  delete process.env.HERDR_PANE_ID;
  delete process.env.HC_TERMINAL_ID;
  const none = await call({ title: "T", markdown: "a" });
  assert.match(none.content[0].text, /No Herdr pane was detected.*written at .*note\.md.*pi-foreman-plan panel block.*docs\/herdr\.md#notes/);
  process.env.HERDR_PANE_ID = "p1";
  const some = await call({ title: "T", markdown: "a" });
  assert.doesNotMatch(some.content[0].text, /No Herdr pane/);
  assert.match(some.content[0].text, /if your layout has a pi-foreman-plan block/);
});
