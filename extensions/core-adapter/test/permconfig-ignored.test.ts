// PR C: permconfig.ts after the removal of modes, profiles and rule lists: the removed keys are read, ignored and recorded in `Resolved.ignored`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, userFilePath } from "../permconfig.ts";
import type { GitRun } from "../permconfig.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync(mkTestTmp("pfc-perm-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function store(user?: unknown, project?: unknown, ignored = true): PermStore {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  if (user !== undefined) fs.writeFileSync(userFilePath(agentDir), JSON.stringify(user));
  if (project !== undefined) fs.writeFileSync(path.join(main, ".workflow", "permissions.json"), JSON.stringify(project));
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\n\nworktree ${wt}\nHEAD abc\n` };
    return { status: args[0] === "check-ignore" ? (ignored ? 0 : 1) : 1, stdout: "" };
  };
  return new PermStore({ agentDir, cwd: wt, home: path.join(base, "home"), git });
}

test("missing files: nothing ignored, no notice", () => {
  const s = store();
  const r = s.resolve();
  assert.deepEqual([r.ignored, r.prose.deny, r.protected], [[], [], []]);
  assert.deepEqual(s.drainNotices(), []);
});

test("a leftover mode key is ignored and recorded", () => {
  assert.deepEqual(store({ mode: "allow" }).resolve().ignored, ["user mode"]);
});

test("leftover rule lists, allow sentences and profiles are ignored and recorded, one entry per key", () => {
  const r = store({ allow: ["Bash(ls)"], ask: ["Bash(rm *)"], deny: ["Bash(x)"], classifier: { allow: ["Anything."], deny: ["Never touch prod."] }, profiles: { p: { mode: "ask" } } }).resolve();
  assert.deepEqual([...r.ignored].sort(), ["user allow", "user ask", "user classifier.allow", "user deny", "user profiles"]);
  assert.deepEqual(r.prose.deny.map((e) => e.text), ["Never touch prod."]);
});

test("deny sentences and protected entries still apply", () => {
  const r = store({ classifier: { deny: ["Never touch prod."] }, protected: [{ host: "prod-*.example.net" }] }).resolve();
  assert.deepEqual(r.prose.deny.map((e) => e.id), ["D1"]);
  assert.deepEqual(r.protected.map((e) => [e.id, e.kind, e.glob]), [["P1", "host", "prod-*.example.net"]]);
});

test("the permissions profile key of the CLI no longer exists on the resolved shape", () => {
  const r = store({ mode: "deny" }).resolve() as unknown as Record<string, unknown>;
  for (const k of ["mode", "modeSource", "profile", "rules"]) assert.equal(k in r, false, k);
});
