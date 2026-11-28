// Ledger session-own-changes 1, 3, 4, 6, 8: the baseline in a real adapter session: taken at a new session, a builder launch and an own
// write; kept by a reload and a fork; legacy sessions behave as before; the owner's tier holds at finish; the reminder reads only session changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkoutKey } from "../dirtybase.ts";
import { buildCeremonyState, CEREMONY_ENTRY, DIRTY_BASE_ENTRY } from "../planstate.ts";
import { gitIn } from "./_submodules.ts";
import { world } from "./_r46world.ts";

type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;
type R = { continue?: boolean; entries?: { customType?: string; content?: string }[] } | undefined;
type Sent = { message: { customType: string; content: string }; options: unknown }[];
type Map = Record<string, { repo: string; head: string | null; paths: Record<string, string> | null }>;

const items = (n: number, mark: string) => Array.from({ length: n }, (_, i) => `- [${mark}] ${i + 1}. item ${i + 1}`).join("\n");
const CLOSED = (tier: string) => `# Ledger: x\nTier: ${tier}\n\n${items(2, "x")}\n- [x] V. fresh-eyes verification passed\n`;
const OPEN = `# Ledger: x\nTier: standard\n\n${items(3, " ")}\n- [ ] V. fresh-eyes verification passed\n`;

