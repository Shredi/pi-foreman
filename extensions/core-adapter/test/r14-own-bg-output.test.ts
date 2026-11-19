// R14 P1 item 1 (ruling 2e): the foreman's own bg_run outputs `.pi/tasks/<own session>-<pid>/<id>.output` join its own-read set: read-only
// verbs in bash and the foreman_wait `log` of a pid/ci wait. A write there, another session's task dir and a symlink out of the own dir stay
// refused. The log runs through checkLogPath and the foreman_wait tool (registerWait).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { ownTaskReadable } from "../roundsurface.ts";
import { checkLogPath, registerWait } from "../wait.ts";
import { posixOnly } from "./_platform.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

const ownTasks = ownTaskReadable([ws], SID);
const roots = { worktree: ws, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, agentDir: ag, home, pkgRoot: PKG } as never;
const bound = { cwd: ws, home, agentDir: ag, platform: process.platform, roots, ownTasks };

test("own_bg_output_foreman_wait_log_accepted", () => {
  assert.deepEqual(checkLogPath(OWN, bound), { log: path.join(ws, OWN) });
});

test("own_bg_output_foreman_wait_log_other_session_refused", () => {
  const r = checkLogPath(FOREIGN, bound);
  assert.ok("error" in r && /refused: the path is under the write protection/.test(r.error), JSON.stringify(r));
  // without the own task dirs (today's bound) the own output is refused too
  assert.ok("error" in checkLogPath(OWN, { ...bound, ownTasks: undefined }));
});

test("own_bg_output_foreman_wait_log_symlink_out_refused", { skip: posixOnly }, () => {
  const link = `.pi/tasks/${SID}-66406/link.output`;
  fs.symlinkSync(path.join(ws, FOREIGN), path.join(ws, link));
  assert.ok("error" in checkLogPath(link, bound));
});

test("own_bg_output_foreman_wait_tool_log_accepted", async () => {
  type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h), registerTool: (t: Tool) => void tools.set(t.name, t), sendMessage: () => undefined, getAllTools: () => [] };
  const session = { id: SID, isChild: false, cwd: ws, agentDir: ag, roots, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined, ownTasks: (cwd: string) => ownTaskReadable([cwd], SID) };
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
