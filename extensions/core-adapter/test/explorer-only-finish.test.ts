// D20+: a session that changed no project file (a read-only audit: explorers and notes under .workflow/) finishes without builder and reviewer.
// The reporter's sequence in a primary checkout and in a linked worktree: triage trivial, three explorer launches in separate calls (the second escalates the
// session to standard, which stays as it is), a note and a ledger written under .workflow/, finish.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { tick, world } from "./_r46world.ts";

type World = ReturnType<typeof world>;
type R = { continue?: boolean; entries?: { customType?: string; content?: string }[] } | undefined;

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const LEDGER = "# Ledger: audit\nTier: standard\n\n- [x] 1. read the modules\n- [x] V. fresh-eyes verification passed\n";

/** The project folder as a primary checkout (a repository with one commit, no `.gitignore`) or as a linked worktree of a repository next to it. */
function checkout(w: World, kind: "primary" | "linked"): void {
  const keep = fs.mkdtempSync(path.join(path.dirname(w.project), "keep-"));
  fs.cpSync(path.join(w.project, ".workflow"), path.join(keep, ".workflow"), { recursive: true });
  fs.rmSync(w.project, { recursive: true, force: true });
  if (kind === "primary") {
    fs.mkdirSync(w.project);
    git(w.project, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(w.project, "a.txt"), "a\n");
    git(w.project, "add", "a.txt");
    git(w.project, "commit", "-q", "-m", "base");
  } else {
    const main = path.join(path.dirname(w.project), "main-repo");
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "a.txt"), "a\n");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "base");
    git(main, "worktree", "add", "-q", "--detach", w.project);
  }
  fs.cpSync(path.join(keep, ".workflow"), path.join(w.project, ".workflow"), { recursive: true });
  fs.rmSync(keep, { recursive: true, force: true });
}

for (const kind of ["primary", "linked"] as const) {
  test(`the reporter's read-only audit finishes without builder and reviewer (${kind} checkout)`, async (t) => {
    const w = world(t, { ceremony: { default: "trivial" } });
    checkout(w, kind);
    if (kind === "linked") assert.notEqual(git(w.project, "rev-parse", "--git-dir"), git(w.project, "rev-parse", "--git-common-dir"), "a linked worktree");
    const a = await w.adapter("startup");
    await a.tool("foreman_triage")!.execute("tr", { tier: "trivial", reason: "read-only audit" }, undefined, undefined, a.ctx);
    await a.writeLedger(LEDGER.replace("[x] 1.", "[ ] 1."));
    for (let i = 0; i < 3; i++) {
      const l = await a.agentLaunch("explorer", `read module ${i} and report`);
      assert.equal(l.blocked, null, String(l.blocked));
      await a.endRunAs(l.id, "explorer", `module ${i} is fine`);
      await tick(50);
    }
    const note = path.join(w.project, ".workflow", "scratch", "audit-notes.md");
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, "notes\n");
    assert.equal((await a.call("write", { path: note, content: "notes\n" })).block, undefined);
    await a.writeLedger(LEDGER);
    const r = (await a.fire("agent_before_settle", { outcome: "completed", entries: [] })) as R;
    assert.equal(r?.continue, undefined, JSON.stringify(r));
    assert.ok(!(r?.entries ?? []).some((e) => e.customType === "pi-foreman-ceremony-gate"), "no finish refusal");
    const events = await w.traceEvents();
    assert.ok(events.some((e) => e.event === "ceremony_gate" && e.reason === "no_change"), "the no-change valve let it finish");
    assert.ok(!events.some((e) => e.event === "finish_refused"));
  });
}
