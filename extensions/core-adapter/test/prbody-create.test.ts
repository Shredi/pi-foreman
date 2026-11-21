// pr_create and the `## Reviews` block (gitpack.ts, prbody.ts): the body the host op receives has the block of the newest PASS on the head; no PASS, no change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import { BODY_MAX_BYTES, REVIEWS_CLOSE, REVIEWS_OPEN, bodyWithReviews, mergeReviewsBlock, reviewFactsFor, reviewsBlock, reviewsLine } from "../prbody.ts";
import type { ReviewRecord } from "../reviews.ts";
import type { Spawner } from "../spawn.ts";

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
const URL = "https://ghe.example.com/acme/app/pull/12";
const out = (o: Record<string, unknown>) => ({ code: 0, stdout: JSON.stringify(o) + "\n", stderr: "", timedOut: false });
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-prbody-")));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

const prePass = (extra: Partial<ReviewRecord> = {}): ReviewRecord => ({ role: "reviewer", verdict: "pass", head: HEAD, kind: "code", occasion: "pre-pr", run: "run-9", suites: [{ command: "npm test", result: "pass" }], ...extra });

function setup(records: ReviewRecord[]) {
  const tools = new Map<string, Tool>();
  const bodies: unknown[] = [];
  const spawner: Spawner = async (_c, _a, opt) => {
    const req = JSON.parse(opt.input ?? "{}") as { op: string; args: Record<string, unknown> };
    bodies.push(req.args.body);
    return out({ ok: true, action: "pr_create", number: 12, url: URL, head: "feat", base: "main" });
  };
  const watches = new PrWatches({ storeEntry: () => ({ kind: "waiting" }), githubHosts: () => ({ hosts: ["ghe.example.com"] }), send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 60_000, now: () => 0, timers: { set: () => 1, clear: () => {} } });
  const session: PrPackSession = {
    python: "/py", isChild: false, packOn: true, config: { prHost: "auto" }, gateOn: false, reviewed: async () => [], records: async () => records, watches, trace: () => {},
    tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "ghe.example.com", repo: "acme/app" }) },
    track: async () => "added", githubHosts: () => ({ hosts: ["ghe.example.com"] }),
  };
  registerPrPack({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, { isChild: false, session: async () => session, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
  const create = (body: string) => tools.get("pr_create")!.execute("id", { title: "T", body }, undefined, undefined, { cwd: repo });
  return { create, bodies, watches };
}

test("a PASS on the head: the body gets the block appended, the lines before it untouched, and the watch is seeded", async () => {
  const x = setup([prePass()]);
  const r = await x.create("## Summary\n\nDid it.");
  assert.equal(x.bodies[0], `## Summary\n\nDid it.\n\n## Reviews\n\n${reviewsBlock(reviewFactsFor([prePass()], HEAD)!)}\n`);
  assert.match(String(x.bodies[0]), /Pre-pr review: PASS on [0-9a-f]{7} \(run run-9; suites: `npm test` \(pass\)\)/);
  assert.deepEqual(x.watches.records()[0].bodyMark, { head: HEAD, run: "run-9" });
  assert.equal(x.watches.records()[0].opened, true);
  assert.match(r.content[0].text, /`## Reviews` line/);
});

test("the markers already in the body: only the text between them is replaced", async () => {
  const x = setup([prePass()]);
  await x.create(`before\n${REVIEWS_OPEN}\nold\n${REVIEWS_CLOSE}\nafter`);
  const body = String(x.bodies[0]);
  assert.ok(body.startsWith("before\n" + REVIEWS_OPEN + "\nPre-pr review: PASS"));
  assert.ok(body.endsWith(REVIEWS_CLOSE + "\nafter"));
  assert.equal(body.includes("old"), false);
});

test("no PASS on the head: the body is sent unchanged and no pair is seeded", async () => {
  for (const records of [[], [prePass({ verdict: "fail" })], [prePass({ head: "f".repeat(40) })], [prePass(), prePass({ verdict: "fail", run: "run-10" })], [prePass({ kind: "plan" })]]) {
    const x = setup(records);
    await x.create("plain body");
    assert.equal(x.bodies[0], "plain body");
    assert.equal(x.watches.records()[0].bodyMark, undefined);
  }
});

test("a body that would pass the cap with the block is sent unchanged and the result says so", async () => {
  const x = setup([prePass()]);
  const big = "x".repeat(BODY_MAX_BYTES - 10);
  const r = await x.create(big);
  assert.equal(x.bodies[0], big);
  assert.match(r.content[0].text, /not written: the body with it would be over 65536 bytes/);
});

test("the unit pieces: line forms, merge and cap", () => {
  assert.equal(reviewsLine({ head: HEAD, occasion: "pre-pr", run: "r" }), `Pre-pr review: PASS on ${HEAD.slice(0, 7)} (run r; suites: none named)`);
  assert.equal(reviewsLine({ head: HEAD, occasion: "item" }), `Review: PASS (item) on ${HEAD.slice(0, 7)}`);
  assert.equal(reviewsLine({ head: HEAD, run: "bad run<!--" }), `Review: PASS on ${HEAD.slice(0, 7)}`);
  assert.equal(mergeReviewsBlock("", "B"), "## Reviews\n\nB\n");
  assert.deepEqual(bodyWithReviews("b", null), { body: "b", written: false, capped: false });
  assert.equal(bodyWithReviews("b", { head: HEAD }).written, true);
});
