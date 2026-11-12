#!/usr/bin/env node
// Owner script: turn on GitHub auto-merge for repos. Dry run unless --apply; the repo names are arguments.
//   node scripts/repo_automerge.mjs <owner/repo>... [--checks ci-ok,pr-policy] [--apply]
// Per repo: allow_auto_merge and delete_branch_on_merge on (read back afterwards); with --checks, those required status checks on the
// default branch and required pull-request reviews off (a solo owner cannot approve their own PR). Rulesets are reported, never edited.
// A failure on one repo is reported and the next repo runs; the exit code is 1 when any repo failed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The real gh call: `gh api -X <method> <endpoint>` with a JSON body on stdin. `text` is stdout + stderr (an error's cause is read from it). */
export function ghApi({ method, endpoint, body }) {
  const args = ["api", "-X", method, endpoint, ...(body === undefined ? [] : ["--input", "-"])];
  const r = spawnSync("gh", args, { input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8", windowsHide: true });
  if (r.error) return { ok: false, text: `gh failed to run: ${r.error.message}` };
  return { ok: r.status === 0, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const httpStatus = (text) => /HTTP (\d{3})/.exec(text)?.[1] ?? /"status"\s*:\s*"?(\d{3})/.exec(text)?.[1] ?? "";
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const on = (x) => x?.enabled === true;

/** The PUT .../protection body that keeps every setting of a GET .../protection answer, with the required status checks set and reviews off. */
export function putBody(current, checks) {
  const rsc = current?.required_status_checks;
  const r = current?.restrictions;
  const body = {
    required_status_checks: { strict: rsc?.strict === true, contexts: checks },
    enforce_admins: on(current?.enforce_admins),
    required_pull_request_reviews: null,
    restrictions: r ? { users: (r.users ?? []).map((u) => u.login), teams: (r.teams ?? []).map((t) => t.slug), apps: (r.apps ?? []).map((a) => a.slug) } : null,
  };
  for (const k of ["required_linear_history", "allow_force_pushes", "allow_deletions", "block_creations", "required_conversation_resolution", "lock_branch", "allow_fork_syncing"]) {
    if (current && k in current) body[k] = on(current[k]);
  }
  return body;
}

export function main(argv, { gh = ghApi, log = console.log } = {}) {
  const repos = [];
  let checks = null;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--checks") checks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (/^[\w.-]+\/[\w.-]+$/.test(a)) repos.push(a);
    else {
      log(`unknown argument ${a}`);
      repos.length = 0;
      break;
    }
  }
  if (repos.length === 0 || (checks !== null && checks.length === 0)) {
    log("usage: node scripts/repo_automerge.mjs <owner/repo>... [--checks ci-ok,pr-policy] [--apply]");
    return 2;
  }
  let failed = 0;
  /** A write: printed in a dry run, sent with --apply. */
  const write = (method, endpoint, body) => {
    log(`  ${apply ? "" : "would "}${method} ${endpoint} ${JSON.stringify(body ?? {})}`);
    return apply ? gh({ method, endpoint, body }) : { ok: true, text: "" };
  };
  for (const repo of repos) {
    log(`${repo}${apply ? "" : " (dry run, --apply changes it)"}`);
    try {
      const cur = gh({ method: "GET", endpoint: `repos/${repo}` });
      const info = cur.ok ? json(cur.text) : null;
      if (!info) throw new Error(`cannot read the repo: ${cur.text.trim()}`);
      const show = (r) => `allow_auto_merge=${r.allow_auto_merge} delete_branch_on_merge=${r.delete_branch_on_merge} allow_squash_merge=${r.allow_squash_merge} allow_merge_commit=${r.allow_merge_commit}`;
      log(`  now: ${show(info)}`);
      const set = write("PATCH", `repos/${repo}`, { allow_auto_merge: true, delete_branch_on_merge: true });
      if (!set.ok) throw new Error(`repo settings not changed: ${set.text.trim()}`);
      if (apply) {
        const back = json(gh({ method: "GET", endpoint: `repos/${repo}` }).text);
        if (!back) throw new Error("repo settings read-back failed");
        log(`  in effect: ${show(back)}`);
        if (back.allow_auto_merge !== true) log("  allow_auto_merge did not stay on (this plan or repo does not support it): press Merge once the PR is green");
      }
      if (checks) protect(repo, info.default_branch, checks);
      const rs = gh({ method: "GET", endpoint: `repos/${repo}/rulesets` });
      const sets = rs.ok ? json(rs.text) : null;
      if (Array.isArray(sets) && sets.length > 0) log(`  rulesets (this script does not edit them): ${sets.map((s) => s.name).join(", ")}`);
    } catch (e) {
      failed++;
      log(`  FAILED: ${e.message}`);
    }
  }
  return failed ? 1 : 0;

  function protect(repo, branch, list) {
    const base = `repos/${repo}/branches/${branch}/protection`;
    const got = gh({ method: "GET", endpoint: base });
    if (!got.ok) {
      const status = httpStatus(got.text);
      if (status === "403" && /upgrade to github pro/i.test(got.text)) {
        log("  no branch protection on this plan: the auto-merge button will not appear and Merge merges at once (skipped)");
        return;
      }
      if (status === "403") throw new Error(`token lacks admin rights for branch protection: ${got.text.trim()}`);
      if (status === "404" && /branch not protected/i.test(got.text)) {
        const put = write("PUT", base, putBody(null, list));
        if (!put.ok) throw new Error(`protection not created: ${put.text.trim()}`);
        return;
      }
      throw new Error(`cannot read branch protection: ${got.text.trim()}`);
    }
    const current = json(got.text);
    if (!current) throw new Error("branch protection answer is not JSON");
    if (!apply) {
      const line = (label, open, state) => log(`  ${label}: ${state}${open ? " WARN" : " OK"}`);
      line(`force pushes to ${branch}`, on(current.allow_force_pushes), on(current.allow_force_pushes) ? "allowed" : "not allowed");
      line(`deletion of ${branch}`, on(current.allow_deletions), on(current.allow_deletions) ? "allowed" : "not allowed");
      line("protection includes admins", !on(current.enforce_admins), on(current.enforce_admins) ? "yes" : "no (admins can bypass it)");
    }
    const rsc = current.required_status_checks;
    const patch = rsc ? write("PATCH", `${base}/required_status_checks`, { strict: rsc.strict === true, contexts: list }) : { ok: false, text: "HTTP 404 required status checks not enabled" };
    if (!patch.ok) {
      if (httpStatus(patch.text) !== "404") throw new Error(`required checks not set: ${patch.text.trim()}`);
      const put = write("PUT", base, putBody(current, list));
      if (!put.ok) throw new Error(`required checks not set: ${put.text.trim()}`);
      return;
    }
    const del = write("DELETE", `${base}/required_pull_request_reviews`);
    if (!del.ok && httpStatus(del.text) !== "404") throw new Error(`required reviews not turned off: ${del.text.trim()}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
