// R41 item 17: a checkpoint approval and a plan-review verdict survive /reload keyed by the plan version hash. Human approvals live in the
// harness-only approval store; parent rulings carry a `plan-version: <hash>` line (ctime fallback); round-state.json never holds an approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { approvalsDir, planVersionHash, readPlanVerdict, readStored, restoreFromStore, saveStored, stampedApproval, stampPlanVersion } from "../checkpoint.ts";
import { ROUND_STATE_FILE } from "../roundstate.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Result = { details?: { decision?: string; by?: string | null }; content: { text: string }[] };

const KEYS = ["PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID"];
const PLAN = ".workflow/scratch/plan-ck.md";
const BODY = "# Widget\n\n## Goal\nShip it.\n\n## Approach\nOne builder.\n";
const tick = () => new Promise((r) => setTimeout(r, 25));
const tmp = (t: import("node:test").TestContext, p: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  t.after(() => rmTestTmp(d));
  return d;
};
const HASH = (s: string): string => planVersionHash(Buffer.from(s));

test("store: approval and review round-trip, merge, and a file for another hash approves nothing", (t) => {
  const agent = tmp(t, "pf-ckrl-store-");
  const h = HASH(BODY);
  assert.equal(readStored(agent, h), null);
  assert.equal(saveStored(agent, h, "ck", { approval: { at: "2026-01-01T00:00:00Z", by: "user" } }), true);
  assert.equal(saveStored(agent, h, "ck", { review: { verdict: "pass", model: "m", rounds: 2 } }), true);
  const st = readStored(agent, h)!;
  assert.deepEqual(st.approval, { at: "2026-01-01T00:00:00Z", by: "user" });
  assert.deepEqual(st.review, { verdict: "pass", model: "m", rounds: 2 });
  const other = HASH(BODY + "edit\n");
  assert.equal(readStored(agent, other), null, "another plan version has no entry");
  // an entry copied to another hash's file name does not count (the hash inside must match the file name)
  fs.copyFileSync(path.join(approvalsDir(agent), `${h}.json`), path.join(approvalsDir(agent), `${other}.json`));
  assert.equal(readStored(agent, other), null);
});

test("restoreFromStore: only the plan version now on disk is restored", (t) => {
  const root = tmp(t, "pf-ckrl-restore-");
  const agent = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".workflow", "scratch"), { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  const plan = path.join(project, PLAN);
  fs.writeFileSync(plan, BODY);
  const opts = { cwd: project, home: os.homedir(), platform: process.platform, scratchDir: ".workflow/scratch" };
  saveStored(agent, HASH(BODY + "older\n"), "ck", { approval: { at: "2026-01-01T00:00:00Z", by: "user" } });
  assert.equal(restoreFromStore(agent, opts).approved, null, "an approval for another version approves nothing");
  saveStored(agent, HASH(BODY), "ck", { approval: { at: "2026-01-02T00:00:00Z", by: "user" }, review: { verdict: "fail", model: null, rounds: 1 } });
  const r = restoreFromStore(agent, opts);
  assert.equal(r.approved?.plan.hash, HASH(BODY));
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].review.verdict, "fail");
  fs.appendFileSync(plan, "edit\n");
  assert.equal(restoreFromStore(agent, opts).approved, null, "an edited plan is a new version");
});

test("parent ruling: the plan-version stamp is preferred over ctime, a stamp for another version approves nothing", async (t) => {
  const d = tmp(t, "pf-ckrl-stamp-");
  const plan = path.join(d, "plan.md");
  fs.writeFileSync(plan, BODY);
  await tick();
  const ruling = path.join(d, "ruling.md");
  fs.writeFileSync(ruling, "APPROVED\n");
  const hash = stampPlanVersion(ruling, plan);
  assert.equal(hash, planVersionHash(fs.readFileSync(plan)));
  assert.match(fs.readFileSync(ruling, "utf8"), new RegExp(`^APPROVED\\nplan-version: ${hash}\\n$`));
  assert.deepEqual(stampedApproval(d, hash!), { file: ruling });
  // the plan file's ctime moves past the ruling (same bytes): the unstamped ctime binding would refuse, the stamp still approves
  await tick();
  fs.writeFileSync(plan, BODY);
  assert.deepEqual(readPlanVerdict(d, plan), { kind: "approve" });
  // a plan edit makes the stamp name another version
  await tick();
  fs.appendFileSync(plan, "edit\n");
  assert.equal(stampedApproval(d, planVersionHash(fs.readFileSync(plan))), "stale");
  assert.equal(readPlanVerdict(d, plan), null);
  // an unstamped ruling.md falls back to ctime
  const d2 = tmp(t, "pf-ckrl-ctime-");
  const plan2 = path.join(d2, "plan.md");
  fs.writeFileSync(plan2, BODY);
  await tick();
  fs.writeFileSync(path.join(d2, "ruling.md"), "APPROVED\n");
  assert.equal(stampedApproval(d2, HASH(BODY)), null);
  assert.deepEqual(readPlanVerdict(d2, plan2), { kind: "approve" });
});

