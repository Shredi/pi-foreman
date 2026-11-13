// returnToBase (returntobase.ts): the checkout of a merged PR goes back to the updated base branch; every refusal changes nothing. Temp repositories only, the host's answer is injected.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { realGit, returnToBase } from "../returntobase.ts";
import type { ReturnDeps } from "../returntobase.ts";
import type { SafeOpOutcome } from "../safeops.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

type Merge = "merge-commit" | "squash" | "rebase";

function build(merge: Merge) {
  const root = fs.realpathSync.native(mkTestTmp("pf-return-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  // the pushInsteadOf pair beats an inherited rewrite of every push url (a session env may carry one)
  const run = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", `url.${origin}.pushInsteadOf=${origin}`, ...a], { encoding: "utf8" }).trim();
  const g = (...a: string[]) => run(work, ...a);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  run(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  fs.mkdirSync(work);
  execFileSync("git", ["init", "-q", work]);
  g("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), "one\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "chore: one");
  g("remote", "add", "origin", origin);
  g("push", "-q", "-u", "origin", "main");
  g("switch", "-q", "-c", "round/x");
  fs.writeFileSync(path.join(work, "feature.txt"), "feature\n");
  g("add", "feature.txt");
  g("commit", "-q", "-m", "feat: x");
  g("push", "-q", "-u", "origin", "round/x");
  const tip = g("rev-parse", "HEAD");
  // the host merges the PR in another clone
  execFileSync("git", ["clone", "-q", origin, other]);
  if (merge === "merge-commit") {
    run(other, "merge", "-q", "--no-ff", "-m", "Merge PR", "origin/round/x");
  } else if (merge === "squash") {
    run(other, "merge", "-q", "--squash", "origin/round/x");
    run(other, "commit", "-q", "-m", "feat: x (#1)");
  } else {
    run(other, "cherry-pick", tip);
  }
  run(other, "push", "-q", "origin", "main");
  const merged = run(other, "rev-parse", "HEAD");
  return { root, work, origin, other, g, run, tip, merged };
}

type F = ReturnType<typeof build>;

// one repository set per merge kind, copied for each test (few git starts: the suite has a child-process budget)
const templates = new Map<Merge, F>();
after(() => {
  for (const t of templates.values()) rmTestTmp(t.root);
});

/** The template itself, for a test that only reads (every refusal asserts the repository is unchanged). */
function shared(): F {
  let t = templates.get("squash");
  if (!t) templates.set("squash", (t = build("squash")));
  return t;
}

function fixture(merge: Merge): F {
  let t = templates.get(merge);
  if (!t) templates.set(merge, (t = build(merge)));
  const root = fs.realpathSync.native(mkTestTmp("pf-return-"));
  fs.cpSync(t.root, root, { recursive: true });
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const run = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", `url.${origin}.pushInsteadOf=${origin}`, ...a], { encoding: "utf8" }).trim();
  run(work, "remote", "set-url", "origin", origin);
  run(other, "remote", "set-url", "origin", origin);
  return { root, work, origin, other, g: (...a: string[]) => run(work, ...a), run, tip: t.tip, merged: t.merged };
}

const answer = (f: F, over: Record<string, unknown> = {}): SafeOpOutcome => ({ kind: "ran", result: { state: "merged", headRefName: "round/x", baseRef: "main", headSha: f.tip, ...over } });
const deps = (f: F, o: SafeOpOutcome = answer(f), busy?: () => boolean): ReturnDeps => ({ status: async () => o, git: realGit, ...(busy ? { busy } : {}) });

function snapshot(f: F) {
  return {
    // oid, branch name (or detached) and every change, untracked files included
    status: f.g("status", "--porcelain=v2", "--branch", "--untracked-files=all"),
    branches: f.g("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
    readme: fs.readFileSync(path.join(f.work, "README.md"), "utf8"),
  };
}

async function refused(f: F, d: ReturnDeps, reason: RegExp, mutate?: () => void) {
  mutate?.();
  const before = snapshot(f);
  const r = await returnToBase(d, { cwd: f.work, number: 1 });
  assert.equal(r.returned, false);
  if (r.returned === false) {
    assert.match(r.reason, reason);
    assert.ok(r.advice.length > 0);
    assert.equal(r.left, undefined);
  }
  assert.deepEqual(snapshot(f), before);
}

for (const merge of ["merge-commit", "squash", "rebase"] as const) {
  test(`returns to the updated base after a ${merge} merge, untracked files survive`, async () => {
    const f = fixture(merge);
    try {
      fs.writeFileSync(path.join(f.work, "notes.txt"), "mine\n");
      const r = await returnToBase(deps(f), { cwd: f.work, number: 1 });
      assert.deepEqual(r, { returned: true, base: "main", sha: f.merged, deleted: "round/x" });
      assert.equal(f.g("symbolic-ref", "--short", "HEAD"), "main");
      assert.equal(f.g("rev-parse", "HEAD"), f.merged);
      assert.equal(f.g("for-each-ref", "--format=%(refname:short)", "refs/heads"), "main");
      assert.equal(f.g("status", "--porcelain"), "?? notes.txt");
      assert.equal(fs.readFileSync(path.join(f.work, "notes.txt"), "utf8"), "mine\n");
      assert.ok(fs.existsSync(path.join(f.work, "feature.txt")));
    } finally {
      rmTestTmp(f.root);
    }
  });
}

test("returns after a squash merge when the remote head branch was already deleted (only the forced delete works)", async () => {
  const f = fixture("squash");
  try {
    f.g("push", "-q", "origin", "--delete", "round/x");
    f.g("fetch", "-q");
    assert.throws(() => f.g("merge-base", "--is-ancestor", f.tip, "origin/main")); // a squash merge: the tip is not in the base
    const r = await returnToBase(deps(f), { cwd: f.work, number: 1 });
    assert.deepEqual(r, { returned: true, base: "main", sha: f.merged, deleted: "round/x" });
    assert.equal(f.g("for-each-ref", "--format=%(refname:short)", "refs/heads"), "main");
    assert.equal(f.g("status", "--porcelain"), "");
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: a staged tracked change", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /working tree not clean/, () => {
      fs.writeFileSync(path.join(f.work, "README.md"), "staged\n");
      f.g("add", "README.md");
    });
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: an unstaged tracked change", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /working tree not clean/, () => fs.writeFileSync(path.join(f.work, "README.md"), "unstaged\n"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: the local tip is not the PR's last head (a local commit the PR never had)", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /not at the PR's last head/, () => {
      fs.writeFileSync(path.join(f.work, "local.txt"), "x\n");
      f.g("add", "local.txt");
      f.g("commit", "-q", "-m", "wip");
    });
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: the checkout is on another branch", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /on other, not on the PR branch round\/x/, () => f.g("switch", "-q", "-c", "other"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: detached HEAD", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /HEAD is detached/, () => f.g("checkout", "-q", "--detach"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: the local base has its own commit and cannot fast-forward", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /cannot fast-forward/, () => {
      f.g("switch", "-q", "main");
      fs.writeFileSync(path.join(f.work, "mine.txt"), "x\n");
      f.g("add", "mine.txt");
      f.g("commit", "-q", "-m", "local base work");
      f.g("switch", "-q", "round/x");
    });
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: the PR is not merged, or the lookup failed", async () => {
  const f = shared();
  await refused(f, deps(f, answer(f, { state: "open" })), /does not report the PR as merged/);
  await refused(f, deps(f, { kind: "error", message: "gh down" }), /could not be read/);
  await refused(f, deps(f, { kind: "precondition", precondition: "x", message: "x" }), /could not be read/);
});