const put = (root: string, rel: string, text = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const settle = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const finishAnswer = async (a: Adapter): Promise<R> => {
  const r = await settle(a);
  return (r?.entries ?? []).some((e) => e.customType === "pi-foreman-stop-gate") ? settle(a) : r;
};
const dirtyEntries = (w: World) => w.entries.filter((e) => e.customType === DIRTY_BASE_ENTRY);
const lastMap = (w: World): Map => {
  const e = dirtyEntries(w).at(-1) as { data: { map: Map } };
  return e.data.map;
};
const sessionsDir = (w: World) => path.join(w.project, "..", "agent", "pi-foreman", "state", "sessions");
const scope = (w: World): { v: number; legacy?: boolean; roots?: { repo: string; head: string | null; paths: Record<string, string> | null }[] } | null => {
  const d = sessionsDir(w);
  for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
    const f = path.join(d, n, "baseline.json");
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  return null;
};
/** The checkout top as git and the product report it: the native long form (win32 temp dirs keep an 8.3 short name in w.project). */
const proj = (w: World): string => fs.realpathSync.native(w.project);
const events = async (w: World, event: string) => (await w.traceEvents()).filter((e) => e.event === event);

function repoAt(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  put(dir, "README");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
}

/** A session over a real repo (the world's own `.workflow/` files untracked); `pre` files exist before the session starts. */
async function rig(t: Parameters<typeof world>[0], o: { git?: boolean; ceremony?: Record<string, unknown>; pre?: string[]; sent?: Sent; reason?: string; legacy?: boolean } = {}) {
  const w = world(t, { ceremony: { default: "standard", ...o.ceremony }, ...(o.sent ? { sent: o.sent } : {}) });
  if (o.git !== false) {
    fs.rmSync(path.join(w.project, ".git"), { recursive: true });
    gitIn(w.project, "init", "-q", "-b", "main");
    put(w.project, "README");
    put(w.project, "src/calc.py", "def add(a, b):\n    return a + b\n");
    put(w.project, "src/test_calc.py", "from calc import add\n");
    gitIn(w.project, "add", "src", "README");
    gitIn(w.project, "commit", "-q", "-m", "init");
  }
  for (const f of o.pre ?? []) put(w.project, f);
  // a session file from before the baseline: a ceremony-state entry and no dirty-base entry
  if (o.legacy) w.entries.push({ type: "custom", customType: CEREMONY_ENTRY, data: JSON.parse(JSON.stringify(buildCeremonyState({ plan: null, lineages: [], planPhase: false }))) });
  const a = await w.adapter(o.legacy ? "resume" : o.reason ?? "startup");
  return { w, a };
}

test("a new session takes the cwd baseline once; a ceremony-state change appends no new one; the scope file lists it", async (t) => {
  const { w, a } = await rig(t, { pre: ["pre/one.txt"] });
  assert.equal(dirtyEntries(w).length, 1);
  const map = lastMap(w);
  const key = checkoutKey(w.project);
  assert.deepEqual(Object.keys(map), [key]);
  assert.equal(map[key].repo, proj(w));
  assert.equal(map[key].paths?.["pre/one.txt"], "73cb3858a687a849", "sha256 of the file's content");
  assert.ok(map[key].paths && "pre/one.txt" in map[key].paths);
  assert.deepEqual(scope(w)?.roots?.map((r) => r.repo), [proj(w)]);
  await a.command("ceremony", "heavy"); // a ceremony-state append
  assert.ok(w.ceremonyEntries().length > 1);
  assert.equal(dirtyEntries(w).length, 1);
});

test("a reload keeps the baseline: no new entry, the same map, the scope file rewritten", async (t) => {
  const { w } = await rig(t, { pre: ["pre/one.txt"] });
  const before = JSON.stringify(lastMap(w));
  fs.rmSync(sessionsDir(w), { recursive: true, force: true });
  put(w.project, "pre/one.txt", "edited after the baseline\n");
  await w.adapter("reload");
  assert.equal(dirtyEntries(w).length, 1);
  assert.equal(JSON.stringify(lastMap(w)), before, "the stored hashes, not the current files");
  assert.deepEqual(scope(w)?.roots?.map((r) => r.repo), [proj(w)]);
  assert.equal(scope(w)?.legacy, undefined);
  await w.adapter("resume");
  assert.equal(dirtyEntries(w).length, 1);
});

test("a fork keeps the parent's map and appends none", async (t) => {
  const { w } = await rig(t, { pre: ["pre/one.txt"] });
  const before = JSON.stringify(lastMap(w));
  await w.adapter("fork");
  assert.equal(dirtyEntries(w).length, 1);
  assert.equal(JSON.stringify(lastMap(w)), before);
  assert.deepEqual(scope(w)?.roots?.map((r) => r.repo), [proj(w)]);
});

test("a cwd that is no repository still appends an empty entry; a reload reads it as new, not legacy", async (t) => {
  const { w } = await rig(t, { git: false });
  assert.equal(dirtyEntries(w).length, 1);
  assert.deepEqual(lastMap(w), {});
  assert.deepEqual(scope(w), { v: 1, roots: [] });
  await w.adapter("reload");
  assert.equal(dirtyEntries(w).length, 1);
  assert.deepEqual(scope(w), { v: 1, roots: [] });
});

test("a builder launch into a second repository adds its entry, with the state from before the launch", async (t) => {
  const { w, a } = await rig(t);
  const other = path.join(w.project, "..", "other");
  repoAt(other);
  const real = fs.realpathSync.native(other);
  put(real, "pre.txt");
  const r = await a.agentLaunch("builder", "build it", { cwd: real });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.equal(dirtyEntries(w).length, 2);
  const e = lastMap(w)[checkoutKey(real)];
  assert.deepEqual(Object.keys(e.paths ?? {}), ["pre.txt"]);
  assert.deepEqual(scope(w)?.roots?.map((x) => x.repo).sort(), [real, proj(w)].sort());
  put(real, "built.txt");
  await a.agentLaunch("builder", "again", { cwd: real });
  assert.equal(dirtyEntries(w).length, 2, "a checkout with an entry takes none");
});

test("an own write into a second repository adds its entry before the write runs", async (t) => {
  const { w, a } = await rig(t);
  const other = path.join(w.project, "..", "other2");
  repoAt(other);
  const real = fs.realpathSync.native(other);
  put(real, "pre.txt");
  await a.checkCall("write", { path: path.join(real, "sub", "new.txt"), content: "n\n" });
  assert.equal(dirtyEntries(w).length, 2);
  assert.deepEqual(Object.keys(lastMap(w)[checkoutKey(real)].paths ?? {}), ["pre.txt"]);
  assert.ok(!fs.existsSync(path.join(real, "sub", "new.txt")), "the call itself did not run in this rig");
});

test("a subagent child takes no baseline, appends no entry and writes no scope file", async (t) => {
  const w = world(t, { ceremony: { default: "standard" } });
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  gitIn(w.project, "init", "-q", "-b", "main");
  put(w.project, "pre.txt");
  const prev = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    await w.adapter("startup");
    assert.equal(dirtyEntries(w).length, 0);
    assert.equal(scope(w), null);
  } finally {
    if (prev === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prev;
  }
});

test("a legacy session (no dirty-base entry): builder launch and own write append none; the scope file says legacy; a reload stays legacy", async (t) => {
  const { w, a } = await rig(t, { pre: ["pre/one.txt"], legacy: true });
  assert.equal(dirtyEntries(w).length, 0);
  assert.deepEqual(scope(w), { v: 1, legacy: true });
  const other = path.join(w.project, "..", "other3");
  repoAt(other);
  const real = fs.realpathSync.native(other);
  const r = await a.agentLaunch("builder", "build it", { cwd: real });
  assert.equal(r.blocked, null, String(r.blocked));
  await a.checkCall("write", { path: path.join(real, "n.txt"), content: "n\n" });
  assert.equal(dirtyEntries(w).length, 0);
  assert.deepEqual(scope(w), { v: 1, legacy: true });
  await w.adapter("reload");
  assert.equal(dirtyEntries(w).length, 0);
  assert.deepEqual(scope(w), { v: 1, legacy: true });
});

test("legacy finish: 30 preexisting files count as before, with the note naming why", async (t) => {
  const { w, a } = await rig(t, { ceremony: { default: "trivial" }, pre: Array.from({ length: 30 }, (_, i) => `junk/f${i}.txt`), legacy: true });
  await a.writeLedger(CLOSED("trivial"));
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null, String(b.blocked));
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  const r = await settle(a);
  assert.match(String(r?.entries?.[0]?.content), /Not trivial after all \(files: 30 source files changed \(no session baseline for project: changes made before the session were counted\)\)/);
  assert.equal((await events(w, "triage_escalated")).length, 1);
});

