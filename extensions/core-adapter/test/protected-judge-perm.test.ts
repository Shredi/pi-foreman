// The per-entry `check` of protected entries: parse, notices, the writers' validation and the trace fields (neutral fixtures).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, cleanProtected, protectedBlock, userFilePath } from "../permconfig.ts";
import type { GitRun, PermEnv } from "../permconfig.ts";
import { sanitizeTrace } from "../trace.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(mkTestTmp("pf-prot-check-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function world() {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD abc\n` };
    if (args[0] === "ls-files") return { status: 1, stdout: "" };
    if (args[0] === "check-ignore") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const env: PermEnv = { agentDir, cwd: wt, home: path.join(base, "home"), git };
  return { store: new PermStore(env), user: (v: unknown) => fs.writeFileSync(userFilePath(agentDir), JSON.stringify(v)), userFile: userFilePath(agentDir) };
}

test("a valid check is kept; an entry without one has none", () => {
  const w = world();
  w.user({ protected: [{ host: "prod-db", check: "read-only" }, { host: "stage-db", check: "model" }, { host: "dev-db" }] });
  const r = w.store.resolve();
  assert.deepEqual(r.protected.map((e) => e.check ?? null), ["read-only", "model", null]);
  assert.deepEqual(w.store.drainNotices(), []);
  assert.match(protectedBlock(r).join("\n"), /P1: host prod-db \[check: read-only\] \(user\)/);
  assert.match(protectedBlock(r).join("\n"), /P3: host dev-db \(user\)/);
});

test("an invalid check keeps the entry as ask, with a notice", () => {
  const w = world();
  w.user({ protected: [{ host: "prod-db", check: "readonly" }, { host: "stage-db", check: 3 }] });
  const r = w.store.resolve();
  assert.deepEqual(r.protected.map((e) => [e.glob, e.check]), [["prod-db", "ask"], ["stage-db", "ask"]]);
  const notes = w.store.drainNotices();
  assert.equal(notes.length, 2, notes.join("\n"));
  assert.match(notes[0], /protected\[0\].*prod-db.*check 'readonly'.*treated as ask/);
});

test("an unknown key in an entry gives a notice; the entry is still used", () => {
  const w = world();
  w.user({ protected: [{ host: "prod-db", mode: "ask" }] });
  assert.deepEqual(w.store.resolve().protected.map((e) => e.glob), ["prod-db"]);
  const notes = w.store.drainNotices();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /protected\[0\].*unknown key 'mode'/);
});

test("cleanProtected: the old shape without a check, a valid check, an invalid check maps to ask", () => {
  assert.deepEqual(cleanProtected({ kind: "host", glob: "prod-db" }), { kind: "host", glob: "prod-db" });
  assert.deepEqual(cleanProtected({ kind: "host", glob: "prod-db", check: "read-only" }), { kind: "host", glob: "prod-db", check: "read-only" });
  assert.deepEqual(cleanProtected({ kind: "host", glob: "prod-db", check: "bogus" }), { kind: "host", glob: "prod-db", check: "ask" });
});

test("writeProtected writes the check; a duplicate with another mode is refused with the remove-then-add hint", () => {
  const w = world();
  assert.equal(w.store.writeProtected("user", "add", { kind: "host", glob: "prod-db", note: "production", check: "read-only" }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(w.userFile, "utf8")).protected, [{ host: "prod-db", note: "production", check: "read-only" }]);
  const dup = w.store.writeProtected("user", "add", { kind: "host", glob: "prod-db", check: "ask" });
  assert.equal(dup.ok, false);
  assert.match(dup.ok === false ? dup.reason : "", /already protected.*remove it and add it again/);
  assert.equal(w.store.writeProtected("user", "remove", { kind: "host", glob: "prod-db" }).ok, true);
  assert.equal(w.store.writeProtected("user", "add", { kind: "host", glob: "prod-db", check: "ask" }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(w.userFile, "utf8")).protected[0].check, "ask");
});

test("trace: protected_check keeps cause and mode", () => {
  const out: Record<string, unknown> = sanitizeTrace({ event: "protected_check", accepted: "ask", cause: "remote_write", mode: "read-only" });
  assert.deepEqual([out.cause, out.mode], ["remote_write", "read-only"]);
});
