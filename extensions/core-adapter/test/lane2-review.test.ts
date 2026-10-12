// R6 lane 2a, 2f (builders) and 2g: the owned roots in the permission reviewer's prompt, the deterministic defer -> allow for a command that stays
// inside them, the builders of the owned and readable roots, and a session-wide allow that holds for every fresh reviewer child.
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
import { childReadable, sessionOwnedRoots } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane2r-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cwd = path.join(base, "repo");
const asyncRun = path.join(base, "async-subagent-runs", "run-a");
const stateScratch = path.join(base, "agent", "pi-foreman", "state", "scratch", "s1");
for (const d of [cwd, asyncRun, stateScratch]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(asyncRun, "status.json"), "{}\n");
if (posix) execFileSync("git", ["init", "-q", cwd], { stdio: "ignore" });
const owned = [asyncRun, stateScratch];
const nonOwned = "/usr/local/pf-not-owned/b.txt";

const config = { providers: { a: { review: { model: "a/small", timeoutMs: 500 } } } };
const sent: { system: string; text: string }[] = [];
const reply = (text: string): RegistryLike => ({
  find: () => ({}),
  complete: async (_m: unknown, c: { systemPrompt: string; messages: { content: string }[] }) => {
    sent.push({ system: c.systemPrompt, text: c.messages[0].content });
    return { content: [{ type: "text", text }], stopReason: "stop" };
  },
}) as never;
const session = (registry: RegistryLike, over: Partial<ReviewSession> = {}): ReviewSession => ({ isChild: false, cwd, provider: "a", config: () => config, registry, intent: "", bashRules: () => bashRules(baseline, {}), ownedRoots: () => owned, ...over });
const ask = (command: string, n = 1) => ({ requestId: `r${n}`, surface: "bash", command, forwarding: true, agentName: "reviewer" });
const DEFER = '{"verdict":"defer","reason":"writes into a scratch directory under the run dir which is outside the workspace"}';

test("2a: the prompt lists the owned roots as owned, allow reads and writes", () => {
  const text = requestText(ask("ls"), "bash", session(reply(DEFER)), "n0nce");
  assert.match(text, /## Owned roots \(owned — allow reads and writes\)/);
  for (const o of owned) assert.ok(text.includes(`- ${o}`), o);
  assert.doesNotMatch(requestText(ask("ls"), "bash", session(reply(DEFER), { ownedRoots: undefined }), "n0nce"), /Owned roots/);
});

test("2a: the system prompt tells the model owned roots are never a reason to defer", async () => {
  sent.length = 0;
  const r = new ForemanReview();
  r.upsert("s", session(reply(DEFER)));
  await r.authorize("s", ask("ls /usr/local"));
  assert.match(sent[0].system, /owned roots/);
  assert.match(sent[0].text, /Owned roots/);
});

test("2a: a defer for a command inside the owned roots is allowed (the literal 'scratch directory under <owned> which is outside' shape)", async () => {
  const r = new ForemanReview();
  const traced: Record<string, unknown>[] = [];
  r.upsert("s", session(reply(DEFER), { trace: (x) => void traced.push(x) }));
  assert.deepEqual(await r.authorize("s", ask(`cat ${asyncRun}/status.json`)), { kind: "allow" });
  assert.deepEqual(await r.authorize("s", ask(`mkdir -p ${stateScratch}/d && touch ${stateScratch}/d/a.txt`)), { kind: "allow" });
  assert.equal(traced.at(-1)?.decision, "owned-roots");
  // the foreman's own read of its child's async run dir does not ask either (non-forwarded ask)
  assert.deepEqual(await r.authorize("s", { requestId: "r9", surface: "bash", command: `ls ${asyncRun}` }), { kind: "allow" });
});

test("2a: without owned roots, or with one non-owned path or write target, the defer stays", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session(reply(DEFER), { ownedRoots: () => [] }));
  assert.deepEqual(await r.authorize("s", ask(`cat ${asyncRun}/status.json`)), { kind: "defer" });
  r.upsert("s", session(reply(DEFER)));
  assert.deepEqual(await r.authorize("s", ask(`touch ${stateScratch}/a.txt ${nonOwned}`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`touch ${nonOwned}`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`cp ${asyncRun}/status.json ${nonOwned}`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`echo x > ${nonOwned}`)), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", ask(`cat ${asyncRun}/status.json > ${nonOwned}`)), { kind: "defer" });
});

