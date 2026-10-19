// R17 item 1 (revision): the own-scratch carve-out resolves links like the protect match, so a symlink or hard link inside
// `{cwd}/.pi/scratch/` to `.pi/settings.json` stays selfMod (human dialog); a plain new file there still goes to the auto reviewer.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

const win = process.platform === "win32";
let calls = 0;
const modelRegistry = {
  find: () => ({ cost: { input: 1 } }),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: async () => (calls++, { content: [{ type: "text", text: '{"verdict":"allow"}' }], stopReason: "stop" }),
};
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { providers: { fake: { review: { model: "fake/small", timeoutMs: 50 } } } } });
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
  const recs = rig.trace().slice(n0);
  const ov = recs.find((x) => x.event === "overlay");
  const outcome = recs.some((x) => x.event === "auto_review_allow") ? "allow" : !ov ? "pass" : String(ov.decision);
  return { outcome, dialogs: dialogs - d0, calls: calls - c0 };
}

test("r17 own scratch: a plain new file goes to the reviewer", async () => {
  const r = await run("bash", { command: "echo x > .pi/scratch/new.md" });
  assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
});

test("r17 own scratch: the write tool on a plain new file goes to the reviewer", async () => {
  const r = await run("write", { path: ".pi/scratch/new2.md", content: "x" });
  assert.deepEqual([r.outcome, r.dialogs, r.calls], ["allow", 0, 1]);
});

const selfMod = (name: string, tool: string, input: Record<string, unknown>): void => {
  test(`r17 own scratch link ${name}: selfMod, the human dialog`, { skip: !linked }, async () => {
    const r = await run(tool, input);
    assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
  });
};
selfMod("symlink redirect", "bash", { command: "echo x > .pi/scratch/l" });
selfMod("hard link redirect", "bash", { command: "echo x > .pi/scratch/h" });
selfMod("symlink write tool", "write", { path: ".pi/scratch/l", content: "x" });
selfMod("hard link write tool", "write", { path: ".pi/scratch/h", content: "x" });

// the scratch root itself must not be a link: `.pi/scratch -> .pi`, or `.pi -> <other dir holding scratch>` fails closed
// (one rig; each case swaps the real `.pi` aside, builds its layout, then restores it)
const failsClosed = (name: string, layout: () => void, tool: string, input: Record<string, unknown>): void => {
  test(`r17 own scratch root link ${name}: selfMod, the human dialog`, { skip: win }, async () => {
    const aside = path.join(rig.project, "pi-real");
    fs.renameSync(pi, aside);
    try {
      layout();
      const r = await run(tool, input);
      assert.deepEqual([r.outcome, r.dialogs, r.calls], ["ask-denied", 1, 0]);
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
failsClosed(".pi link write tool", piIsLink, "write", { path: ".pi/scratch/new.md", content: "x" });
failsClosed(".pi link redirect", piIsLink, "bash", { command: "echo x > .pi/scratch/new.md" });
