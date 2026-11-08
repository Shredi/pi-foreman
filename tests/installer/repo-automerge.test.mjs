// scripts/repo_automerge.mjs: the owner script that turns on GitHub auto-merge. The gh call is an injected fake, so it runs on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, putBody } from "../../scripts/repo_automerge.mjs";

const REPO = { default_branch: "main", allow_auto_merge: false, delete_branch_on_merge: false, allow_squash_merge: true, allow_merge_commit: true };
const ok = (v) => ({ ok: true, text: JSON.stringify(v) });
const err = (status, msg) => ({ ok: false, text: `{"message":"${msg}"}\ngh: ${msg} (HTTP ${status})` });

/** A fake gh: `routes` maps "METHOD endpoint" to an answer or a function of the call; every call is recorded. */
function fake(routes) {
  const calls = [];
  const state = { repo: { ...REPO } };
  const gh = (c) => {
    calls.push(c);
    const key = `${c.method} ${c.endpoint}`;
    if (key.startsWith("PATCH repos/") && !key.includes("/branches/")) {
      Object.assign(state.repo, c.body);
      return ok({});
    }
    if (/^GET repos\/[^/]+\/[^/]+$/.test(key)) return ok(state.repo);
    const r = routes[key];
    if (r === undefined) return key.endsWith("/rulesets") ? ok([]) : err(500, `unrouted ${key}`);
    return typeof r === "function" ? r(c) : r;
  };
  const writes = () => calls.filter((c) => c.method !== "GET");
  return { gh, calls, writes, state };
}

function run(routes, argv) {
  const f = fake(routes);
  const lines = [];
  const code = main(argv, { gh: f.gh, log: (l) => lines.push(l) });
  return { ...f, code, out: lines.join("\n") };
}

const PROT = "repos/o/r/branches/main/protection";

test("a dry run makes no write call and prints the planned ones", () => {
  const r = run({ [`GET ${PROT}`]: ok({ required_status_checks: { strict: true, contexts: ["x"] } }) }, ["o/r", "--checks", "ci-ok,pr-policy"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.writes(), []);
  assert.match(r.out, /would PATCH repos\/o\/r \{"allow_auto_merge":true,"delete_branch_on_merge":true\}/);
  assert.match(r.out, /would PATCH .*required_status_checks \{"strict":true,"contexts":\["ci-ok","pr-policy"\]\}/);
  assert.match(r.out, /would DELETE .*required_pull_request_reviews/);
});

test("--apply patches the repo, reads it back, sets the checks and turns the required review off", () => {
  const r = run({ [`GET ${PROT}`]: ok({ required_status_checks: { strict: false, contexts: [] } }), [`PATCH ${PROT}/required_status_checks`]: ok({}), [`DELETE ${PROT}/required_pull_request_reviews`]: ok({}) }, ["o/r", "--checks", "ci-ok", "--apply"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.writes().map((c) => `${c.method} ${c.endpoint}`), ["PATCH repos/o/r", `PATCH ${PROT}/required_status_checks`, `DELETE ${PROT}/required_pull_request_reviews`]);
  assert.match(r.out, /in effect: allow_auto_merge=true delete_branch_on_merge=true/);
});

test("without --checks the protection is not touched", () => {
  const r = run({}, ["o/r", "--apply"]);
  assert.equal(r.code, 0);
  assert.ok(!r.calls.some((c) => c.endpoint.includes("protection")));
});

test("a plan without branch protection is skipped, not a failure", () => {
  const r = run({ [`GET ${PROT}`]: err(403, "Upgrade to GitHub Pro or make this repository public to enable this feature.") }, ["o/r", "--checks", "ci-ok", "--apply"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no branch protection on this plan/);
  assert.deepEqual(r.writes().map((c) => c.endpoint), ["repos/o/r"]);
});

test("another 403 is a failure", () => {
  const r = run({ [`GET ${PROT}`]: err(403, "Resource not accessible by personal access token") }, ["o/r", "--checks", "ci-ok", "--apply"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED: token lacks admin rights/);
});

test("an unprotected branch gets a full PUT", () => {
  const r = run({ [`GET ${PROT}`]: err(404, "Branch not protected"), [`PUT ${PROT}`]: ok({}) }, ["o/r", "--checks", "ci-ok,pr-policy", "--apply"]);
  assert.equal(r.code, 0, r.out);
  const put = r.writes().find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { required_status_checks: { strict: false, contexts: ["ci-ok", "pr-policy"] }, enforce_admins: false, required_pull_request_reviews: null, restrictions: null });
});

test("reviews already off (DELETE 404) is a success", () => {
  const r = run({ [`GET ${PROT}`]: ok({ required_status_checks: { strict: false, contexts: [] } }), [`PATCH ${PROT}/required_status_checks`]: ok({}), [`DELETE ${PROT}/required_pull_request_reviews`]: err(404, "Not Found") }, ["o/r", "--checks", "ci-ok", "--apply"]);
  assert.equal(r.code, 0, r.out);
});

test("protection without required checks falls back to a PUT that carries the other settings over", () => {
  const current = { enforce_admins: { enabled: true }, required_linear_history: { enabled: true }, required_conversation_resolution: { enabled: true }, restrictions: { users: [{ login: "me" }], teams: [], apps: [] }, required_pull_request_reviews: { required_approving_review_count: 1 } };
  const r = run({ [`GET ${PROT}`]: ok(current), [`PUT ${PROT}`]: ok({}) }, ["o/r", "--checks", "ci-ok", "--apply"]);
  assert.equal(r.code, 0, r.out);
  const put = r.writes().find((c) => c.method === "PUT");
  assert.deepEqual(put.body, putBody(current, ["ci-ok"]));
  assert.equal(put.body.enforce_admins, true);
  assert.equal(put.body.required_linear_history, true);
  assert.equal(put.body.required_pull_request_reviews, null);
  assert.deepEqual(put.body.restrictions, { users: ["me"], teams: [], apps: [] });
});

test("rulesets are reported and not edited", () => {
  const r = run({ "GET repos/o/r/rulesets": ok([{ name: "main-rules" }]) }, ["o/r", "--apply"]);
  assert.match(r.out, /rulesets \(this script does not edit them\): main-rules/);
  assert.ok(!r.writes().some((c) => c.endpoint.includes("rulesets")));
});

test("a failing repo does not stop the next; the exit code is 1", () => {
  const calls = [];
  const gh = (c) => {
    calls.push(`${c.method} ${c.endpoint}`);
    if (c.endpoint === "repos/o/bad") return err(404, "Not Found");
    if (c.method === "GET" && c.endpoint === "repos/o/good/rulesets") return ok([]);
    return ok(REPO);
  };
  const lines = [];
  const code = main(["o/bad", "o/good", "--apply"], { gh, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /FAILED: cannot read the repo/);
  assert.ok(calls.includes("PATCH repos/o/good"));
});

test("no repo or a bad argument prints the usage and exits 2", () => {
  assert.equal(main([], { gh: () => assert.fail("no call"), log: () => {} }), 2);
  assert.equal(main(["o/r", "--nope"], { gh: () => assert.fail("no call"), log: () => {} }), 2);
});
