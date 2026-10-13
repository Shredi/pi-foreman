// R6 lane 2 security: the read only owned roots (global npm root, own children's async run dirs) are listed apart in the permission reviewer's prompt,
// count for reads only in the owned-roots allow, and the round worktrees are read-write only for the builder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ForemanReview, requestText } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { readBaseline } from "../permoverlay.ts";
import { bashRules } from "../timeoutallow.ts";
import { sessionOwnedSplit } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2ro-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cwd = path.join(base, "repo");
const npmRoot = path.join(base, "lib", "node_modules");
const asyncRun = path.join(base, "async", "run-a");
const stateScratch = path.join(base, "agent", "state", "scratch", "s1");
const round = path.join(base, "repo.worktrees", "round");
for (const d of [cwd, npmRoot, asyncRun, stateScratch, round]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(npmRoot, "pkg.json"), "{}\n");
if (posix) execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 500 } } } };
const DEFER = '{"verdict":"defer","reason":"writes outside the workspace"}';
const registry = { find: () => ({}), complete: async () => ({ content: [{ type: "text", text: DEFER }], stopReason: "stop" }) } as never as RegistryLike;
const session = (over: Partial<ReviewSession> = {}): ReviewSession => ({ isChild: false, cwd, provider: "a", config: () => config, registry, intent: "", bashRules: () => bashRules(baseline, {}), ownedRoots: () => [stateScratch, round], readOnlyRoots: () => [npmRoot, asyncRun], roundDirs: () => [round], ...over });
const ask = (command: string, agentName = "reviewer", n = 1) => ({ requestId: `r${n}`, surface: "bash", command, forwarding: true, agentName });

test("sessionOwnedSplit: the npm root and the async run dirs are read only, the rest read-write", () => {
  const got = sessionOwnedSplit({ scratch: ["/t/s/c1"], rounds: ["/w/repo.worktrees/round"], handoffs: ["/a/handoffs/h1"], npmRoot: "/n/lib/node_modules", stateScratch: "/a/state/scratch/s1", asyncRuns: ["/t/async/run-a"] }, "linux");
  assert.deepEqual(got.write, ["/t/s/c1", "/w/repo.worktrees/round", "/w/repo.worktrees/worktrees/round", "/a/handoffs/h1", "/a/state/scratch/s1"]);
  assert.deepEqual(got.read, ["/n/lib/node_modules", "/t/async/run-a"]);
});

test("the prompt lists the read only roots apart from the read-write ones", () => {
  const text = requestText(ask("ls"), "bash", session(), "n0nce");
  const [rw, ro] = text.split("## Owned roots, read only");
  assert.ok(rw.includes(`- ${stateScratch}`) && !rw.includes(npmRoot));
  assert.ok(ro.includes(`- ${npmRoot}`) && ro.includes(`- ${asyncRun}`));
  assert.match(ro, /owned, read only/);
});

test("a forwarded child write into the npm root stays a defer; a read of it and a write into own scratch are allowed", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session());
  assert.deepEqual(await r.authorize("s", ask(`touch ${npmRoot}/pkg.json`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`echo x > ${npmRoot}/new.txt`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`touch ${asyncRun}/x`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`cat ${npmRoot}/pkg.json`)), { kind: "allow" });
  assert.deepEqual(await r.authorize("s", ask(`touch ${stateScratch}/a.txt`)), { kind: "allow" });
});

test("a round worktree is read-write only for the builder", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session());
  assert.deepEqual(await r.authorize("s", ask(`touch ${round}/a.txt`, "builder")), { kind: "allow" });
  assert.deepEqual(await r.authorize("s", ask(`touch ${round}/a.txt`, "reviewer", 2)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`cat ${round}/a.txt`, "reviewer", 3)), { kind: "allow" });
});
