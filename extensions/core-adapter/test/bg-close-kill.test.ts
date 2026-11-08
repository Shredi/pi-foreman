// The close sequence ends the still-running foreman_bg runs of the session (SIGTERM to the group); session_shutdown does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { processAlive, registerWait, terminateBg } from "../wait.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 50 && !f(); i++) await sleep(50); return f(); };

function harness(t: { after(fn: () => void): void }) {
  delete process.env.PI_SUBAGENT_CHILD;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-bgkill-")));
  const pids: number[] = [];
  t.after(() => {
    for (const p of pids) try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    rmTestTmp(root);
  });
  const cwd = path.join(root, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, Handler>();
  const pi = { on: (n: string, h: Handler) => void handlers.set(n, h), registerTool: (x: Tool) => void tools.set(x.name, x), sendMessage: () => undefined, getAllTools: () => [] };
  const session = { id: "s1", isChild: false, cwd, agentDir: path.join(root, "agent"), overlay: null, config: () => ({ wait: { batchWindowSeconds: 0 } }), trace: () => undefined };
  const handle = registerWait(pi as never, { session: async () => session as never, home: root, platform: process.platform });
  const ctx = { mode: "tui", cwd, isIdle: () => true, sessionManager: { getSessionId: () => "s1" } };
  const start = async (): Promise<number> => {
    const r = await tools.get("foreman_bg")!.execute("c", { command: "sleep 60", note: "long" }, undefined, undefined, ctx);
    const pid = Number(r.details.pid);
    pids.push(pid);
    return pid;
  };
  return { handle, handlers, ctx, start };
}

test("cancelAll (the close sequence) SIGTERMs the group of a running foreman_bg run", { skip: process.platform === "win32" }, async (t) => {
  const h = harness(t);
  const pid = await h.start();
  assert.ok(processAlive(pid));
  const ids = h.handle.cancelAll("s1");
  assert.equal(ids.length, 1);
  assert.ok(await until(() => !processAlive(pid)), "the run is gone");
  assert.deepEqual(h.handle.active("s1"), []);
});

test("session_shutdown (a reload or exit) leaves the run alone", { skip: process.platform === "win32" }, async (t) => {
  const h = harness(t);
  const pid = await h.start();
  await h.handlers.get("session_shutdown")!({}, h.ctx);
  await sleep(300);
  assert.ok(processAlive(pid), "still running");
});

test("terminateBg ignores a pid that is gone", () => {
  assert.equal(terminateBg(2 ** 22 + 12345), false);
});