test("2a: /tmp is not an owned root: a defer for a command writing /tmp stays a defer", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session(reply(DEFER)));
  // non-forwarded: the pre-model tmp allows (touch/mkdir/redirect under /tmp) do not run, so only the owned-roots path can turn the defer into an allow
  assert.deepEqual(await r.authorize("s", { ...ask("touch /tmp/pf-lane2-x"), forwarding: false }), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", { ...ask(`touch ${stateScratch}/a.txt /tmp/pf-lane2-x`), forwarding: false }), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", { ...ask(`touch ${stateScratch}/a.txt`), forwarding: false }), { kind: "allow" });
});

test("2a: a deny (hard or soft) is never turned into an allow", async () => {
  const r = new ForemanReview();
  r.upsert("s", session(reply('{"verdict":"deny","reason":"x","riskLevel":"high"}')));
  assert.equal((await r.authorize("s", ask(`cat ${asyncRun}/status.json`))).kind, "deny");
  r.upsert("s", session(reply('{"verdict":"deny","reason":"x","riskLevel":"low"}')));
  assert.deepEqual(await r.authorize("s", ask(`cat ${asyncRun}/status.json`)), { kind: "defer" });
});

test("2a: a command the rules deny or ask about is not allowed by the owned roots", async () => {
  const r = new ForemanReview();
  r.upsert("s", session(reply(DEFER)));
  for (const c of [`rm -rf ${asyncRun}`, `git push origin main`, `curl http://example.invalid/x -o ${stateScratch}/x`]) assert.notDeepEqual(await r.authorize("s", ask(c)), { kind: "allow" }, c);
});

test("2a: sessionOwnedRoots lists scratch, round and isolation worktrees, handoffs, npm root, state scratch and own async runs", () => {
  const rt = path.resolve("/w/repo.worktrees/round");
  const got = sessionOwnedRoots({ scratch: ["/t/s/c1"], rounds: [rt], handoffs: ["/a/handoffs/h1"], npmRoot: "/n/lib/node_modules", stateScratch: "/a/state/scratch/s1", asyncRuns: new Set(["/t/async/run-a", "relative/run-b", "/a/handoffs/h1"]) }, "linux");
  assert.deepEqual(got, ["/t/s/c1", rt, "/w/repo.worktrees/worktrees/round", "/a/handoffs/h1", "/n/lib/node_modules", "/a/state/scratch/s1", "/t/async/run-a"]);
  assert.deepEqual(sessionOwnedRoots({ scratch: [], rounds: [], handoffs: [] }, "linux"), []);
});

test("2f: childReadable names the bound ledger, its LEDGER-*.md siblings, the handoff dirs and the round worktrees", () => {
  const got = childReadable("/m/.workflow/LEDGER-r.md", ["/a/handoffs/h1"], ["/w/repo.worktrees/round"], "linux");
  assert.deepEqual(got, ["/m/.workflow/LEDGER-r.md", "/m/.workflow/LEDGER-*.md", "/a/handoffs/h1", "/a/handoffs/h1/*", "/w/repo.worktrees/round", "/w/repo.worktrees/round/*"]);
  assert.deepEqual(childReadable(null, [], [], "linux"), []);
});

test("2g: a session-wide allow holds for every fresh reviewer child of the session (the review link is keyed by the session, not the child)", async () => {
  const r = new ForemanReview();
  r.upsert("s", session(reply(DEFER)));
  const first = await r.authorize("s", { ...ask(`cat ${asyncRun}/status.json`, 1), agentName: "reviewer" });
  const second = await r.authorize("s", { ...ask(`cat ${asyncRun}/status.json`, 2), agentName: "reviewer" });
  const third = await r.authorize("s", { ...ask(`ls ${asyncRun}`, 3), agentName: "reviewer", surface: "bash" });
  assert.deepEqual([first, second, third], [{ kind: "allow" }, { kind: "allow" }, { kind: "allow" }]);
});
