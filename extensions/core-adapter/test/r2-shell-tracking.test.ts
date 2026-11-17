// Round 2, step 2 "shell tracking": `exec cd` does not move the cwd of the rest of the line, `pushd`/`popd` track the cwd like `cd`, and the project `.pi`
// self-modification rule sees every writer the write-target code lists (`sed -i`, `cp`, `tee` ...), not only redirects and a fixed word list.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateDecide, type GateResult } from "../gate.ts";
import type { FloorEnv } from "../floors.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync.native(mkTestTmp("pf-r2-track-"));
test.after(() => rmTestTmp(base));
const home = path.join(base, "home");
const work = path.join(base, "work");
const scr = path.join(base, "scr");
for (const d of [home, work, path.join(work, "sub"), path.join(work, ".pi", "agents"), path.join(work, ".pi", "extensions"), path.join(scr, "sub")]) fs.mkdirSync(d, { recursive: true });
const PKG_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

const mkRoots = (role: string) => ({ worktree: work, scratch: [scr], tmp: [fs.realpathSync.native(os.tmpdir()), "/tmp"], scratchBase: path.join(base, "scrbase"), owned: [], install: [], roundFlow: [], handoffs: [], child: role !== "foreman", role, tmpAccess: true }) as never;
const envOf = (child: boolean): FloorEnv => ({ cwd: work, home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [work, scr], scratch: [scr], pkgRoot: PKG_ROOT, child });
const run = (role: string, command: string): GateResult => gateDecide("bash", { command }, work, { env: () => envOf(role !== "foreman"), roots: () => mkRoots(role) });
const rule = (r: GateResult): string | null => (r && "block" in r && r.block ? (r.rule ?? null) : null);
const answer = (r: GateResult): string => (r === null || r === undefined ? "none" : "block" in r && r.block ? `block:${r.rule}` : `allow:${(r as { rule?: string }).rule}`);
const ask = (r: GateResult): string => (r && "ask" in r && r.ask ? `ask:${r.rule}` : answer(r));
const ROLES = ["foreman", "builder"];
const posixOnly = { skip: process.platform === "win32" };

test("(A) exec cd does not move the cwd of the rest of the line", posixOnly, () => {
  const line = `bash -O execfail -c 'exec cd ${scr}/sub; rm -rf ../../work/../scr/x'`;
  assert.equal(rule(run("foreman", line)), "floor-delete-outside");
  assert.equal(rule(run("builder", line)), "floor-delete-outside");
  // a plain cd still moves it
  assert.notEqual(rule(run("foreman", `bash -c 'cd ${scr}/sub; rm -rf ../../work/../scr/x'`)), "floor-delete-outside");
});

test("(B) pushd <dir> answers as cd <dir>", posixOnly, () => {
  for (const role of ROLES) {
    assert.equal(answer(run(role, "pushd /etc && echo x > passwd")), answer(run(role, "cd /etc && echo x > passwd")), role);
    assert.equal(answer(run(role, "pushd /etc; echo x > passwd")), answer(run(role, "cd /etc; echo x > passwd")), role);
  }
  assert.notEqual(answer(run("builder", "pushd /etc; echo x > passwd")), "none");
  assert.equal(rule(run("builder", "pushd /etc && echo x > passwd")), "child-write-outside");
});

// `popd` does not restore anything: the cwd is unknown after it, so the write-target reader gives no decision on a relative target (as before pushd was tracked)
test("(B) popd makes the cwd unknown", posixOnly, () => {
  for (const role of ROLES) {
    for (const line of ["pushd sub; popd; echo y > ../outside", "pushd /etc; popd; echo x > f", "pushd /etc; pushd /var; popd; echo x > f"]) {
      assert.equal(answer(run(role, line)), answer(run(role, line.replace(/pushd [^;]*; /g, ""))), `${role}: ${line}`);
    }
  }
  assert.equal(answer(run("foreman", "pushd sub; popd; echo y > ../outside")), "none");
});

// every shell construct in which a `pushd` leaves no entry the later `popd` could use: a builder still gets the refusal it got before pushd was tracked
test("(B) a pushd that is not in effect for the later popd does not open the builder's relative write", posixOnly, () => {
  const lines = [
    `cd /etc; (cd ${scr}/sub; pushd /etc); popd; touch x`,
    `cd /etc; if false; then cd ${scr}/sub; pushd /etc; fi; popd; touch x`,
    `cd /etc; while false; do cd ${scr}/sub; pushd /etc; done; popd; touch x`,
    `cd /etc; { cd ${scr}/sub; pushd /etc; } | cat; popd; touch x`,
    `cd /etc; ( cd ${scr}/sub; pushd /etc ) & popd; touch x`,
    `cd /etc; echo $( cd ${scr}/sub; pushd /etc ); popd; touch x`,
    `cd /etc; bash -c 'cd ${scr}/sub; pushd /etc'; popd; touch x`,
    `cd ${scr}/sub; pushd /etc; dirs -c; popd; touch x`,
    `cd /etc; pushd ${scr}/sub; pushd /nonexist; popd; touch x`,
  ];
  for (const line of lines) assert.equal(rule(run("builder", line)), "child-write-outside", line);
});

test("(B) the forms that stay unknown answer as before", posixOnly, () => {
  const unknown = ["pushd", "pushd +1", "pushd -n", "popd +1", "popd", "pushd /etc; popd; popd"];
  for (const role of ROLES) {
    for (const u of unknown) assert.equal(answer(run(role, `${u}; echo x > passwd`)), "none", `${role}: ${u}`);
  }
});

const PI_FILES = [".pi/settings.json", ".pi/foreman.json", ".pi/claude-bridge.json", ".pi/agents/x.md", ".pi/extensions/x.ts"];

test("(C) in-place and other writers on project .pi files ask for main, deny the builder, as the redirect form", posixOnly, () => {
  for (const f of PI_FILES) {
    const t = path.join(work, f);
    const redirect = run("foreman", `echo x > ${t}`);
    const rid = rule(run("builder", `echo x > ${t}`));
    assert.ok(rid, f);
    for (const line of [`sed -i s/a/b/ ${t}`, `perl -pi -e 1 ${t}`, `tee ${t}`, `truncate -s 0 ${t}`, `dd if=a of=${t}`, `cp a ${t}`]) {
      assert.equal(ask(run("foreman", line)), ask(redirect), `foreman: ${line}`);
      assert.equal(rule(run("builder", line)), rid, `builder: ${line}`);
    }
  }
});

test("(C) reads of project .pi files and sed -i on an ordinary file are not asked", posixOnly, () => {
  const t = path.join(work, ".pi", "settings.json");
  for (const line of [`cat ${t}`, `sed -n p ${t}`, `grep a ${t}`]) {
    for (const role of ROLES) assert.ok(!/selfmod/.test(ask(run(role, line)) + answer(run(role, line))), `${role}: ${line}`);
  }
  for (const role of ROLES) assert.ok(!/selfmod/.test(ask(run(role, `sed -i s/a/b/ ${path.join(work, "sub", "f.txt")}`))), role);
});
