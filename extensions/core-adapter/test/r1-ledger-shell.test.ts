// R1 (ledger item 67): a ledger bound through the adapter's own handlers is the ledger that
// `ledger status` sees from a shell tool, whose env is only PI_SESSION_ID plus what the adapter
// put into process.env. The adapter never exports TMPDIR into process.env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import coreAdapter from "../index.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.9" : false;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

test("R1: ledger bound via the adapter is what `ledger status` sees from a shell", { skip }, async () => {
  const keys = ["PATH", "Path", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_CODING_AGENT_DIR", "TMPDIR"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-r1-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".workflow"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (name: string, h: Handler) => void handlers.set(name, h),
      registerCommand: () => undefined,
      getActiveTools: () => [] as string[],
      setActiveTools: () => undefined,
      setModel: async () => true,
      setThinkingLevel: () => undefined,
    };
    coreAdapter(pi as never);
    const sid = "r1-session-0001";
    const ctx = {
      sessionManager: { getSessionId: () => sid, getSessionFile: () => undefined },
      cwd: project,
      model: undefined,
      mode: "print",
      hasUI: false,
      isProjectTrusted: () => false,
      modelRegistry: { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }) },
      ui: { notify: () => undefined, confirm: async () => false },
    };
    const tmpdirBefore = process.env.TMPDIR;
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    assert.equal(process.env.TMPDIR, tmpdirBefore, "the adapter must not export TMPDIR");

    // The session writes its ledger (the write tool's effect), then the adapter's post hook binds it.
    const ledger = path.join(project, ".workflow", "LEDGER-r1.md");
    const content = "# Requirements Ledger: r1\n\n- [ ] 1. synthetic open item\n";
    fs.writeFileSync(ledger, content);
    await handlers.get("tool_result")!({ toolName: "write", toolCallId: "t1", input: { path: ".workflow/LEDGER-r1.md", content }, content: [], isError: false }, ctx);
    assert.equal(process.env.TMPDIR, tmpdirBefore, "the adapter must not export TMPDIR");

    // Exactly what a Pi shell tool adds on top of process.env, restricted to the adapter's keys.
    const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const shellEnv: Record<string, string> = {
      PI_SESSION_ID: sid,
      [pathKey]: process.env[pathKey]!,
      PI_FOREMAN_PYTHON: process.env.PI_FOREMAN_PYTHON!,
      PI_FOREMAN_STATE_DIR: process.env.PI_FOREMAN_STATE_DIR!,
    };
    assert.equal(shellEnv.PI_FOREMAN_STATE_DIR, path.join(agentDir, "pi-foreman", "state"));
    assert.ok(shellEnv[pathKey].split(path.delimiter)[0] === path.join(repo, "bin"), "bin/ is first on PATH");
    let r;
    if (process.platform === "win32") {
      for (const k of ["SystemRoot", "COMSPEC", "PATHEXT"]) if (process.env[k]) shellEnv[k] = process.env[k]!;
      r = spawnSync(process.env.COMSPEC ?? "cmd.exe", ["/d", "/c", "ledger status"], { cwd: project, env: shellEnv, encoding: "utf8", timeout: 20_000 });
    } else {
      r = spawnSync("/bin/sh", ["-c", "ledger status"], { cwd: project, env: shellEnv, encoding: "utf8", timeout: 20_000 });
    }
    assert.equal(r.status, 0, `ledger status failed: ${r.stderr}`);
    assert.match(r.stdout, /LEDGER-r1\.md: 1 open item\(s\)/);
    await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
