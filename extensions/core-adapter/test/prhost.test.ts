import { test } from "node:test";
import assert from "node:assert/strict";
import { PrHost, validHost, validRepo } from "../prhost.ts";
import type { PrHostDeps } from "../prhost.ts";

const ran = (result: Record<string, unknown>) => ({ kind: "ran" as const, result: { ok: true, ...result } });

function host(opts: { remotes?: string[]; repo?: { host: string; repo: string } | null } = {}) {
  const calls: { op: string; cwd?: string }[] = [];
  const run: PrHostDeps["run"] = async (op, _args, cwd) => {
    calls.push({ op, cwd });
    const r = opts.repo === undefined ? { host: "github.com", repo: "acme/app" } : opts.repo;
    return r ? ran({ host: r.host, repo: r.repo }) : { kind: "precondition" as const, precondition: "pr_not_found", message: "m" };
  };
  return { h: new PrHost({ run, remoteHosts: async () => opts.remotes ?? [] }), calls };
}

test("hostAllowed: the current host or a remote's host; nothing else (a tracked PR's host no longer counts)", async () => {
  const { h } = host({ remotes: ["git.example.org"] });
  assert.equal(await h.hostAllowed("GitHub.com", "/w"), true);
  assert.equal(await h.hostAllowed("git.example.org", "/w"), true);
  assert.equal(await h.hostAllowed("elsewhere.example.net", "/w"), false);
});

test("repoFor asks pr_repo once per cwd; an unresolved repository is null and the host rule falls back to the remotes", async () => {
  const { h, calls } = host();
  assert.deepEqual(await h.repoFor("/w"), { host: "github.com", repo: "acme/app" });
  await h.repoFor("/w");
  await h.hostAllowed("github.com", "/w");
  assert.equal(calls.filter((c) => c.op === "pr_repo").length, 1);
  await h.repoFor("/other");
  assert.equal(calls.filter((c) => c.op === "pr_repo").length, 2);
  const none = host({ repo: null, remotes: ["git.example.org"] });
  assert.equal(await none.h.repoFor("/w"), null);
  assert.equal(await none.h.hostAllowed("github.com", "/w"), false);
  assert.equal(await none.h.hostAllowed("git.example.org", "/w"), true);
});

test("validRepo and validHost refuse path tricks and option-like names", () => {
  assert.equal(validRepo("acme/app"), true);
  for (const bad of ["acme", "acme/app/x", "../x", "acme/..", "-x/app", "acme/-app", "", 5]) assert.equal(validRepo(bad), false, String(bad));
  assert.equal(validHost("github.com"), true);
  assert.equal(validHost("git.example.org:8443"), true);
  for (const bad of ["bad host", "-x.com", "", "a/b", 5]) assert.equal(validHost(bad), false, String(bad));
});
