// R14 P1 item 1 (ruling 2e): the foreman's own bg_run outputs `.pi/tasks/<own session>-<pid>/<id>.output` join its own-read set: read-only
// verbs in bash and the foreman_wait `log` of a pid/ci wait. A write there, another session's task dir and a symlink out of the own dir stay
// refused. Bash cases run through the overlay (checkToolCall); the log through checkLogPath and the foreman_wait tool (registerWait).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, ownStateRead, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownTaskReadable } from "../roundsurface.ts";
import { checkLogPath, registerWait } from "../wait.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-bgout-")));
after(() => rmTestTmp(w));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const SID = "01a1500b-own";
const OTHER = "01a1599c-other";
const OWN = `.pi/tasks/${SID}-66406/bc00d3ee1.output`;
const FOREIGN = `.pi/tasks/${OTHER}-66406/bc00d3ee1.output`;
for (const f of [OWN, FOREIGN]) {
  fs.mkdirSync(path.join(ws, path.dirname(f)), { recursive: true });
  fs.writeFileSync(path.join(ws, f), "out\n");
}
fs.mkdirSync(ag, { recursive: true });

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownTasks = ownTaskReadable([ws], SID);
// as index.ts builds them for the foreman: the own task dirs are in ownTasks (strict reads) and in the own-read set (ownReads)
const main: MatchCtx = { cwd: ws, home, platform: process.platform, role: "main", ownTasks, ownReads: ownTasks };
const sh = (command: string): string => checkToolCall(rules, "bash", { command }, main)?.kind ?? "pass";
const bound = { cwd: ws, home, agentDir: ag, platform: process.platform, overlay: rules, ownTasks };

test("own_bg_output_cat_literal_passes", () => {
  assert.equal(sh(`cat ${OWN}`), "pass");
  for (const cmd of [`head -20 ${OWN}`, `tail -n 5 ${OWN}`, `wc -l ${OWN}`, `ls -la .pi/tasks/${SID}-66406/`, `stat ${OWN}`]) assert.equal(sh(cmd), "pass", cmd);
});

test("own_bg_output_other_session_refused", () => {
  // the overlay: stat is no strict read, so only the own-read set lets it name `.pi/tasks/`; another session's dir keeps the ask
  assert.notEqual(sh(`stat ${FOREIGN}`), "pass");
  assert.equal(ownStateRead(`cat ${OWN}`, { ...main, role: "child" }), false);
});

test("own_bg_output_redirect_into_it_refused", () => {
  for (const cmd of [`echo x > ${OWN}`, `echo x >> ${OWN}`, `cat ${OWN} | tee ${OWN}`, `rm ${OWN}`]) assert.notEqual(sh(cmd), "pass", cmd);
});

test("own_bg_output_foreman_wait_log_accepted", () => {
  assert.deepEqual(checkLogPath(OWN, bound), { log: path.join(ws, OWN) });
});

test("own_bg_output_foreman_wait_log_other_session_refused", () => {
  const r = checkLogPath(FOREIGN, bound);
  assert.ok("error" in r && /refused: the path is under the write protection/.test(r.error), JSON.stringify(r));
  // without the own task dirs (today's bound) the own output is refused too
  assert.ok("error" in checkLogPath(OWN, { ...bound, ownTasks: undefined }));
});

test("own_bg_output_foreman_wait_log_symlink_out_refused", { skip: process.platform === "win32" }, () => {
  const link = `.pi/tasks/${SID}-66406/link.output`;
  fs.symlinkSync(path.join(ws, FOREIGN), path.join(ws, link));
  assert.ok("error" in checkLogPath(link, bound));
});

test("own_bg_output_foreman_wait_tool_log_accepted", async () => {
  type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h), registerTool: (t: Tool) => void tools.set(t.name, t), sendMessage: () => undefined, getAllTools: () => [] };
  const session = { id: SID, isChild: false, cwd: ws, agentDir: ag, overlay: rules, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined, ownTasks: (cwd: string) => ownTaskReadable([cwd], SID) };
  // the tools register for the foreman only (a test run inside a child session has PI_SUBAGENT_CHILD set)
  const childEnv = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    registerWait(pi as never, { session: async () => session as never, home, platform: process.platform });
  } finally {
    if (childEnv !== undefined) process.env.PI_SUBAGENT_CHILD = childEnv;
  }
  const ctx = { mode: "tui", cwd: ws, isIdle: () => true, sessionManager: { getSessionId: () => SID } };
  const wait = tools.get("foreman_wait")!;
  assert.ok(wait, [...tools.keys()].join(","));
  try {
    const ok = await wait.execute("c", { action: "start", kind: "pid", pid: process.pid, log: OWN }, undefined, undefined, ctx);
    assert.notEqual(ok.isError, true, ok.content[0]?.text);
    const no = await wait.execute("c", { action: "start", kind: "pid", pid: process.pid, log: FOREIGN }, undefined, undefined, ctx);
    assert.equal(no.isError, true);
    assert.match(no.content[0].text, /foreman_wait log on '.*' refused: the path is under the write protection/);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
  }
});
