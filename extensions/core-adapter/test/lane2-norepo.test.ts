// r9 item 3 (Windows CI ids 453, 460): the lane-2 fixture ran `git init` on POSIX only, so on win32 its cwd was no repository; the
// owned-roots allow then refused every reader, as a program run from a cwd outside the allowed places reads there. This pins that
// cause on every host: the same owned read from a non-repository cwd stays a defer, from a repository cwd it is allowed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { bashPath } from "./_bashpath.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { readBaseline } from "../permoverlay.ts";
import { bashRules } from "../timeoutallow.ts";
import { workspaceTop } from "../gitdrift.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const base = fs.realpathSync.native(mkTestTmp("pf-lane2n-"));
after(() => rmTestTmp(base));
const noRepo = path.join(base, "plain");
const repo = path.join(base, "repo");
const asyncRun = path.join(base, "async-subagent-runs", "run-a");
for (const d of [noRepo, path.join(repo, ".git"), asyncRun]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(asyncRun, "status.json"), "{}\n");

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 500 } } } };
const DEFER = '{"verdict":"defer","reason":"reads a run dir outside the workspace"}';
const registry = { find: () => ({}), complete: async () => ({ content: [{ type: "text", text: DEFER }], stopReason: "stop" }) } as unknown as RegistryLike;
const session = (cwd: string): ReviewSession => ({ isChild: false, cwd, provider: "a", config: () => config, registry, intent: "", bashRules: () => bashRules(baseline, {}), ownedRoots: () => [asyncRun], childDefer: () => "owner" });

test("2a: cat <owned>/status.json from a cwd outside any repository stays a defer; from a repository cwd it is allowed", async () => {
  if (workspaceTop(noRepo) !== null) return; // the temp base itself lies in a repository: no non-repository cwd to test
  const r = new ForemanReview();
  const ask = { requestId: "r1", surface: "bash", command: `cat ${bashPath(asyncRun)}/status.json`, forwarding: true, agentName: "reviewer" };
  r.upsert("n", session(noRepo));
  assert.deepEqual(await r.authorize("n", ask), { kind: "defer" });
  r.upsert("y", session(repo));
  assert.deepEqual(await r.authorize("y", { ...ask, requestId: "r2" }), { kind: "allow" });
});
