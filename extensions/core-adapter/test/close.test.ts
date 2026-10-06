import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeFrom, CloseFlow, closePrompt, intercomClose, INTERCOM_WAKE_TEXT, parseCloseText, resultPath } from "../close.ts";
import type { CloseDeps } from "../close.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-close-")));
const ws = path.join(root, "ws");
const outside = path.join(root, "outside");
for (const d of [path.join(ws, ".workflow"), outside]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", ws]);
fs.symlinkSync(outside, path.join(ws, ".workflow", "link"), "dir");
const opts = { cwd: ws, sessionId: "abcdef0123456789", now: new Date(2026, 9, 6, 14, 5), platform: process.platform };

test("close: trigger text parsing is exact", () => {
  assert.deepEqual(parseCloseText("foreman:close"), {});
  assert.deepEqual(parseCloseText("  foreman:close .workflow/r.md \n"), { path: ".workflow/r.md" });
  for (const t of ["foreman:closed", "please foreman:close", "foreman:close\nrm x", "Foreman:close", "", 3]) assert.equal(parseCloseText(t), null, String(t));
  assert.deepEqual([...closeFrom({ close: { from: ["herdr"] } })], ["herdr"]);
  assert.deepEqual([...closeFrom({ close: { from: "herdr" } })], []);
});

test("close: intercom request needs intercom-parent and the parent recorded at spawn", () => {
  const all = closeFrom({});
  const msg = (id: string, text = "foreman:close", extra: Record<string, unknown> = {}) => ({ from: { id, name: "p" }, message: { content: { text }, ...extra } });
  assert.deepEqual(intercomClose(msg("parent-1"), "parent-1", all), { kind: "close", path: undefined, sender: "parent-1" });
  assert.equal(intercomClose(msg("parent-1", "hello"), "parent-1", all), null);
  assert.equal((intercomClose(msg("other"), "parent-1", all) as { kind: string }).kind, "refused");
  assert.match((intercomClose(msg("parent-1"), undefined, all) as { reason: string }).reason, /PI_FOREMAN_PARENT_INTERCOM/);
  assert.equal((intercomClose(msg("parent-1"), "parent-1", new Set(["herdr"])) as { kind: string }).kind, "refused");
  assert.equal((intercomClose(msg("parent-1", "foreman:close", { crossMachine: { origin: "x" } }), "parent-1", all) as { kind: string }).kind, "refused");
});

test("close: result path default and bound to the workspace .workflow/", () => {
  const def = resultPath(undefined, opts);
  assert.deepEqual(def, { path: path.join(ws, ".workflow", "result-20261006-1405-abcdef01.md") });
  assert.deepEqual(resultPath(".workflow/notes/r.md", opts), { path: path.join(ws, ".workflow", "notes", "r.md") });
  for (const bad of ["README.md", ".workflow", "../outside/r.md", ".workflow/link/r.md", path.join(outside, "r.md")]) assert.ok("error" in resultPath(bad, opts), bad);
});

function rig(waits: { id: string; kind: string; note: string }[] = []) {
  const log: string[] = [];
  const files = new Map<string, string>();
  const deps: CloseDeps = {
    activeWaits: () => waits,
    sendUserMessage: (t) => void log.push(`prompt:${t}`),
    runSync: async () => (log.push("sync"), { text: "pi-foreman sync\nrepo: pushed", ok: true }),
    retro: async () => (log.push("retro"), "approvals: 3"),
    reply: (to, t) => void log.push(`reply:${to}:${t}`),
    notify: (t) => void log.push(`notify:${t}`),
    trace: (r) => void log.push(`trace:${r.decision}`),
    markCause: () => void log.push("cause:close"),
    writeStub: (f, t) => void (files.set(f, t), log.push("stub")),
    exists: (f) => files.has(f),
  };
  let idle = true;
  const ctx = { isIdle: () => idle, shutdown: () => void log.push("shutdown") };
  return { log, files, flow: new CloseFlow(deps), ctx, setIdle: (v: boolean) => void (idle = v) };
}

test("close: refused while a foreman_wait is active; waits are not cancelled; intercom gets a reply", async () => {
  const r = rig([{ id: "w1", kind: "timer", note: "ci" }]);
  r.flow.request({ source: "intercom-parent", file: "/x/r.md", replyTo: "parent-1" }, r.ctx, true);
  assert.equal(r.flow.active, false);
  assert.ok(r.log.includes("trace:refused"));
  assert.ok(r.log.some((l) => l.startsWith("reply:parent-1:") && l.includes("w1 timer")));
  assert.ok(!r.log.some((l) => l.startsWith("prompt:") || l === "shutdown"));
});

test("close: sequence waits for idle, one close turn, then sync, stub, shutdown", async () => {
  const r = rig();
  const file = "/x/.workflow/r.md";
  r.setIdle(false);
  r.flow.request({ source: "intercom-parent", file, replyTo: "parent-1" }, r.ctx, true);
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")), "no turn while busy");
  await r.flow.onSettled(r.ctx);
  assert.ok(!r.log.some((l) => l.startsWith("prompt:")), "settled but not idle: still waiting");
  r.setIdle(true);
  await r.flow.onSettled(r.ctx);
  assert.equal(r.flow.onInput(INTERCOM_WAKE_TEXT, "extension"), true, "intercom idle wake suppressed");
  assert.equal(r.flow.onInput(closePrompt(file), "extension"), false);
  await r.flow.onSettled(r.ctx);
  const seq = r.log.filter((l) => /^(prompt|cause|sync|retro|stub|shutdown)/.test(l));
  assert.deepEqual(seq, [`prompt:${closePrompt(file)}`, "cause:close", "sync", "retro", "stub", "shutdown"]);
  assert.match(r.files.get(file)!, /repo: pushed[\s\S]*approvals: 3/);
  assert.equal(r.flow.active, false);
});

test("close: no stub when the close turn wrote the result file; a second request while closing is refused", async () => {
  const r = rig();
  const file = "/x/.workflow/r.md";
  r.flow.request({ source: "herdr", file }, r.ctx);
  r.flow.request({ source: "herdr", file }, r.ctx);
  assert.equal(r.log.filter((l) => l.startsWith("prompt:")).length, 1);
  assert.ok(r.log.includes("trace:refused"));
  r.files.set(file, "written by the model");
  await r.flow.onSettled(r.ctx);
  assert.ok(!r.log.includes("stub") && !r.log.includes("retro"));
  assert.equal(r.log.at(-1), "shutdown");
});
