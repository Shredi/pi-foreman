// pi-foreman git guard for children (design D4, layer 4).
//
// Loaded ONLY as a required child extension (the adapter registers it with pi-subagents next
// to itself); it is not in package.json `pi.extensions`. So it checks no environment variable:
// wherever it is loaded, it guards. Every bash/powershell call goes through
// `scripts/git_guard.py --mode child`; deny, ask, a missing Python, a timeout or any script
// failure block the call.
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGuardEnv } from "../core-adapter/env.ts";
import { gitGuardPayload, runGitGuard } from "../core-adapter/gitguard.ts";
import { resolvePython } from "../core-adapter/python.ts";
import type { PythonResolution } from "../core-adapter/python.ts";
import { defaultSpawner } from "../core-adapter/spawn.ts";
import type { Spawner } from "../core-adapter/spawn.ts";
import { isShellTool } from "../core-adapter/toolmap.ts";
import { evaluateRun, translateToolCall } from "../core-adapter/translate.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface GitGuardDeps {
  spawner?: Spawner;
  platform?: string;
  env?: Record<string, string | undefined>;
}

export default function gitGuard(pi: ExtensionAPI, deps: GitGuardDeps = {}): void {
  const spawner = deps.spawner ?? defaultSpawner;
  const env = deps.env ?? process.env;
  let python: Promise<PythonResolution> | undefined;

  pi.on("tool_call", async (event, ctx) => {
    if (!isShellTool(event.toolName)) return undefined;
    try {
      // The parent adapter exports PI_FOREMAN_PYTHON (its resolved interpreter) to children.
      python ??= resolvePython({ envPath: env.PI_FOREMAN_PYTHON, platform: deps.platform ?? process.platform, spawner });
      const py = await python;
      const exe = py.ok ? py.info.executable : null;
      const sessionId = ctx.sessionManager.getSessionId();
      const input = event.input as Record<string, unknown>;
      const payload = gitGuardPayload(event.toolName, input, { sessionId, cwd: ctx.cwd, home: os.homedir() });
      const guardEnv = buildGuardEnv({ base: env, coreDir: path.join(PKG_ROOT, "core"), sessionId, guard: "git_guard", markerDir: os.tmpdir() });
      const run = await runGitGuard({ python: exe, pkgRoot: PKG_ROOT, mode: "child", payload, env: guardEnv, cwd: ctx.cwd, spawner });
      const t = await translateToolCall({
        guard: "git_guard",
        outcome: evaluateRun("git_guard", run, exe),
        piTool: event.toolName,
        input,
        ask: { isChild: true, mode: ctx.mode, hasUI: false },
      });
      return t.result;
    } catch (err) {
      return { block: true, reason: `pi-foreman: git guard error before ${event.toolName} (${(err as Error).message}); the call is blocked.` };
    }
  });
}
