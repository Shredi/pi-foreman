import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { registerPrPack } from "../gitpack.ts";
import type { PrPackSession } from "../gitpack.ts";
import { PrWatches } from "../prwatch.ts";
import type { Spawner } from "../spawn.ts";
import { passCheckouts, PR_REFUSALS, prGateRefusal, toplevelOf } from "../reviews.ts";
import type { ReviewRecord } from "../reviews.ts";
import { rmTestTmp } from "./_tmpbase.ts";

function repo(prefix: string): { dir: string; g: (...a: string[]) => string; commit: (m: string) => string } {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  const commit = (m: string) => {
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", m);
    return g("rev-parse", "HEAD");
  };
  commit("chore: a");
  return { dir, g, commit };
}

const rec = (cwd: string | undefined, head: string, verdict: "pass" | "fail" = "pass"): ReviewRecord => ({ role: "reviewer", verdict, head, ...(cwd ? { cwd } : {}) });

test("sibling pr_create {cwd}: PASS for that checkout at its HEAD is accepted; no PASS, stale PASS, other-checkout PASS are refused", async () => {
  const session = repo("pf-sib-s-");
  const sib = repo("pf-sib-x-");
  try {
    const first = sib.g("rev-parse", "HEAD");
    const gate = (records: ReviewRecord[], cwd = sib.dir) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: session.dir, input: {}, checkout: { cwd, records } });
    assert.equal(await gate([rec(sib.dir, first)]), null);
    assert.equal(await gate([rec(sib.dir, first)], path.join(sib.dir, ".git", "..")), null);
    // no PASS at all, and a PASS recorded only for the session checkout (even at the same sha string)
    assert.equal((await gate([]))?.reason, "cwd_unreviewed");
    assert.equal((await gate([rec(session.dir, first)]))?.reason, "cwd_unreviewed");
    assert.equal((await gate([rec(undefined, first)]))?.reason, "cwd_unreviewed");
    assert.equal((await gate([rec(sib.dir, first), rec(sib.dir, first, "fail")]))?.reason, "cwd_unreviewed");
    // a new commit makes the PASS stale
    sib.commit("chore: b");
    const stale = await gate([rec(sib.dir, first)]);
    assert.equal(stale?.reason, "cwd_stale");
    assert.match(stale?.message ?? "", /pr_create \{cwd\}/);
    // not a checkout
    assert.equal((await gate([], os.tmpdir()))?.reason, "cwd_unreviewed");
    // children stay refused first; gate off lets it through
    assert.equal((await prGateRefusal({ tool: "pr_create", isChild: true, gateOn: false, reviewed: [], cwd: session.dir, checkout: { cwd: sib.dir, records: [rec(sib.dir, first)] } }))?.reason, "child");
    assert.equal(await prGateRefusal({ tool: "pr_create", isChild: false, gateOn: false, reviewed: [], cwd: session.dir, checkout: { cwd: sib.dir, records: [] } }), null);
  } finally {
    rmTestTmp(session.dir);
    rmTestTmp(sib.dir);
  }
});

test("sibling pr_create {cwd}: the upstream-stale rule applies in the sibling checkout, and the session's own checkout keeps the session rules", async () => {
  const session = repo("pf-sib-s-");
  const sib = repo("pf-sib-x-");
  try {
    const first = sib.g("rev-parse", "HEAD");
    const branch = sib.g("symbolic-ref", "--short", "HEAD");
    sib.g("update-ref", "refs/remotes/origin/" + branch, first);
    sib.g("config", "remote.origin.url", "https://h.invalid/r.git");
    sib.g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    sib.g("config", "branch." + branch + ".remote", "origin");
    sib.g("config", "branch." + branch + ".merge", "refs/heads/" + branch);
    const second = sib.commit("chore: b");
    const gate = (records: ReviewRecord[]) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: session.dir, input: {}, checkout: { cwd: sib.dir, records } });
    assert.equal((await gate([rec(sib.dir, second)]))?.reason, "stale_review");
    assert.equal(await gate([rec(sib.dir, first), rec(sib.dir, second)]), null);
    // cwd naming the session checkout: the session's rules (PASS heads of any record, headless handling)
    const own = session.g("rev-parse", "HEAD");
    const same = (records: ReviewRecord[]) => prGateRefusal({ tool: "pr_create", isChild: false, gateOn: true, reviewed: [], cwd: session.dir, input: {}, checkout: { cwd: session.dir, records } });
    assert.equal(await same([rec(session.dir, own)]), null);
    assert.equal((await same([]))?.reason, "no_review");
  } finally {
    rmTestTmp(session.dir);
    rmTestTmp(sib.dir);
  }
});

