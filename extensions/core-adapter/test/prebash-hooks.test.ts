// R41 item 20: safety.preBash.hooks runs before a bash call; fail-open by default (the error is traced as prebash_hook_error and the call goes
// on), strict blocks on a hook error, an explicit block always blocks; both keys are read from the config.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { preBashConfigOf, runPreBashHooks } from "../prebash.ts";
import type { PreBashInput } from "../prebash.ts";
import type { Spawner } from "../spawn.ts";
import coreAdapter from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const input: PreBashInput = { command: "echo hi", cwd: "/w", tool: "bash", session: "s", role: "foreman" };
const spawnerOf = (code: number | null, stderr = "", extra: { error?: Error; timedOut?: boolean } = {}): Spawner => async () => ({ code, stdout: "", stderr, timedOut: false, ...extra });

test("config: hooks are the non-empty strings, strict only for an explicit true", () => {
  assert.deepEqual(preBashConfigOf(undefined), { hooks: [], strict: false });
  assert.deepEqual(preBashConfigOf({ hooks: ["a.mjs", "", 3, " b --x "], strict: "yes" }), { hooks: ["a.mjs", "b --x"], strict: false });
  assert.deepEqual(preBashConfigOf({ hooks: [], strict: true }), { hooks: [], strict: true });
});

test("hooks run in order; a command hook gets the input as JSON on stdin; exit 2 blocks with stderr", async () => {
  const seen: string[] = [];
  const spawner: Spawner = async (cmd, args, o) => {
    seen.push(`${cmd} ${args.join(" ")} ${o.input}`);
    return { code: cmd === "second" ? 2 : 0, stdout: "", stderr: "no pushing\n", timedOut: false };
  };
  const r = await runPreBashHooks({ hooks: ["first -a", "second", "third"], strict: false }, input, { spawner, agentDir: "/a" });
  assert.match(r.blocked!, /pre-bash hook second: no pushing/);
  assert.equal(seen.length, 2, "the first block stops the run");
  assert.equal(seen[0], `first -a ${JSON.stringify(input)}`);
});

test("fail-open: a hook error is collected and the call passes; strict blocks; an explicit block blocks in both modes", async () => {
  for (const sp of [spawnerOf(1), spawnerOf(null, "", { error: new Error("ENOENT") }), spawnerOf(null, "", { timedOut: true })]) {
    const open = await runPreBashHooks({ hooks: ["h"], strict: false }, input, { spawner: sp, agentDir: "/a" });
    assert.equal(open.blocked, undefined);
    assert.equal(open.errors.length, 1);
    const strict = await runPreBashHooks({ hooks: ["h"], strict: true }, input, { spawner: sp, agentDir: "/a" });
    assert.match(strict.blocked!, /strict is on|safety\.preBash\.strict/);
  }
  const load = async () => ({ default: () => ({ block: true, reason: "nope" }) });
  for (const strict of [false, true]) {
    const r = await runPreBashHooks({ hooks: ["/x/h.mjs"], strict }, input, { spawner: spawnerOf(0), agentDir: "/a", load });
    assert.match(r.blocked!, /nope/);
  }
  const throwing = async () => ({ default: () => { throw new Error("boom"); } });
  const t = await runPreBashHooks({ hooks: ["/x/h.mjs"], strict: false }, input, { spawner: spawnerOf(0), agentDir: "/a", load: throwing });
  assert.equal(t.blocked, undefined);
  assert.equal(t.errors[0].error, "boom");
});

function adapter(t: import("node:test").TestContext, cfg: unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prebash-")));
  const saved = { dir: process.env.PI_CODING_AGENT_DIR, child: process.env.PI_SUBAGENT_CHILD };
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(async () => {
    try { await shutdown?.(); } catch { /* best effort */ }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.dir;
    if (saved.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = saved.child;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const traceDir = path.join(root, "trace");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ trace: { enabled: true, dir: traceDir }, safety: { preBash: cfg } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT_CHILD;
  const handlers = new Map<string, Handler>();
  const pi = {
    events: { on: () => undefined, emit: () => undefined },
    on: (n: string, h: Handler) => void handlers.set(n, h),
    registerCommand: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => [] as string[],
    getAllTools: () => [{ name: "bash" }],
    setActiveTools: () => undefined,
    setModel: async () => true,
    setThinkingLevel: () => undefined,
    sendMessage: () => undefined,
  };
  coreAdapter(pi as never);
  const ctx = {
    sessionManager: { getSessionId: () => "prebash-session", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] },
    cwd: project,
    model: undefined,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    isIdle: () => true,
    modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined, setWidget: () => undefined },
  };
  shutdown = async () => handlers.get("session_shutdown")?.({}, ctx);
  const traces = (): string => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else out.push(fs.readFileSync(path.join(d, e.name), "utf8"));
      }
    };
    walk(root);
    return out.join("\n");
  };
  return { root, handlers, ctx, traces, call: (command: string) => handlers.get("tool_call")!({ toolName: "bash", toolCallId: "x", input: { command } }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined> };
}

test("adapter: a module hook runs before bash and its block refuses the call (config read from safety.preBash)", async (t) => {
  const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prebash-hook-")));
  t.after(() => rmTestTmp(probe));
  const hook = path.join(probe, "hook.mjs");
  fs.writeFileSync(hook, `export default (i) => (i.command.includes("forbidden") ? { block: true, reason: "tool says no" } : undefined);\n`);
  const a = adapter(t, { hooks: [hook] });
  await a.handlers.get("session_start")!({ reason: "startup" }, a.ctx);
  const d = await a.call("echo forbidden");
  assert.equal(d?.block, true);
  assert.match(d!.reason!, /pre-bash hook .*tool says no/);
  const ok = await a.call("echo fine");
  assert.ok(!ok?.reason?.includes("pre-bash hook"), String(ok?.reason));
});

test("adapter: a failing hook is fail-open and traced; strict blocks", async (t) => {
  const probe = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prebash-hook-")));
  t.after(() => rmTestTmp(probe));
  const hook = path.join(probe, "bad.mjs");
  fs.writeFileSync(hook, `export default () => { throw new Error("broken hook"); };\n`);
  const open = adapter(t, { hooks: [hook] });
  await open.handlers.get("session_start")!({ reason: "startup" }, open.ctx);
  const r = await open.call("echo fine");
  assert.ok(!r?.reason?.includes("pre-bash hook"), String(r?.reason));
  assert.match(open.traces(), /prebash_hook_error/);
  const strict = adapter(t, { hooks: [hook], strict: true });
  await strict.handlers.get("session_start")!({ reason: "startup" }, strict.ctx);
  const s = await strict.call("echo fine");
  assert.equal(s?.block, true);
  assert.match(s!.reason!, /safety\.preBash\.strict/);
});
