// D118: a foreman session started by hand in a primary checkout gets its own linked worktree at its first builder launch (sessionfolder.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { roundWorktrees } from "../roundsurface.ts";
import { folderSlug, primaryCheckout } from "../sessionfolder.ts";
import { tick, world } from "./_r46world.ts";

type Rig = Awaited<ReturnType<ReturnType<typeof world>["adapter"]>>;

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();

/** A standard-tier world over a real repo on `main`; `origin` (a bare repo) gets one commit more than the local `main`. */
async function setup(t: Parameters<typeof world>[0], o: { origin?: "ahead" | "broken" | "none"; tier?: string; linked?: boolean } = {}) {
  const w = world(t, { ceremony: { default: o.tier ?? "standard" } });
  const root = path.join(w.project, "..");
  fs.rmSync(path.join(w.project, ".git"), { recursive: true });
  git(w.project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(w.project, ".gitignore"), ".workflow/\n");
  git(w.project, "add", "-A");
  git(w.project, "commit", "-q", "-m", "seed");
  let originTip = "";
  if (o.origin === "ahead" || o.origin === "broken") {
    const bare = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", bare);
    git(w.project, "remote", "add", "origin", bare);
    git(w.project, "push", "-q", "origin", "main");
    git(w.project, "remote", "set-head", "origin", "main");
    const other = path.join(root, "other");
    git(root, "clone", "-q", bare, other);
    fs.writeFileSync(path.join(other, "newer.txt"), "newer\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "newer");
    git(other, "push", "-q", "origin", "main");
    originTip = git(other, "rev-parse", "HEAD");
    if (o.origin === "broken") git(w.project, "remote", "set-url", "origin", path.join(root, "gone.git"));
  }
  if (o.linked) {
    // the session's folder is a linked worktree of another checkout: its .git file replaces the project's
    const linked = path.join(root, "linked");
    git(w.project, "worktree", "add", "-q", "-b", "lk", linked);
    fs.rmSync(path.join(w.project, ".git"), { recursive: true });
    fs.copyFileSync(path.join(linked, ".git"), path.join(w.project, ".git"));
  }
  const a = await w.adapter("startup");
  await a.command("ceremony", o.tier ?? "standard");
  await a.writeLedger(`# Ledger: x\nTier: ${o.tier ?? "standard"}\n\n- [ ] 1. item\n`);
  const stateDir = path.join(root, "agent", "pi-foreman", "state");
  const slug = `s-${(a.ctx.sessionManager.getSessionId() as string).slice(0, 8)}`;
  return { w, a, root, originTip, stateDir, slug, sid: a.ctx.sessionManager.getSessionId() as string };
}

/** A launch through the adapter; `input` is what the hooks left of it, `note` the text the result gained. */
async function launch(a: Rig, input: Record<string, unknown>) {
  const id = `f${Math.random().toString(36).slice(2, 8)}`;
  await a.fire("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: input }] } });
  const res = (await a.fire("tool_call", { toolName: "subagent", toolCallId: id, input })) as { block?: boolean; reason?: string } | undefined;
  if (res?.block) return { blocked: res.reason ?? "blocked", input, note: "" };
  const r = (await a.fire("tool_result", { toolName: "subagent", toolCallId: id, input, details: { runId: `run-${id}` }, content: [{ type: "text", text: "started" }], isError: false })) as { content?: { text?: string }[] } | undefined;
  return { blocked: null as string | null, input, note: (r?.content ?? []).map((c) => c.text ?? "").join("\n") };
}
const builder = (a: Rig, extra: Record<string, unknown> = {}) => launch(a, { agent: "builder", task: "build the widget", ...extra });
const worktrees = (dir: string) => git(dir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));

test("folderSlug: the session name lowercased, other runs as `-`, 40 characters, the id for an empty or reserved name", () => {
  assert.equal(folderSlug("My Big_Session!! v2", "abcdef1234"), "my-big-session-v2");
  assert.equal(folderSlug("x".repeat(60), "id"), "x".repeat(40));
  assert.equal(folderSlug("worktrees", "abcdef1234"), "s-abcdef12");
  assert.equal(folderSlug("  !!  ", "abcdef1234"), "s-abcdef12");
  assert.equal(folderSlug(undefined, "abcdef1234"), "s-abcdef12");
});

test("D118: the first builder launch without cwd at standard gets a new worktree from the fetched default branch; a second launch reuses it; the manifest holds it", async (t) => {
  const { w, a, originTip, stateDir, slug, sid } = await setup(t, { origin: "ahead" });
  const first = await builder(a);
  assert.equal(first.blocked, null, String(first.blocked));
  const cwd = String(first.input.cwd);
  assert.equal(cwd, path.join(w.project + ".worktrees", slug));
  assert.ok(fs.existsSync(path.join(cwd, ".git")), "the worktree exists");
  assert.equal(git(cwd, "rev-parse", "HEAD"), originTip, "the base is the fetched origin/main, not the stale local main");
  assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), `round/${slug}`);
  assert.ok(first.note.includes(`own folder ${cwd} (branch round/${slug}, from origin/main)`), first.note);
  assert.match(first.note, /pass it as cwd to pr_create/);
  await tick(200);
  assert.deepEqual(roundWorktrees(stateDir, sid).map((p) => fs.realpathSync(p)), [fs.realpathSync(cwd)], "the close manifest holds the folder");

  const second = await launch(a, { agent: "explorer", task: "look around" });
  assert.equal(second.blocked, null, String(second.blocked));
  assert.equal(second.input.cwd, cwd, "a later entry without cwd gets the folder");
  assert.equal(worktrees(w.project).length, 2, "no second worktree");
  const third = await builder(a);
  assert.equal(third.input.cwd, cwd);
  assert.equal(worktrees(w.project).length, 2);
});

