// Protected targets in the permission files: parse, bad entries, where the key is dropped, numbering, version.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, protectedBlock, userFilePath } from "../permconfig.ts";
import type { GitRun, PermEnv } from "../permconfig.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync(mkTestTmp("pf-prot-perm-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

function world() {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  const tracked = new Set<string>();
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD abc\n` };
    const rel = args[args.length - 1];
    if (args[0] === "ls-files") return { status: tracked.has(rel) ? 0 : 1, stdout: "" };
    if (args[0] === "check-ignore") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  const env: PermEnv = { agentDir, cwd: wt, home: path.join(base, "home"), git };
  const put = (file: string) => (v: unknown) => fs.writeFileSync(file, JSON.stringify(v));
  return { env, store: () => new PermStore(env), user: put(userFilePath(agentDir)), project: put(path.join(main, ".workflow", "permissions.json")), trackedFile: put(path.join(wt, ".pi", "permissions.json")) };
}

const prot = [{ host: "prod-*.example.net", note: "production" }, { path: "ops/playbooks/**" }, { command: "deploy-*" }];

test("the user file: three kinds, ids P1.., source, note", () => {
  const w = world();
  w.user({ protected: prot });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(r.protected.map((e) => [e.id, e.kind, e.glob, e.note ?? null, e.source]), [
    ["P1", "host", "prod-*.example.net", "production", "user"],
    ["P2", "path", "ops/playbooks/**", null, "user"],
    ["P3", "command", "deploy-*", null, "user"],
  ]);
  assert.deepEqual(s.drainNotices(), []);
  assert.match(protectedBlock(r).join("\n"), /P1: host prod-\*\.example\.net - production \(user\)/);
});

test("bad entries are skipped with a notice naming them; good ones stay", () => {
  const w = world();
  w.user({ protected: [{ host: "a", path: "b" }, { note: "x" }, { host: "" }, { host: "x".repeat(301) }, { host: "ok.example.net", note: "n".repeat(201) }, "str", { command: "fine" }] });
  const s = w.store();
  assert.deepEqual(s.resolve().protected.map((e) => e.glob), ["fine"]);
  const notes = s.drainNotices();
  assert.equal(notes.length, 6, notes.join("\n"));
  assert.match(notes[0], /protected\[0\].*exactly one/);
  assert.match(notes[4], /protected\[4\].*ok\.example\.net.*note/);
});

test("a non-list protected key makes the file invalid like any other bad key", () => {
  const w = world();
  w.user({ protected: "nope" });
  const s = w.store();
  assert.equal(s.resolve().mode, "ask");
  assert.match(s.drainNotices().join("\n"), /protected must be a list/);
});

test("the tracked file drops the key with the dropped-key notice", () => {
  const w = world();
  w.trackedFile({ protected: prot });
  const s = w.store();
  assert.deepEqual(s.resolve().protected, []);
  assert.match(s.drainNotices().join("\n"), /protected.*not honoured in the tracked file/);
});

test("an untrusted project file drops the key; a trusted one keeps it, numbered after the user file", () => {
  const w = world();
  w.user({ protected: [{ host: "u.example.net" }] });
  w.project({ protected: [{ path: "srv/**" }] });
  const s = w.store();
  assert.deepEqual(s.resolve().protected.map((e) => [e.id, e.source]), [["P1", "user"], ["P2", "project"]]);

  const x = world();
  x.user({ protected: [{ host: "u.example.net" }] });
  x.project({ protected: [{ path: "srv/**" }] });
  fs.mkdirSync(path.join(x.env.cwd), { recursive: true });
  const tracked = new PermStore({ ...x.env, git: (args, cwd) => (args[0] === "ls-files" ? { status: 0, stdout: "" } : x.env.git!(args, cwd)) });
  assert.deepEqual(tracked.resolve().protected.map((e) => e.id), ["P1"]);
  assert.match(tracked.drainNotices().join("\n"), /protected is not honoured/);
});

test("profile bodies drop the key", () => {
  const w = world();
  w.user({ profiles: { p: { protected: [{ host: "x" }], allow: ["Bash(ls)"] } } });
  const s = w.store();
  void s;
  const store = new PermStore({ ...w.env, profile: "p" });
  assert.deepEqual(store.resolve().protected, []);
  assert.match(store.drainNotices().join("\n"), /profiles\.p\.protected.*not honoured/);
});

test("version grows on reload and on a changed file, not on a plain re-resolve", () => {
  const w = world();
  w.user({ protected: [{ host: "a" }] });
  const s = w.store();
  const v1 = s.resolve().version;
  assert.equal(s.resolve().version, v1);
  s.reload();
  const v2 = s.resolve().version;
  assert.ok(v2 > v1);
  w.user({ protected: [{ host: "a" }, { host: "b" }] });
  fs.utimesSync(userFilePath(w.env.agentDir), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const r = s.resolve();
  assert.ok(r.version > v2);
  assert.equal(r.protected.length, 2);
  assert.ok(s.version >= r.version);
});
