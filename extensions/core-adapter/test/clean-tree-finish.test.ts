// Ledger 4 (D71): the no-change valve and the high-stakes hold read the tree without the harness's own files
// (`.workflow/` folders, the scratch dir), anchored at the git toplevel. Real temp git repos with no `.gitignore`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanTreeStatus } from "../trivial.ts";
import { world } from "./_r46world.ts";
import { git, REMINDER, settle as hsSettle, setup } from "./_hsrig.ts";

const CLOSED = "# Ledger: x\nTier: standard\n\n- [x] 1. done\n- [x] V. fresh-eyes verification passed\n";
type R = { continue?: boolean; entries?: { customType?: string; content?: string }[] } | undefined;
type World = ReturnType<typeof world>;
type Adapter = Awaited<ReturnType<World["adapter"]>>;
const settle = async (a: Adapter): Promise<R> => (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
const noChanges = async (w: World) => (await w.traceEvents()).filter((e) => e.event === "ceremony_gate" && e.reason === "no_change").length;
const put = (root: string, rel: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), "x\n");
};

/** A standard session over a real repo without `.gitignore` (the world's own `.workflow/` files are untracked); `git: false` leaves the empty `.git` (git fails). */
async function rig(t: Parameters<typeof world>[0], o: { git?: boolean; ceremony?: Record<string, unknown> } = {}) {
  const w = world(t, { ceremony: { default: "standard", ...o.ceremony } });
  if (o.git !== false) {
    fs.rmSync(path.join(w.project, ".git"), { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: w.project });
  }
  const a = await w.adapter();
  await a.writeLedger(CLOSED);
  return { w, a };
}

test("only harness files (ledger, scratch) change the tree: the finish passes with no_change, no builder or reviewer", async (t) => {
  const { w, a } = await rig(t);
  put(w.project, ".workflow/scratch/t/desc.txt");
  assert.equal(await settle(a), undefined);
  assert.equal(await noChanges(w), 1);
});

test("a changed project file is refused for builder and reviewer", async (t) => {
  const { w, a } = await rig(t);
  put(w.project, "src/a.ts");
  const r = await settle(a);
  assert.equal(r?.continue, true);
  assert.match(String(r?.entries?.[0]?.content), /builder, reviewer/);
  assert.equal(await noChanges(w), 0);
});

test("a custom ceremony.scratchDir outside .workflow/ is not a change; another folder is", async (t) => {
  const { w, a } = await rig(t, { ceremony: { scratchDir: "notes/out" } });
  put(w.project, "notes/out/x.md");
  assert.equal(await settle(a), undefined);
  assert.equal(await noChanges(w), 1);
  put(w.project, "notes/other.md");
  assert.equal((await settle(a))?.continue, true);
});

test("a glob character in the scratch dir does not hide siblings (literal pathspec)", async (t) => {
  const { w, a } = await rig(t, { ceremony: { scratchDir: "sc*" } });
  put(w.project, "scx/a.md");
  assert.equal((await settle(a))?.continue, true);
});

test("session cwd in a subfolder: a change outside it is refused; only its own .workflow file passes", async (t) => {
  const { w, a } = await rig(t);
  const sub = path.join(w.project, "pkg", "app");
  fs.mkdirSync(sub, { recursive: true });
  (a.ctx as { cwd: string }).cwd = sub;
  put(sub, ".workflow/LEDGER-sub.md");
  assert.equal(await settle(a), undefined, "own .workflow only");
  assert.equal(await noChanges(w), 1);
  put(w.project, "other/b.ts");
  assert.equal((await settle(a))?.continue, true, "a change outside the subfolder");
});

test("no git work tree: refused (fail closed)", async (t) => {
  const { w, a } = await rig(t, { git: false });
  assert.equal((await settle(a))?.continue, true);
  assert.equal(await noChanges(w), 0);
});

test("cleanTreeStatus: empty for harness files only, the path of a project file otherwise, null outside a repo", async (t) => {
  const { w } = await rig(t);
  put(w.project, ".workflow/scratch/n.md");
  assert.equal(await cleanTreeStatus(w.project, ".workflow/scratch"), "");
  put(w.project, "src/a.ts");
  assert.match(String(await cleanTreeStatus(w.project, ".workflow/scratch")), /src\//);
  const bare = fs.mkdtempSync(path.join(w.project, "..", "nogit-"));
  assert.equal(await cleanTreeStatus(bare, ".workflow/scratch"), null);
});

// hsReminderHold: nothing built, no step required, a high-stakes pass due (a restored fired reason): held once with the reminder, unless only harness files changed
test("hsReminderHold: only .workflow/ files: not held; a project file: held once", async (t) => {
  const { w, a } = await setup(t, { onMain: true, ceremony: { required: { standard: [], heavy: [] } } });
  git(w.project, "rm", "-q", ".gitignore");
  git(w.project, "commit", "-q", "-m", "no ignore");
  const last = w.ceremonyEntries().at(-1)!;
  const data = JSON.parse(JSON.stringify(last.data));
  data.highStakes = { ...data.highStakes, fired: { reasons: ["design"] } };
  w.entries.push({ ...last, data } as never);
  const b = await w.adapter("resume");
  void a;
  put(w.project, ".workflow/scratch/t/desc.txt");
  assert.equal(await hsSettle(b), "");
  put(w.project, "src/a.ts");
  assert.match(await hsSettle(b), REMINDER);
});