test("D118: a dirty primary checkout is named in the launch line", async (t) => {
  const { w, a } = await setup(t, { origin: "none" });
  fs.writeFileSync(path.join(w.project, "wip.txt"), "wip\n");
  const r = await builder(a);
  assert.equal(r.blocked, null, String(r.blocked));
  assert.match(r.note, /uncommitted changes; they are not in the session folder/);
  assert.equal(git(String(r.input.cwd), "rev-parse", "HEAD"), git(w.project, "rev-parse", "HEAD"), "no origin: the base is HEAD");
});

test("D118: an explicit cwd is untouched and makes no worktree", async (t) => {
  const { w, a } = await setup(t);
  const other = path.join(w.project, "..", "elsewhere");
  git(w.project, "worktree", "add", "-q", "-b", "else", other);
  const r = await builder(a, { cwd: other });
  assert.equal(r.input.cwd, other);
  assert.equal(worktrees(w.project).length, 2, "only the one the test made");
  const tasks = await launch(a, { tasks: [{ agent: "builder", task: "x", cwd: other }, { agent: "builder", task: "y", cwd: other }] });
  assert.equal(tasks.blocked, null, String(tasks.blocked));
  assert.equal(worktrees(w.project).length, 2);
});

test("D118: a launch of a read-only role before any builder makes no worktree", async (t) => {
  const { w, a } = await setup(t);
  const r = await launch(a, { agent: "explorer", task: "look around" });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.equal(r.input.cwd, undefined);
  assert.equal(worktrees(w.project).length, 1);
});

test("D118: the trivial tier is untouched", async (t) => {
  const { w, a } = await setup(t, { tier: "trivial" });
  const r = await builder(a);
  assert.equal(r.input.cwd, undefined);
  assert.equal(worktrees(w.project).length, 1);
});

test("D118: a session in a linked worktree is untouched", async (t) => {
  const { w, a } = await setup(t, { linked: true });
  assert.equal(await primaryCheckout(w.project), null, "a linked worktree is not a primary checkout");
  const r = await builder(a);
  assert.equal(r.blocked, null, String(r.blocked));
  assert.equal(r.input.cwd, undefined);
});

test("primaryCheckout: the top of a primary checkout, null outside git", async (t) => {
  const { w } = await setup(t);
  assert.equal(await primaryCheckout(path.join(w.project, "sub", "..")), fs.realpathSync(w.project));
  assert.equal(await primaryCheckout(path.join(w.project, "..", "..")), null);
});

test("D118: a session folder under a reload is reused (a second adapter over the same session file)", async (t) => {
  const { w, a } = await setup(t);
  const first = await builder(a);
  const cwd = String(first.input.cwd);
  await a.down();
  const b = await w.adapter("resume");
  const again = await launch(b, { agent: "builder", task: "build more" });
  assert.equal(again.blocked, null, String(again.blocked));
  assert.equal(again.input.cwd, cwd);
  assert.equal(worktrees(w.project).length, 2);
});

test("D118: a taken path gets the next suffix, path and branch together", async (t) => {
  const { w, a, slug } = await setup(t);
  git(w.project, "branch", `round/${slug}`); // the branch is taken, the path is free
  const r = await builder(a);
  assert.equal(r.blocked, null, String(r.blocked));
  assert.equal(path.basename(String(r.input.cwd)), `${slug}-2`);
  assert.equal(git(String(r.input.cwd), "symbolic-ref", "--short", "HEAD"), `round/${slug}-2`);
});

test("D118: no origin/main to build on after a failed fetch refuses the launch with the route; nothing is created", async (t) => {
  const { w, a } = await setup(t, { origin: "broken" });
  git(w.project, "update-ref", "-d", "refs/remotes/origin/main");
  const r = await builder(a);
  assert.match(r.blocked ?? "", /launch refused \[session_folder\].*git fetch origin failed/s);
  assert.match(r.blocked ?? "", /explicit `cwd`.*foreman_session_open/s);
  assert.equal(worktrees(w.project).length, 1);
  assert.equal(fs.existsSync(w.project + ".worktrees"), false);
});

test("D118: a failed fetch with a fetched origin/main builds on it and says the base may be stale", async (t) => {
  const { w, a } = await setup(t, { origin: "broken" });
  const r = await builder(a);
  assert.equal(r.blocked, null, String(r.blocked));
  assert.match(r.note, /may be stale/);
  assert.equal(git(String(r.input.cwd), "rev-parse", "HEAD"), git(w.project, "rev-parse", "origin/main"));
});

test("D118: a launch with the folder as cwd is the owned-root default; another checkout outside the worktree root is not", async (t) => {
  const { w, a, root } = await setup(t);
  const first = await builder(a);
  const cwd = String(first.input.cwd);
  const rules = async () => ((await w.traceEvents()) as { event?: string; guard?: string; toolFamily?: string; rule?: string }[]).filter((e) => e.event === "guard" && e.guard === "gate" && e.toolFamily === "subagent").map((e) => e.rule);
  const before = (await rules()).length;
  const inside = await builder(a, { cwd });
  assert.equal(inside.blocked, null, String(inside.blocked));
  const outside = path.join(root, "wt2");
  git(w.project, "worktree", "add", "-q", "-b", "other", outside);
  const out = await builder(a, { cwd: outside });
  assert.equal(out.blocked, null, String(out.blocked));
  const got = (await rules()).slice(before);
  assert.equal(got[0], "default-role-launch", "the folder is in the owned worktree root: no review, no ask");
  assert.notEqual(got[1], "default-role-launch", "a checkout outside the root is not a default allow");
});