/** A foreman (non-round, non-child) session over a project; each call to `start` is a fresh adapter instance, like a /reload. */
function rig(t: import("node:test").TestContext) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ckrl-")));
  const shutdowns: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const s of shutdowns) {
      try { await s(); } catch { /* best effort */ }
    }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  for (const d of [path.join(project, ".workflow", "scratch"), path.join(project, ".git"), agentDir]) fs.mkdirSync(d, { recursive: true });
  const plan = path.join(project, PLAN);
  fs.writeFileSync(plan, BODY);
  fs.writeFileSync(path.join(agentDir, "foreman.json"), "{}");
  for (const k of KEYS) delete process.env[k];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_INTERCOM_SESSION_ID = "ckrl-session";
  const counts = { select: 0 };
  async function start(reason: string) {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<Result> }>();
    const pi = {
      events: { on: () => undefined, emit: () => undefined },
      on: (n: string, h: Handler) => void handlers.set(n, h),
      registerCommand: () => undefined,
      registerTool: (x: { name: string; execute: (...a: unknown[]) => Promise<Result> }) => void tools.set(x.name, x),
      getActiveTools: () => [] as string[],
      getAllTools: () => [{ name: "bash" }, { name: "subagent" }],
      setActiveTools: () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
      sendMessage: () => undefined,
    };
    coreAdapter(pi as never);
    const ctx = {
      sessionManager: { getSessionId: () => "ckrl-session", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
      cwd: project,
      model: { provider: "fake", id: "foreman" },
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => false,
      isIdle: () => true,
      modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
      ui: { notify: () => undefined, confirm: async () => false, select: async () => (counts.select++, "approve"), input: async () => "", setStatus: () => undefined, setWidget: () => undefined },
    };
    await handlers.get("session_start")!({ reason }, ctx);
    shutdowns.push(async () => handlers.get("session_shutdown")?.({}, ctx));
    const run = tools.get("foreman_checkpoint")!;
    return (id: string) => run.execute(id, { path: PLAN }, undefined, undefined, ctx);
  }
  return { project, agentDir, plan, counts, start };
}

test("reload: a human approval comes back from the store, no second dialog; an edited plan needs a new one", async (t) => {
  const r = rig(t);
  const check1 = await r.start("startup");
  const first = await check1("c1");
  assert.equal(first.details?.decision, "approve", first.content[0]?.text);
  assert.equal(r.counts.select, 1);
  const h = planVersionHash(fs.readFileSync(r.plan));
  assert.equal(readStored(r.agentDir, h)?.approval?.by, "user");
  const check2 = await r.start("reload");
  const again = await check2("c2");
  assert.equal(again.details?.decision, "approve", again.content[0]?.text);
  assert.match(again.content[0].text, /already approved/);
  assert.equal(r.counts.select, 1, "no new dialog after the reload");
  // a store entry for another version approves nothing: edit the plan, reload, the checkpoint asks again
  fs.appendFileSync(r.plan, "More.\n");
  const check3 = await r.start("reload");
  const third = await check3("c3");
  assert.equal(r.counts.select, 2);
  assert.equal(third.details?.decision, "approve");
});

test("round-state.json never holds an approval", async (t) => {
  const r = rig(t);
  const check = await r.start("startup");
  await check("c1");
  const stateDir = path.join(r.agentDir, "pi-foreman", "state");
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === ROUND_STATE_FILE) files.push(path.join(d, e.name));
    }
  };
  walk(stateDir);
  walk(r.project);
  for (const f of files) assert.ok(!/approv/i.test(fs.readFileSync(f, "utf8").replace(/"approvals?Dir"/g, "")), f);
});
