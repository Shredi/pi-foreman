// R17 item 1 (revision), through the R41 gate: the own-scratch carve-out resolves links like the protect match, so a symlink or hard link
// inside `{cwd}/.pi/scratch/` to `.pi/settings.json` is not a default write (the gate's review asks, one dialog); a plain new file there is.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { gateOutcome, r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const win = process.platform === "win32";
const ASK = JSON.stringify({ verdict: "ask", entry: "tool-config-edit", reason: "stub" });
let answer = ASK;
let calls = 0;
const base = reviewAllowOpts();
const modelRegistry = { ...(base.ctx.modelRegistry as object), complete: async () => (calls++, { content: [{ type: "text", text: answer }], stopReason: "stop" }) };
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => false, select: async () => (dialogs++, "deny with comment"), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: base.config });
const pi = path.join(rig.project, ".pi");
fs.mkdirSync(path.join(pi, "scratch"), { recursive: true });
fs.writeFileSync(path.join(pi, "settings.json"), "{}");
let linked = !win;
if (!win) {
  fs.symlinkSync("../settings.json", path.join(pi, "scratch", "l"));
  fs.linkSync(path.join(pi, "settings.json"), path.join(pi, "scratch", "h"));
}

async function run(tool: string, input: Record<string, unknown>): Promise<{ outcome: string; dialogs: number; calls: number }> {
  const d0 = dialogs;
  const c0 = calls;
  const n0 = rig.trace().length;
  await rig.call(tool, input);
  return { outcome: gateOutcome(rig.trace().slice(n0)), dialogs: dialogs - d0, calls: calls - c0 };
}

// r79 item 11: no rule, not the dangerous class: mode auto runs it, no model call
test("r17 own scratch: a redirect into a plain new file is no default; mode auto runs it, no dialog", async () => {
  const r = await run("bash", { command: "echo x > .pi/scratch/new.md" });
  assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allowed:mode:no-rule", 0, 0]);
});

test("r17 own scratch: the write tool on a plain new file is path-write-worktree, no review", async () => {
  const r = await run("write", { path: ".pi/scratch/new2.md", content: "x" });
  assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allowed:path-write-worktree", 0, 0]);
});

const selfMod = (name: string, tool: string, input: Record<string, unknown>): void => {
  test(`r17 own scratch link ${name}: the link is the settings file, the selfmod rule asks, no model call`, { skip: !linked }, async () => {
    const r = await run(tool, input);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["dialog:selfmod:comment", 1, 0]);
  });
};
selfMod("symlink redirect", "bash", { command: "echo x > .pi/scratch/l" });
selfMod("hard link redirect", "bash", { command: "echo x > .pi/scratch/h" });
selfMod("symlink write tool", "write", { path: ".pi/scratch/l", content: "x" });
selfMod("hard link write tool", "write", { path: ".pi/scratch/h", content: "x" });

// the scratch root itself must not be a link: `.pi/scratch -> .pi`, or `.pi -> <other dir holding scratch>` fails closed
// (one rig; each case swaps the real `.pi` aside, builds its layout, then restores it)
// `settings`: the target is the settings file through the link (the selfmod rule asks); otherwise a plain new file below a linked .pi:
// the write tool is path-write-worktree and a redirect is no default, so the review asks
const failsClosed = (name: string, layout: () => void, tool: string, input: Record<string, unknown>, settings = true): void => {
  const want = settings ? ["dialog:selfmod:comment", 1, 0] : tool === "bash" ? ["allowed:mode:no-rule", 0, 0] : ["allowed:path-write-worktree", 0, 0];
  test(`r17 own scratch root link ${name}: ${settings ? "the selfmod rule asks, no model call" : tool === "bash" ? "mode auto runs it" : "path-write-worktree"}`, { skip: win }, async () => {
    const aside = path.join(rig.project, "pi-real");
    fs.renameSync(pi, aside);
    try {
      layout();
      const r = await run(tool, input);
      assert.deepEqual([r.outcome, r.dialogs, r.calls], want);
    } finally {
      fs.rmSync(pi, { recursive: true, force: true });
      fs.renameSync(aside, pi);
    }
  });
};
const scratchIsPi = (): void => {
  fs.mkdirSync(pi);
  fs.writeFileSync(path.join(pi, "settings.json"), "{}");
  fs.symlinkSync(".", path.join(pi, "scratch"));
};
const piIsLink = (): void => {
  const other = path.join(rig.project, "other-pi");
  fs.mkdirSync(path.join(other, "scratch"), { recursive: true });
  fs.symlinkSync(other, pi);
};
failsClosed("scratch -> .pi redirect", scratchIsPi, "bash", { command: "echo x > .pi/scratch/settings.json" });
failsClosed("scratch -> .pi write tool", scratchIsPi, "write", { path: ".pi/scratch/settings.json", content: "x" });
failsClosed(".pi link write tool", piIsLink, "write", { path: ".pi/scratch/new.md", content: "x" }, false);
failsClosed(".pi link redirect", piIsLink, "bash", { command: "echo x > .pi/scratch/new.md" }, false);
