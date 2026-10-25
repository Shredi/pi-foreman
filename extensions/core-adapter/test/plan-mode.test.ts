// Round 41 item 18 (A6): plan mode lets a read-only explorer launch pass the ledger gate without a ledger and lets the session write
// under `.workflow/` only. Real core ledger_guard_spawn.py (skipped without Python >= 3.13 or the core), the real translate.ts helpers
// that index.ts:2295 wires, and the real edit-mode check.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { editModeBlock } from "../editmode.ts";
import { buildGuardEnv } from "../env.ts";
import { preToolPayload, subagentAgents } from "../payload.ts";
import { resolvePython } from "../python.ts";
import { runGuard } from "../runguard.ts";
import { defaultSpawner } from "../spawn.ts";
import { evaluateRun, planModeOn, spawnPermissionMode, translateToolCall } from "../translate.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const coreDir = [process.env.PI_FOREMAN_TEST_CORE, path.join(repo, "core")].find((d) => d && fs.existsSync(path.join(d, "scripts", "ledger_guard_spawn.py")));
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !coreDir ? "no core checkout" : !py.ok ? "no Python >= 3.13" : false;

const entry = (enabled: boolean) => ({ type: "custom", customType: "plan-mode", data: { enabled } });
const LONG = "Research the module layout and report back. ".repeat(80);

/** The spawn gate as index.ts runs it: payload with prompt and permission_mode, the real guard, the real translation. */
async function launch(agents: string[], planMode: boolean): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-"));
  try {
    const input = { agent: agents[0], tasks: agents.slice(1).map((agent) => ({ agent })), task: LONG };
    const names = subagentAgents(input);
    const python = py.ok ? py.info.executable : null;
    const env = buildGuardEnv({ base: process.env, coreDir: coreDir!, sessionId: "plan-test", guard: "ledger_guard_spawn", markerDir: dir, threshold: 100 });
    const payload = preToolPayload("subagent", input, { sessionId: "plan-test", cwd: dir, home: os.homedir() });
    (payload.tool_input as Record<string, unknown>).prompt = LONG;
    payload.permission_mode = spawnPermissionMode(planMode, names);
    const run = await runGuard({ python, coreDir: coreDir!, guard: "ledger_guard_spawn", payload, env, cwd: dir, spawner: defaultSpawner });
    const t = await translateToolCall({ guard: "ledger_guard_spawn", outcome: evaluateRun("ledger_guard_spawn", run, python), piTool: "subagent", input, ask: { isChild: false, mode: "print", hasUI: false } });
    return t.result?.block !== true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("planModeOn: the latest plan-mode entry on the branch decides", () => {
  assert.equal(planModeOn([]), false);
  assert.equal(planModeOn([entry(true)]), true);
  assert.equal(planModeOn([entry(true), entry(false)]), false);
  assert.equal(planModeOn([entry(false), { type: "message" }, entry(true)]), true);
  assert.equal(planModeOn([{ type: "custom", customType: "other", data: { enabled: true } }]), false);
  assert.equal(planModeOn([{ type: "custom", customType: "plan-mode", data: {} }]), false);
});

test("spawnPermissionMode: plan only in plan mode and only for explorer-only launches", () => {
  assert.equal(spawnPermissionMode(true, ["explorer"]), "plan");
  assert.equal(spawnPermissionMode(true, ["explorer", "explorer"]), "plan");
  assert.equal(spawnPermissionMode(true, ["builder"]), "default");
  assert.equal(spawnPermissionMode(true, ["explorer", "builder"]), "default");
  assert.equal(spawnPermissionMode(true, []), "default");
  assert.equal(spawnPermissionMode(false, ["explorer"]), "default");
  assert.equal(spawnPermissionMode(false, ["builder"]), "default");
});

test("plan mode: an explorer-only launch passes the ledger gate without a ledger", { skip }, async () => {
  assert.equal(await launch(["explorer"], true), true);
  assert.equal(await launch(["explorer", "explorer"], true), true);
});

test("plan mode: a builder or mixed launch still needs the ledger", { skip }, async () => {
  assert.equal(await launch(["builder"], true), false);
  assert.equal(await launch(["explorer", "builder"], true), false);
});

test("outside plan mode nothing changes: the same explorer launch is denied without a ledger", { skip }, async () => {
  assert.equal(await launch(["explorer"], false), false);
  assert.equal(await launch(["builder"], false), false);
});

test("plan mode: a .workflow/ write passes the edit-mode check, a project-file write does not", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-plan-ws-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow", "src"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const opts = { cwd: ws, home: root, platform: process.platform };
  assert.equal(editModeBlock("write", { path: ".workflow/plan.md" }, "readonly", ".workflow/scratch", opts), "");
  assert.equal(editModeBlock("edit", { path: ".workflow/plan.md" }, "readonly", ".workflow/scratch", opts), "");
  assert.match(editModeBlock("write", { path: "src/a.ts" }, "readonly", ".workflow/scratch", opts) ?? "", /refused/);
  assert.match(editModeBlock("edit", { path: "src/a.ts" }, "readonly", ".workflow/scratch", opts) ?? "", /refused/);
});
