// R5 P2 S2 (ledger 11, R1 + k): the permission link resolves reads below owned READ roots without a dialog: the main checkout's .workflow
// for a forwarded child, the foreman's own subagent run dirs for the foreman; writes there are never allowed by it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { asyncRunDirs, mainWorkflowReadable } from "../roundsurface.ts";
import { bashRules } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-link-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const uidDir = path.join(base, "pi-subagents-uid-501");
const run = path.join(uidDir, "async-subagent-runs", "abc123");
const results = path.join(uidDir, "async-subagent-results");
for (const d of [path.join(main, ".git"), path.join(main, ".workflow"), rt, run, results]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(main, ".workflow", "LEDGER-x.md"), "- [ ] 1. a\n");
fs.writeFileSync(path.join(rt, ".git"), "gitdir: x\n");
fs.writeFileSync(path.join(main, ".workflow", "notes.md"), "n\n");
fs.writeFileSync(path.join(run, "status.json"), "{}\n");
fs.writeFileSync(path.join(results, "abc123.json"), "{}\n");
const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const session = (extra: Partial<ReviewSession>): ReviewSession => ({ isChild: false, cwd: rt, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ...extra });

test("asyncRunDirs: the run dir of a recorded file and the uid dir's results dir, nothing else", { skip: !posix }, () => {
  assert.deepEqual(asyncRunDirs([path.join(run, "status.json"), "/x/other/file"], "linux").sort(), [results, run].sort());
  assert.deepEqual(asyncRunDirs([path.join(results, "abc123.json")], "linux"), [results]);
  assert.deepEqual(asyncRunDirs(["/home/u/pi-subagents-notuid/async-subagent-runs/r/x"], "linux"), []);
});

test("a forwarded child's read-tool ask below <main>/.workflow is allowed, a write ask and the rest of main are not", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session({ roundDirs: () => [rt] }));
  assert.deepEqual(mainWorkflowReadable([rt], "linux").length, 2);
  const ask = (surface: string, value: string, agentName = "reviewer") => r.authorize("s", { requestId: "r", surface, agentName, forwarding: true, value, toolName: "read" });
  for (const role of ["builder", "reviewer", "scout"]) assert.deepEqual(await ask("external_directory_read", path.join(main, ".workflow", "LEDGER-x.md"), role), { kind: "allow" }, role);
  for (const role of ["builder", "reviewer"]) assert.deepEqual(await ask("bash", `cat ${path.join(main, ".workflow", "notes.md")}`, role), { kind: "allow" }, `bash ${role}`);
  assert.notEqual((await ask("bash", `echo x > ${path.join(main, ".workflow", "notes.md")}`)).kind, "allow");
  assert.notEqual((await ask("external_directory", path.join(main, ".workflow", "LEDGER-x.md"))).kind, "allow", "a write-capable ask");
  assert.notEqual((await ask("external_directory_read", path.join(main, "other.txt"))).kind, "allow");
  assert.notEqual((await ask("external_directory_read", path.join(main, ".workflow", "..", "other.txt"))).kind, "allow");
  assert.notEqual((await ask("external_directory_read", path.join(main, ".workflow", "*"))).kind, "allow");
});

test("the foreman's own run dirs are an owned read root: read tool ask and bash cat pass, writes do not", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session({ cwd: main, readOnlyRoots: () => [run, results] }));
  const ask = (surface: string, value: string, toolName = "read") => r.authorize("s", { requestId: "r", surface, agentName: "foreman", value, toolName });
  assert.deepEqual(await ask("external_directory_read", path.join(run, "status.json")), { kind: "allow" });
  assert.deepEqual(await ask("external_directory_read", path.join(results, "abc123.json")), { kind: "allow" });
  assert.deepEqual(await ask("bash", `cat ${path.join(run, "status.json")}`, "bash"), { kind: "allow" });
  assert.notEqual((await ask("external_directory", path.join(run, "status.json"))).kind, "allow", "a write-capable ask");
  assert.notEqual((await ask("bash", `echo x > ${path.join(run, "status.json")}`, "bash")).kind, "allow");
  assert.notEqual((await ask("bash", `rm ${path.join(results, "abc123.json")}`, "bash")).kind, "allow");
  assert.notEqual((await ask("external_directory_read", path.join(base, "elsewhere", "x"))).kind, "allow");
});