test("30 preexisting files untouched: a trivial builder session stays trivial; two new files escalate", async (t) => {
  const { w, a } = await rig(t, { ceremony: { default: "trivial" }, pre: Array.from({ length: 30 }, (_, i) => `junk/f${i}.txt`) });
  await a.writeLedger(CLOSED("trivial"));
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await settle(a), undefined);
  assert.deepEqual(await events(w, "triage_escalated"), []);
  put(w.project, "junk/f1.txt", "edited by the session\n");
  put(w.project, "src/new1.txt");
  const r = await settle(a);
  assert.match(String(r?.entries?.[0]?.content), /Not trivial after all \(files: 2 source files changed\)/, "one edited preexisting file and one new file");
  assert.equal((await events(w, "triage_escalated")).length, 1);
});

test("/ceremony trivial holds at finish: a builder run over a dirty tree is not escalated and not refused; the ledger's own tier is", async (t) => {
  for (const owner of [true, false]) {
    const { w, a } = await rig(t, { ceremony: { default: "standard" } });
    await a.writeLedger(CLOSED("trivial"));
    if (owner) await a.command("ceremony", "trivial");
    const b = await a.agentLaunch("builder", "build it");
    assert.equal(b.blocked, null, String(b.blocked));
    a.endRunAs(b.id, "builder", "done", undefined, "built");
    await new Promise((r) => setTimeout(r, 50));
    for (const f of ["src/n1.txt", "src/n2.txt", "src/n3.txt"]) put(w.project, f);
    const r = await finishAnswer(a);
    const esc = await events(w, "triage_escalated");
    if (owner) {
      assert.equal(r, undefined, JSON.stringify(r));
      assert.deepEqual(esc, []);
      assert.equal((await events(w, "trivial_check_skipped")).length, 1);
    } else {
      assert.equal(esc.length, 1);
      assert.match(String(r?.entries?.[0]?.content), /Not trivial after all/);
    }
  }
});

