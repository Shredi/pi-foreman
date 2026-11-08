// foreman_protect / `/foreman perms protect`: the validation (cleanProtected) and the write (PermStore.writeProtected): refusals, then the version bump.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, cleanProtected, userFilePath } from "../permconfig.ts";
import type { GitRun, PermEnv } from "../permconfig.ts";
import { sanitizeTrace } from "../trace.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(mkTestTmp("pf-prot-write-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function world(opts: { trusted?: boolean } = {}) {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  const trusted = opts.trusted !== false;
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD abc\n` };
    if (args[0] === "ls-files") return { status: trusted ? 1 : 0, stdout: "" };
    if (args[0] === "check-ignore") return { status: trusted ? 0 : 1, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const env: PermEnv = { agentDir, cwd: wt, home: path.join(base, "home"), git };
  return { store: new PermStore(env), projectFile: path.join(main, ".workflow", "permissions.json"), userFile: userFilePath(agentDir) };
}

test("cleanProtected: kind, glob and note are validated and tidied", () => {
  assert.deepEqual(cleanProtected({ kind: "host", glob: "  prod-*  ", note: "a\nb" }), { kind: "host", glob: "prod-*", note: "a b" });
  assert.equal(typeof cleanProtected({ kind: "url", glob: "x" }), "string");
  assert.equal(typeof cleanProtected({ kind: "host", glob: "" }), "string");
  assert.equal(typeof cleanProtected({ kind: "host", glob: 3 }), "string");
  assert.equal(typeof cleanProtected({ kind: "host", glob: "x", note: "n".repeat(201) }), "string");
});

test("add writes the project file, bumps the version, and shows up as P1", () => {
  const w = world();
  const v0 = w.store.resolve().version;
  const r = w.store.writeProtected("project", "add", { kind: "host", glob: "prod-*", note: "production" });
  assert.deepEqual(r, { ok: true, file: w.projectFile });
  const res = w.store.resolve();
  assert.notEqual(res.version, v0);
  assert.deepEqual(res.protected.map((e) => [e.id, e.kind, e.glob]), [["P1", "host", "prod-*"]]);
  assert.equal(JSON.parse(fs.readFileSync(w.projectFile, "utf8")).protected[0].note, "production");
});

test("duplicate add and missing remove are refused; remove deletes", () => {
  const w = world();
  w.store.writeProtected("project", "add", { kind: "path", glob: "ops/**" });
  const dup = w.store.writeProtected("project", "add", { kind: "path", glob: "ops/**" });
  assert.equal(dup.ok, false);
  const miss = w.store.writeProtected("project", "remove", { kind: "path", glob: "nope" });
  assert.equal(miss.ok, false);
  assert.deepEqual(w.store.writeProtected("project", "remove", { kind: "path", glob: "ops/**" }), { ok: true, file: w.projectFile });
  assert.deepEqual(w.store.resolve().protected, []);
});

test("an untrusted project file is refused and nothing is written; the user file still works", () => {
  const w = world({ trusted: false });
  const r = w.store.writeProtected("project", "add", { kind: "command", glob: "deploy-*" });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(w.projectFile), false);
  assert.deepEqual(w.store.writeProtected("user", "add", { kind: "command", glob: "deploy-*" }), { ok: true, file: w.userFile });
});

test("a corrupt or non-list file is not overwritten", () => {
  const w = world();
  fs.writeFileSync(w.projectFile, "{ nope");
  assert.equal(w.store.writeProtected("project", "add", { kind: "host", glob: "a" }).ok, false);
  assert.equal(fs.readFileSync(w.projectFile, "utf8"), "{ nope");
  fs.writeFileSync(w.projectFile, JSON.stringify({ protected: "x" }));
  assert.equal(w.store.writeProtected("project", "add", { kind: "host", glob: "a" }).ok, false);
});

// the command on the record comes from the emitting code path: see protected-index.test.ts
test("trace: the protected_check fields survive", () => {
  const out: Record<string, unknown> = sanitizeTrace({ event: "protected_check", effect: "read", confidence: "high", accepted: "allow", away: false, cached: false, entry: "P1" });
  assert.deepEqual([out.effect, out.confidence, out.accepted, out.away, out.cached, out.entry], ["read", "high", "allow", false, false, "P1"]);
});
