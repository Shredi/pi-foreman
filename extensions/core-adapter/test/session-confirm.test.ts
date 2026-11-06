import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NO_UI_REFUSAL, ownerConfirm, runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-confirm-")));
fs.writeFileSync(path.join(root, "b.md"), "\n# Title\n\nsecond line\nthird line\nfourth line\n");
const ranks = [{ match: "p/top", tier: 0 }, { match: "p/low", tier: 2 }];
const config = { providers: { p: { ranks } } };

function deps(over: Partial<SessionDeps> = {}): SessionDeps & { spawned: string[][] } {
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir: path.join(root, "agent"),
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "handoff: x", stderr: "", timedOut: false }),
    send: async () => "sent",
    spawned,
    ...over,
  };
}

test("session confirm: Yes opens and the dialog shows label, model, cwd and the first 3 brief lines", async () => {
  const asked: { title: string; message: string }[] = [];
  const d = deps({ model: "p/low", confirm: async (title, message) => (asked.push({ title, message }), true) });
  const r = await runSessionCommand(d, "open demo b.md --model p/other --plan-first");
  assert.equal(r.ok, true);
  assert.equal(d.spawned.length, 1);
  assert.equal(asked.length, 1);
  const m = asked[0].message;
  assert.match(asked[0].title, /demo/);
  assert.match(m, /label: demo/);
  assert.match(m, /model: p\/other/);
  assert.match(m, new RegExp(`cwd: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(m, /worktree: no/);
  assert.match(m, /plan-first: yes/);
  assert.match(m, /machine: local/);
  assert.match(m, /# Title\nsecond line\nthird line$/);
  assert.doesNotMatch(m, /fourth line/);
});

test("session confirm: No refuses with owner_declined and spawns nothing", async () => {
  const d = deps({ confirm: async () => false });
  const r = await runSessionCommand(d, "open demo b.md");
  assert.equal(r.ok, false);
  assert.equal(r.text, "session open refused [owner_declined]: the owner declined to open session demo");
  assert.equal(d.spawned.length, 0);
  assert.equal(fs.existsSync(path.join(root, "agent")), false);
});

test("session confirm: no UI refuses with no_ui and spawns nothing", async () => {
  const d = deps();
  const r = await runSessionCommand(d, "open demo b.md");
  assert.equal(r.ok, false);
  assert.equal(r.text, NO_UI_REFUSAL);
  assert.match(r.text, /^session open refused \[no_ui\]/);
  assert.equal(d.spawned.length, 0);
});

test("session confirm: a model ranked above the own model opens after Yes", async () => {
  const d = deps({ model: "p/low", config, confirm: async () => true });
  const r = await runSessionCommand(d, "open demo b.md --model p/top");
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /session_rank/);
  assert.equal(d.spawned.length, 1);
});

test("session confirm: --dry-run shows no dialog and works without UI", async () => {
  let asked = 0;
  const d = deps({ model: "p/low", config, confirm: async () => (asked++, true) });
  assert.equal((await runSessionCommand(d, "open demo b.md --model p/top --dry-run")).ok, true);
  assert.equal(asked, 0);
  const d2 = deps();
  assert.equal((await runSessionCommand(d2, "open demo b.md --dry-run")).ok, true);
  assert.equal(d2.spawned.length, 1);
});

test("session confirm: --machine asks too and shows the machine", async () => {
  let message = "";
  const d = deps({ confirm: async (_t, m) => ((message = m), false) });
  const r = await runSessionCommand(d, "open demo b.md --machine box --cwd /srv/x");
  assert.match(r.text, /\[owner_declined\]/);
  assert.match(message, /machine: box/);
  assert.match(message, /cwd: \/srv\/x/);
  assert.equal(d.spawned.length, 0);
});

test("session confirm: an unreadable brief shows a note and the dialog still asks", async () => {
  let message = "";
  const d = deps({ confirm: async (_t, m) => ((message = m), false) });
  await runSessionCommand(d, "open demo missing.md");
  assert.match(message, /\(brief unreadable\)/);
});

test("ownerConfirm: needs hasUI and tui/rpc mode; a thrown dialog counts as No; no timeout option", async () => {
  const calls: unknown[][] = [];
  const ctx = (over: Record<string, unknown>) => ({ hasUI: true, mode: "tui", ui: { confirm: async (...a: unknown[]) => (calls.push(a), true) }, ...over }) as never;
  assert.equal(ownerConfirm(ctx({ hasUI: false }), undefined), undefined);
  assert.equal(ownerConfirm(ctx({ mode: "print" }), undefined), undefined);
  const yes = ownerConfirm(ctx({}), undefined)!;
  assert.equal(await yes("t", "m"), true);
  assert.deepEqual(calls[0], ["t", "m"]);
  const boom = ownerConfirm(ctx({ ui: { confirm: async () => { throw new Error("x"); } } }), undefined)!;
  assert.equal(await boom("t", "m"), false);
});
