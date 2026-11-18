import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatWaits, readAddonTasks } from "../bg.ts";
import { ownTaskReadable } from "../roundsurface.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-own-bg-")));
const ws = path.join(w, "ws");
const own = path.join(ws, ".pi", "tasks", "sess-own-4321");
fs.mkdirSync(own, { recursive: true });

test("bg_status, bg_logs and bg_kill carry a tool-level allow in the baseline (no permission dialog)", () => {
  const tools = (JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { tools: Record<string, string> }).tools;
  for (const t of ["bg_status", "bg_logs", "bg_kill", "bg_wait"]) assert.equal(tools[t], "allow", t);
});

test("ownTaskReadable: an empty session id gives no readable task pattern", () => {
  assert.deepEqual(ownTaskReadable([ws], "", process.platform), []);
});

test("readAddonTasks offers the output path relative to the worktree, and /foreman waits prints it", () => {
  fs.writeFileSync(path.join(own, "t1.json"), JSON.stringify({ id: "t1", command: "x", status: "running", startTime: Date.now(), outputPath: path.join(".pi", "tasks", "sess-own-4321", "t1.output") }));
  fs.writeFileSync(path.join(own, "t1.output"), "a\nb\n");
  const t = readAddonTasks(ws).find((x) => x.id === "t1")!;
  assert.equal(t.log, ".pi/tasks/sess-own-4321/t1.output");
  assert.match(formatWaits([], [t]), /\n  \| b\n  log \.pi\/tasks\/sess-own-4321\/t1\.output$/);
});