test("not returned: no local base branch", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /no local branch main/, () => f.g("branch", "-D", "main"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: the local base has no upstream", async () => {
  const f = fixture("squash");
  try {
    await refused(f, deps(f), /no upstream/, () => f.g("branch", "--unset-upstream", "main"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: an untracked file the base adds would be overwritten", async () => {
  const f = fixture("squash");
  try {
    fs.writeFileSync(path.join(f.other, "extra.txt"), "from the remote\n");
    f.run(f.other, "add", "extra.txt");
    f.run(f.other, "commit", "-q", "-m", "more");
    f.run(f.other, "push", "-q", "origin", "main");
    await refused(f, deps(f), /extra\.txt would be overwritten/, () => fs.writeFileSync(path.join(f.work, "extra.txt"), "mine\n"));
    assert.equal(fs.readFileSync(path.join(f.work, "extra.txt"), "utf8"), "mine\n");
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: an ignored file the base adds would be overwritten", async () => {
  const f = fixture("squash");
  try {
    fs.writeFileSync(path.join(f.other, "extra.txt"), "from the remote\n");
    f.run(f.other, "add", "extra.txt");
    f.run(f.other, "commit", "-q", "-m", "more");
    f.run(f.other, "push", "-q", "origin", "main");
    fs.writeFileSync(path.join(f.work, ".git", "info", "exclude"), "extra.txt\n");
    await refused(f, deps(f), /extra\.txt would be overwritten/, () => fs.writeFileSync(path.join(f.work, "extra.txt"), "mine\n"));
  } finally {
    rmTestTmp(f.root);
  }
});

test("not returned: a head or base name that starts with a dash", async () => {
  const f = shared();
  await refused(f, deps(f, answer(f, { headRefName: "-D" })), /no usable head branch/);
  await refused(f, deps(f, answer(f, { baseRef: "--force" })), /no usable head branch/);
});

test("not returned: a builder, reviewer or explorer of the session still runs in the checkout", async () => {
  const f = shared();
  let asked = 0;
  const d: ReturnDeps = { status: async () => { asked++; return answer(f); }, git: realGit, busy: () => true };
  await refused(f, d, /still running/);
  assert.equal(asked, 0);
});

test("not returned: the head branch is the base branch, and the base is never deleted", async () => {
  const f = shared();
  await refused(f, deps(f, answer(f, { headRefName: "main", baseRef: "main" })), /head branch is its base branch/);
});

test("not returned: the head branch is the remote default branch (a PR from main into release), nothing is deleted", async () => {
  const f = fixture("squash");
  try {
    f.g("switch", "-q", "-c", "release", "main");
    f.g("push", "-q", "-u", "origin", "release");
    f.g("switch", "-q", "main");
    f.g("remote", "set-head", "origin", "main");
    const d = deps(f, answer(f, { headRefName: "main", baseRef: "release", headSha: f.g("rev-parse", "HEAD") }));
    await refused(f, d, /default branch of origin, which is never deleted/);
    assert.match(f.g("for-each-ref", "--format=%(refname:short)", "refs/heads"), /main/);
  } finally {
    rmTestTmp(f.root);
  }
});

test("a step failing after the switch reports the state it left", async () => {
  const f = fixture("squash");
  try {
    const fail: ReturnDeps = { status: async () => answer(f), git: (args, dir) => (args[0] === "branch" ? Promise.resolve({ ok: false, out: "" }) : realGit(args, dir)) };
    const r = await returnToBase(fail, { cwd: f.work, number: 1 });
    assert.equal(r.returned, false);
    if (r.returned === false) {
      assert.match(r.reason, /deleting the local round\/x failed/);
      assert.equal(r.left, "the checkout is on main");
    }
    assert.equal(f.g("rev-parse", "HEAD"), f.merged);
    assert.match(f.g("for-each-ref", "--format=%(refname:short)", "refs/heads"), /round\/x/);
  } finally {
    rmTestTmp(f.root);
  }
});
