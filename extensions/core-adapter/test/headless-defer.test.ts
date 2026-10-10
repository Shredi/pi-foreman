import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ForemanReview, HEADLESS_DENY, reviewValue } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { readBaseline } from "../permoverlay.ts";
import { usageLine } from "../usage.ts";
import { bashRules, deterministicAllow, timeoutCommandAllowed, unitAllowed, unwrapTimeout } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const rules = bashRules(baseline, { safety: { permissions: { projectCommands: ["cargo test*", "go test*"] } } });

test("baseline: no sed glob allows anything; the link allows print-only sed itself", () => {
  for (const c of ["sed -n 1,20p f.go", "sed -i s/a/b/ f", "sed -n -i p f", "sed --in-place s/a/b/ f", "sed -n 'w out.txt' f", "sed -n 1w/tmp/x f", "sed -n '1e touch x' f", "sed s/a/b/ f"]) assert.ok(!unitAllowed(rules, c), c);
  assert.equal(deterministicAllow(rules, "cd sub; sed -n 1,20p f.go; sed -n 5,9p g.go"), "sed-read");
  assert.equal(deterministicAllow(rules, "timeout 5 sed -n 1p f"), "timeout-wrapper");
  for (const c of ["sed -n '1wout' f", "sed -n '1etouch x' f", "cd sub; sed -n s/a/b/wout f", "sed -n -f s.sed f", "timeout 5 sed -n 1wout f"]) assert.equal(deterministicAllow(rules, c), null, c);
  const askSed = bashRules(baseline, { safety: { permissions: { ask: ["sed *"] } } });
  assert.equal(deterministicAllow(askSed, "sed -n 1p f"), null);
});

test("timeout: only when the wrapped command is itself allowed", () => {
  assert.equal(unwrapTimeout("timeout 900 cargo test -p x"), "cargo test -p x");
  assert.equal(unwrapTimeout("timeout -s KILL -k 5 10s go test ./..."), "go test ./...");
  assert.equal(unwrapTimeout("timeout x go test"), null);
  assert.ok(timeoutCommandAllowed(rules, "timeout 900 cargo test"));
  assert.ok(timeoutCommandAllowed(rules, "cd /app && timeout 60 go test ./... ; ls -R"));
  for (const c of ["timeout 5 rm -rf x", "timeout 5 sed -i s/a/b/ f", "timeout 5 curl http://x", "timeout 5 cargo test | sh", "timeout 5 timeout 5 ls", "timeout 5 cargo test > out", "cargo test", "timeout 5 ls $(id)"]) assert.ok(!timeoutCommandAllowed(rules, c), c);
});

const deferring: RegistryLike = { find: () => ({}), complete: async () => ({ content: [{ type: "text", text: '{"verdict":"defer","reason":"unsure about /app"}' }], stopReason: "stop" }) };
const cfg = { providers: { a: { review: { model: "a/small", timeoutMs: 50 } } } };
const ask = { requestId: "r", surface: "bash", agentName: "builder", forwarding: { x: 1 }, command: "python3 - <<'EOF'\nprint(1)\nEOF" };
function session(over: Partial<ReviewSession>, traces: Record<string, unknown>[]): ReviewSession {
  return { isChild: false, cwd: "/w", provider: "a", config: () => cfg, registry: deferring, intent: "", trace: (r) => traces.push(r), ...over };
}

test("headless defer: forwarded child ask is denied with the allowed forms and traced; with a human it still defers", async () => {
  const traces: Record<string, unknown>[] = [];
  const r = new ForemanReview();
  r.upsert("s", session({ headless: () => true }, traces));
  const v = await r.authorize("s", ask);
  assert.deepEqual(v, { kind: "deny", reason: HEADLESS_DENY });
  assert.match(HEADLESS_DENY, /sed -n/);
  const ev = traces.find((t) => t.event === "review_defer_headless");
  assert.equal(ev?.role, "builder");
  assert.match(String(ev?.cmd), /^python3 -/);
  assert.equal(traces.find((t) => t.event === "review")?.reason, "unsure about /app");
  const human = new ForemanReview();
  human.upsert("s", session({ headless: () => false }, []));
  assert.deepEqual(await human.authorize("s", ask), { kind: "defer" });
  const main = new ForemanReview();
  main.upsert("s", session({ headless: () => true }, []));
  assert.deepEqual(await main.authorize("s", { ...ask, forwarding: undefined }), { kind: "defer" });
});

test("trace: review_defer_headless keeps role and cmd; command stays dropped", async () => {
  const { sanitizeTrace } = await import("../trace.ts");
  assert.deepEqual(sanitizeTrace({ event: "review_defer_headless", role: "builder", cmd: "x", command: "x" }), { event: "review_defer_headless", role: "builder", cmd: "x" });
});

