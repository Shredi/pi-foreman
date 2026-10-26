// R17b (ledger 5): the literal live line `cp <outside-workspace>/.workflow/scratch/<dir>/f.md .pi/scratch/f.md` (absolute source in another
// repo, relative target not yet existing, `.pi/scratch` existing) reaches the (stubbed) auto reviewer, not the human dialog.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

let calls = 0;
let system = "";
const modelRegistry = {
  find: () => ({ cost: { input: 1 } }),
  getProviderAuthStatus: () => ({ configured: true }),
  complete: async (_m: unknown, c: { systemPrompt?: string }) => (calls++, system = c.systemPrompt ?? "", { content: [{ type: "text", text: '{"verdict":"allow","entry":"read-only-inspection","reason":"stub"}' }], stopReason: "stop" }),
};
let dialogs = 0;
const ui = { notify: () => undefined, confirm: async () => (dialogs++, false), select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
const rig = await r11Rig({ after }, {}, { ctx: { modelRegistry, ui }, config: { providers: { fake: { review: { model: "fake/small", timeoutMs: 50 } } } } });
fs.mkdirSync(path.join(rig.project, ".pi", "scratch"), { recursive: true });
execFileSync("git", ["init", "-q", rig.project]);
const hub = fs.mkdtempSync(path.join(os.tmpdir(), "r17b-hub-"));
after(() => fs.rmSync(hub, { recursive: true, force: true }));
const srcDir = path.join(hub, ".workflow", "scratch", "r17-watcher");
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "live-ruling-2.md"), "x\n");
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

test("r17b live shape: cp from outside the workspace into the own relative scratch target reaches the reviewer", async () => {
  const n0 = rig.trace().length;
  await rig.call("bash", { command: `cp ${inBash(path.join(srcDir, "live-ruling-2.md"))} .pi/scratch/live-ruling-2.md` });
  const recs = rig.trace().slice(n0);
  // R41: the gate decides (no auto_review_allow, no overlay ask); the review stub allows the line, no dialog
  assert.equal(recs.some((x) => x.event === "auto_review_allow"), false);
  assert.ok(recs.some((x) => x.event === "guard" && x.guard === "gate" && x.decision === "allowed"), JSON.stringify(recs));
  assert.equal(dialogs, 0);
  void [calls, system];
});
