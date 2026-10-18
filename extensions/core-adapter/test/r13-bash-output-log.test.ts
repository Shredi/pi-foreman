// R13 item 5 (hub 280): Pi's truncated bash output log (details.fullOutputPath of a bash tool_result) is readable with read-only verbs
// by the session that produced it; another session's log and every write stay as they were.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { dialogFamily } from "../dialogs.ts";
import { bashOutputLogs } from "../roundsurface.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules } from "../timeoutallow.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r13-bashlog-")));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, ag]) fs.mkdirSync(d, { recursive: true });
const mine = path.join(w, "pi-bash-0123456789abcdef.log");
const theirs = path.join(w, "pi-bash-fedcba9876543210.log");

after(() => fs.rmSync(w, { recursive: true, force: true }));
fs.mkdirSync(path.join(ws, ".git"));
for (const f of [mine, theirs]) fs.writeFileSync(f, "x\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ctx = (role: "main" | "child", logs: string[]): MatchCtx => ({ cwd: ws, home, platform: process.platform, role, ownTasks: bashOutputLogs(logs) });
const sh = (role: "main" | "child", command: string, logs: string[]): string => checkToolCall(rules, "bash", { command }, ctx(role, logs))?.kind ?? "pass";

test("r13 bash log: the R12 line passes for the session that recorded the path, for read-only verbs", () => {
  for (const role of ["main", "child"] as const) {
    assert.equal(sh(role, `cut -c1-600 ${mine} | head -40`, [mine]), "pass", role);
    assert.equal(sh(role, `tail -c 2500 ${mine}`, [mine]), "pass", role);
    assert.equal(sh(role, `grep -n error ${mine}`, [mine]), "pass", role);
  }
});

const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const rules2 = bashRules(baseline, {});
const reviewed = (logs: string[]): ForemanReview => {
  const r = new ForemanReview();
  const s: ReviewSession = { isChild: false, cwd: ws, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules2, readOnlyRoots: () => bashOutputLogs(logs) };
  r.upsert("s", s);
  return r;
};
const askBash = (r: ForemanReview, value: string) => r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash" });

test("r13 bash log: the permission link allows the R12 line for the recorded path only", async () => {
  assert.deepEqual(await askBash(reviewed([mine]), `cut -c1-600 ${mine} | head -40`), { kind: "allow" });
  assert.notEqual((await askBash(reviewed([mine]), `cut -c1-600 ${theirs} | head -40`)).kind, "allow");
  assert.notEqual((await askBash(reviewed([]), `cut -c1-600 ${mine} | head -40`)).kind, "allow");
  assert.notEqual((await askBash(reviewed([mine]), `cut -c1-600 ${mine} ${theirs}`)).kind, "allow");
  assert.notEqual((await askBash(reviewed([mine]), `echo x > ${mine}`)).kind, "allow");
  assert.notEqual((await askBash(reviewed([mine]), `rm ${mine}`)).kind, "allow");
});

test("r13 bash log: bashOutputLogs keeps only absolute pi-bash-<hex>.log paths", () => {
  assert.deepEqual(bashOutputLogs([mine, "/tmp/other.txt", "pi-bash-1.log", `${w}/../etc/pi-bash-1.log`, `${w}/*/pi-bash-1.log`]), [mine]);
});

test("r13 bash log: dialog family own bash output log", () => {
  assert.equal(dialogFamily(`cut -c1-600 ${mine} | head -40`), "own_bash_output_log");
});