test("the unreviewed-work reminder is queued only after a session change: none on an untouched preexisting folder, one after a file change, none once reverted, one after a commit", async (t) => {
  const sent: Sent = [];
  const { w, a } = await rig(t, { sent, pre: ["pre/a.txt", "pre/b.txt", "pre/c.txt"] });
  const reminders = () => sent.filter((m) => m.message.customType === "pi-foreman-review-reminder").length;
  await a.writeLedger(OPEN);
  await a.ownerPrompt();
  const b = await a.agentLaunch("builder", "build it");
  assert.equal(b.blocked, null);
  a.endRunAs(b.id, "builder", "done", undefined, "built");
  await new Promise((r) => setTimeout(r, 50));
  await a.ownerPrompt();
  assert.equal(await finishAnswer(a), undefined);
  assert.equal(reminders(), 0, "the builder changed nothing since the baseline");
  put(w.project, "src/built.txt");
  await a.fire("agent_start", {});
  assert.equal(await settle(a), undefined);
  assert.equal(reminders(), 1);
  fs.rmSync(path.join(w.project, "src", "built.txt"));
  await a.fire("agent_start", {});
  assert.equal(await settle(a), undefined);
  assert.equal(reminders(), 1, "back to the baseline state");
  gitIn(w.project, "add", "-A", "--", "pre");
  gitIn(w.project, "commit", "-q", "-m", "commit pre");
  await a.fire("agent_start", {});
  assert.equal(await settle(a), undefined);
  assert.equal(reminders(), 2, "a new commit is a change");
});

// Ledger session-own-changes 1, 3, 4: a checkout whose first baseline fails is never baselined after the session worked there (fail closed).
test("a failed first baseline (git status fails) records a paths:null entry; the later launch does not baseline the post-work files", async (t) => {
  const { w, a } = await rig(t);
  const other = path.join(w.project, "..", "broken");
  repoAt(other);
  const real = fs.realpathSync.native(other);
  const index = path.join(real, ".git", "index");
  const good = fs.readFileSync(index);
  fs.writeFileSync(index, "corrupt");
  const r1 = await a.agentLaunch("builder", "one", { cwd: real });
  assert.equal(r1.blocked, null, String(r1.blocked));
  fs.writeFileSync(index, good);
  for (let i = 0; i < 30; i++) put(real, `own/f${i}.txt`);
  const r2 = await a.agentLaunch("builder", "two", { cwd: real });
  assert.equal(r2.blocked, null, String(r2.blocked));
  const e = lastMap(w)[checkoutKey(real)];
  assert.ok(e, "an entry exists");
  assert.equal(e.paths, null, "counted whole, not the 30 own files as preexisting");
  assert.equal(e.head, null);
  assert.deepEqual(scope(w)?.roots?.find((x) => x.repo === real)?.paths, null);
});

test("an unresolved directory that later resolves to a checkout is recorded as paths:null, not baselined", async (t) => {
  const { w, a } = await rig(t);
  const plainDir = path.join(w.project, "..", "plain");
  fs.mkdirSync(plainDir, { recursive: true });
  const plain = fs.realpathSync.native(plainDir);
  await a.checkCall("write", { path: path.join(plain, "sub", "a.txt"), content: "a\n" });
  assert.equal(dirtyEntries(w).length, 1, "no checkout yet: nothing recorded");
  gitIn(plain, "init", "-q", "-b", "main");
  put(plain, "sub/a.txt");
  await a.checkCall("write", { path: path.join(plain, "b.txt"), content: "b\n" });
  const e = lastMap(w)[checkoutKey(plain)];
  assert.ok(e);
  assert.equal(e.paths, null);
});