test("passCheckouts keeps the checkouts whose latest verdict at a head is PASS; toplevelOf is the realpath of the toplevel", async () => {
  const r = repo("pf-sib-p-");
  try {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const list: ReviewRecord[] = [rec(r.dir, a), rec(r.dir, b), rec(r.dir, b, "fail"), rec(undefined, a), { role: "reviewer", verdict: "pass", head: null, cwd: r.dir }, { ...rec("/x", a), kind: "plan" }];
    assert.deepEqual(passCheckouts(list), [{ cwd: r.dir, head: a }]);
    fs.mkdirSync(path.join(r.dir, "sub"));
    assert.equal(await toplevelOf(path.join(r.dir, "sub")), r.dir);
    assert.equal(await toplevelOf(os.tmpdir()), null);
  } finally {
    rmTestTmp(r.dir);
  }
});

test("pr_create {cwd} through the pack: refused without a PASS for the checkout, run in the checkout with one (cwd not passed on as an argument), watch from the PR url", async () => {
  const session = repo("pf-sib-s-");
  const sib = repo("pf-sib-x-");
  try {
    const head = sib.g("rev-parse", "HEAD");
    const run = async (records: ReviewRecord[], params: Record<string, unknown>) => {
      const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }>();
      const calls: { input: string; cwd?: string }[] = [];
      const spawner: Spawner = async (_c, _a, o) => {
        calls.push({ input: o.input ?? "", cwd: o.cwd });
        return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 5, url: "https://github.com/acme/sib/pull/5" }) + "\n", stderr: "", timedOut: false };
      };
      const watches = new PrWatches({ send: () => {}, idle: () => true, trace: () => {}, intervalMs: () => 5000, now: () => 0 });
      const s: PrPackSession = { python: "/py", isChild: false, packOn: true, config: { baseBranch: "x", prHost: "auto" }, gateOn: true, reviewed: async () => [], records: async () => records, watches, trace: () => {}, tracker: { hostAllowed: async () => true, repoFor: async () => ({ host: "github.com", repo: "acme/session" }) } };
      registerPrPack({ registerTool: (t: unknown) => void tools.set((t as { name: string }).name, t as never) } as never, { isChild: false, session: async () => s, script: "/s.py", spawner, env: () => ({}), pushRefusal: async () => null });
      const r = await tools.get("pr_create")!.execute("id", params, undefined, undefined, { cwd: session.dir });
      return { r, calls, watches };
    };
    const bad = await run([], { title: "t", body: "b", cwd: sib.dir });
    assert.equal(bad.r.details.reason, "cwd_unreviewed");
    assert.equal(bad.calls.length, 0);
    const ok = await run([{ role: "reviewer", verdict: "pass", head, cwd: sib.dir }], { title: "t", body: "b", cwd: sib.dir });
    assert.equal(ok.r.details.decision, "ran");
    assert.equal(ok.calls[0].cwd, sib.dir);
    assert.equal(JSON.parse(ok.calls[0].input).cwd, sib.dir);
    assert.equal("cwd" in JSON.parse(ok.calls[0].input).args, false);
    assert.equal(ok.watches.size(), 1);
  } finally {
    rmTestTmp(session.dir);
    rmTestTmp(sib.dir);
  }
});

test("the sibling refusal reasons are registered", () => {
  for (const r of ["cwd_unreviewed", "cwd_stale", "repo_unmatched", "repo_ambiguous"]) assert.ok((PR_REFUSALS as readonly string[]).includes(r), r);
});