test("timeout-wrapped child ask is allowed without calling the model", async () => {
  const r = new ForemanReview();
  const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
  r.upsert("s", session({ registry: reg, bashRules: () => rules }, []));
  assert.deepEqual(await r.authorize("s", { ...ask, command: undefined, value: "timeout 900 cargo test" }), { kind: "allow" });
  // a build run after a cd away from the worktree root is not judged by the rules (effects.ts)
  assert.deepEqual(await r.authorize("s", { ...ask, command: undefined, value: "cd /app && timeout 900 cargo test" }), { kind: "defer" });
  assert.deepEqual(await r.authorize("s", { ...ask, command: undefined, value: "timeout 900 rm -rf x" }), { kind: "defer" });
  // a forwarded child ask carries the command in `value`, not `command`: the reviewer must see it
  assert.equal(reviewValue({ value: "sed -n 1p f" }), "sed -n 1p f");
  assert.equal(reviewValue({ payload: { request: { value: "ls" } } }), "ls");
});

test("forwarded ask: the model prompt and traces carry the full command from evidence; fixed allow still checks the unit", async () => {
  const full = "python3 - <<'EOF'\nprint(1)\nEOF";
  const forwarded = { requestId: "r", surface: "bash", agentName: "builder", forwarding: { x: 1 }, value: "python3", payload: { evidence: [{ label: "full command", text: full }] } };
  assert.equal(reviewValue(forwarded), full);
  assert.equal(reviewValue({ value: "python3", payload: { evidence: [{ label: "other", text: "x" }] } }), "python3");
  const traces: Record<string, unknown>[] = [];
  const prompts: string[] = [];
  const reg: RegistryLike = { find: () => ({}), complete: async (_m, ctx) => (prompts.push(JSON.stringify(ctx)), { content: [{ type: "text", text: '{"verdict":"defer","reason":"x"}' }], stopReason: "stop" }) };
  const r = new ForemanReview();
  r.upsert("s", session({ headless: () => true, registry: reg }, traces));
  await r.authorize("s", forwarded);
  assert.match(prompts[0], /print\(1\)/);
  assert.match(String(traces.find((t) => t.event === "review_defer_headless")?.cmd), /print\(1\)/);
  // a deterministic allow must hold for the unit AND the full command: a piped or chained tail goes to review
  const sedAsk = { ...forwarded, value: "sed -n 1p f", payload: { evidence: [{ label: "full command", text: "cd x; sed -n 1p f | sh" }] } };
  const sr = new ForemanReview();
  // paths resolve inside the worktree (git top level of the cwd) only (effects.ts)
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pf-hd-"));
  fs.mkdirSync(path.join(repo, ".git"));
  sr.upsert("s", session({ headless: () => true, bashRules: () => rules, cwd: repo }, []));
  assert.equal((await sr.authorize("s", sedAsk)).kind, "deny");
  const okSed = { ...sedAsk, payload: { evidence: [{ label: "full command", text: "cd x; sed -n 1p f" }] } };
  assert.deepEqual(await sr.authorize("s", okSed), { kind: "allow" });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("forwarded ask: tmp-scratch on the cp unit does not allow a chained rm -rf in the full command", async () => {
  const traces: Record<string, unknown>[] = [];
  const r = new ForemanReview();
  r.upsert("s", session({ headless: () => true, bashRules: () => rules }, traces));
  const cpAsk = { requestId: "r", surface: "bash", agentName: "builder", forwarding: { x: 1 }, value: "cp -r . /tmp/pf-x", payload: { evidence: [{ label: "full command", text: "cp -r . /tmp/pf-x && rm -rf src" }] } };
  const v = await r.authorize("s", cpAsk);
  assert.equal(v.kind, "deny");
  assert.ok(!traces.some((t) => t.event === "review" && t.decision === "tmp-scratch"));
});

test("autoreview usage: zero-usage replies are recorded as a chars/4 estimate with estimated:true; real usage is untouched", async () => {
  const rows: Record<string, unknown>[] = [];
  const mk = (usage: Record<string, number>): RegistryLike => ({ find: () => ({}), complete: async () => ({ content: [{ type: "text", text: '{"verdict":"defer","reason":"x"}' }], stopReason: "stop", usage } as never) });
  for (const [usage, estimated] of [[{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, true], [{ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, false]] as const) {
    rows.length = 0;
    const r = new ForemanReview();
    r.upsert("s", session({ registry: mk(usage), recordUsage: (m) => rows.push(m as Record<string, unknown>) }, []));
    await r.authorize("s", { requestId: "r", surface: "bash", command: "ls" });
    const u = rows[0].usage as Record<string, number>;
    assert.equal(rows[0].estimated === true, estimated);
    if (estimated) {
      assert.ok(u.input > 100 && u.output === Math.ceil('{"verdict":"defer","reason":"x"}'.length / 4));
      assert.equal(usageLine({ workspace: "/w", foremanSession: "f", role: "autoreview", launchId: null, kind: "foreman" }, rows[0]).estimated, true);
    } else assert.equal(u.input, 7);
  }
  assert.equal("estimated" in usageLine({ workspace: "/w", foremanSession: "f", role: "x", launchId: null, kind: "foreman" }, { usage: { input: 1 } }), false);
});
