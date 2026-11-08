// A narrow read-only exception for SSH public keys directly in <home>/.ssh (floors.ts sshPublicKey): lexical + realpath + content, fail closed.
// Real files in a temp HOME; both layers (the floors and the overlay's path rules) are checked.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { lineFloors, pathFloors, secretPath, sshPublicKey, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { gateDecide } from "../gate.ts";
import { buildOverlayRules, checkToolCall, readBaseline, type MatchCtx } from "../permoverlay.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const base = fs.realpathSync(mkTestTmp("pubkey-read-"));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const home = path.join(base, "home");
const ssh = path.join(home, ".ssh");
const work = path.join(base, "work");
const agent = path.join(home, ".pi", "agent");
for (const d of [ssh, path.join(ssh, "sub"), path.join(home, ".aws"), work, agent]) fs.mkdirSync(d, { recursive: true });
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host\n";
fs.writeFileSync(path.join(ssh, "k.pub"), KEY);
fs.writeFileSync(path.join(ssh, "cert.pub"), "ssh-ed25519-cert-v01@openssh.com AAAA user\n");
fs.writeFileSync(path.join(ssh, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
fs.writeFileSync(path.join(ssh, "config"), "Host x\n");
fs.writeFileSync(path.join(ssh, "known_hosts"), "x ssh-ed25519 AAAA\n");
fs.writeFileSync(path.join(ssh, "authorized_keys"), KEY);
fs.writeFileSync(path.join(ssh, "notakey.pub"), "hello world\n");
fs.writeFileSync(path.join(ssh, "priv.pub"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
fs.writeFileSync(path.join(ssh, "big.pub"), `${KEY}${"# c\n".repeat(5000)}`);
fs.writeFileSync(path.join(ssh, "empty.pub"), "");
fs.symlinkSync(path.join(ssh, "id_ed25519"), path.join(ssh, "link.pub"));
fs.symlinkSync(path.join(ssh, "k.pub"), path.join(ssh, "ok-link.pub"));
fs.symlinkSync(path.join(work, "x.pub"), path.join(ssh, "dangling.pub"));
fs.linkSync(path.join(ssh, "id_ed25519"), path.join(ssh, "hard.pub"));
fs.writeFileSync(path.join(ssh, "sub", "k.pub"), KEY);
fs.writeFileSync(path.join(home, ".aws", "x.pub"), KEY);
fs.writeFileSync(path.join(work, "outside.pub"), KEY);
fs.symlinkSync(path.join(work, "outside.pub"), path.join(ssh, "out.pub"));

const env: FloorEnv = { cwd: work, home, agentDir: agent, writeRoots: [work] };
const K = "~/.ssh/k.pub";

const line = (cmd: string, e: FloorEnv = env): string | null => {
  const r = lineFloors(cmd, parseShell(cmd, { cwd: e.cwd, platform: e.platform }), e);
  return r?.kind === "deny" ? r.rule : r ? `ask:${r.rule}` : null;
};
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, agent);
const octx = (over: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: work, home, platform: process.platform, role: "main", ...over });
const ov = (tool: string, input: Record<string, unknown>, over: Partial<MatchCtx> = {}): string => checkToolCall(rules, tool, input, octx(over))?.kind ?? "pass";
const sh = (cmd: string): string => ov("bash", { command: cmd });

// item 1: the predicate
test("sshPublicKey: a regular key file directly in ~/.ssh", () => {
  assert.equal(sshPublicKey(K, env), true);
  assert.equal(sshPublicKey(path.join(ssh, "cert.pub"), env), true);
  assert.equal(sshPublicKey("$HOME/.ssh/k.pub", env), true);
  assert.equal(sshPublicKey(path.join(ssh, "ok-link.pub"), env), true, "a symlink to another key in ~/.ssh");
});

test("sshPublicKey: fails closed on every other file", () => {
  for (const f of ["link.pub", "hard.pub", "notakey.pub", "priv.pub", "big.pub", "empty.pub", "dangling.pub", "out.pub", "missing.pub", "sub/k.pub", "id_ed25519", "config", "known_hosts", "authorized_keys"]) {
    assert.equal(sshPublicKey(`~/.ssh/${f}`, env), false, f);
  }
  assert.equal(sshPublicKey("~/.aws/x.pub", env), false);
  assert.equal(sshPublicKey("~/.ssh/../.aws/x.pub", env), false);
  assert.equal(sshPublicKey("~/.ssh/*.pub", env), false, "a glob is not a file");
  assert.equal(sshPublicKey("~/.ssh/$X.pub", env), false);
  assert.equal(sshPublicKey(K, { ...env, home: undefined }), false);
});

// the hardlink to a private key is a regular file with key-like name: its content is no public key
test("a hardlink .pub to the private key is denied by content", () => {
  assert.equal(secretPath("~/.ssh/hard.pub", env, true)?.rule, "floor-secret-path");
});

// item 2: floors, read versus write
test("floors: a read of a valid public key passes, a write stays a secret-path deny", () => {
  assert.equal(secretPath(K, env, true), null);
  assert.equal(secretPath(K, env, false)?.rule, "floor-secret-path");
  assert.equal(pathFloors({ path: K }, env, "read", undefined, true), null);
  assert.equal(pathFloors({ path: K, content: "x" }, env, "write", undefined, false)?.rule, "floor-secret-path");
  assert.equal(pathFloors({ path: K, edits: [] }, env, "edit", undefined, false)?.rule, "floor-secret-path");
});

test("floors: shell reads of a public key pass", () => {
  assert.equal(line(`cat ${K}`), null);
  assert.equal(line(`ssh-keygen -l -f ${K}`), null);
  assert.equal(line(`head -1 < ${K}`), null);
});

test("floors: shell writes to a public key stay denied", () => {
  for (const c of [`echo x > ${K}`, `echo x >> ${K}`, `cp /tmp/x ${K}`, `mv /tmp/x ${K}`, `mv ${K} /tmp/x`, `rm ${K}`, `echo x | tee ${K}`, `cp ${K} ${K}.bak`, `cp ${K} /tmp/x`, `rsync ${K} /tmp/x`, `cp --remove-source-files ${K} /tmp/x`, `cp -t /tmp ${K}`, `sort -o ${K} ${K}`, `cat ${K} > ${K}`]) {
    assert.ok(line(c) !== null, c);
  }
});

test("floors: everything else under ~/.ssh stays denied for a read", () => {
  for (const f of ["id_ed25519", "config", "known_hosts", "authorized_keys", "link.pub", "hard.pub", "notakey.pub", "missing.pub", "sub/k.pub"]) {
    assert.equal(line(`cat ~/.ssh/${f}`), "floor-secret-path", f);
  }
  assert.equal(line("cat ~/.aws/x.pub"), "floor-secret-path");
});

// item 3: the overlay's path rules
test("overlay: path tools read a public key, never write it", () => {
  assert.equal(ov("read", { path: K }), "pass");
  assert.equal(ov("read", { path: path.join(ssh, "k.pub") }), "pass");
  assert.equal(ov("write", { path: K, content: "x" }), "deny");
  assert.equal(ov("edit", { path: K, oldText: "a", newText: "b" }), "deny");
});

test("overlay: shell reads a public key, never writes it", () => {
  assert.equal(sh(`cat ${K}`), "pass");
  assert.equal(sh(`ssh-keygen -l -f ${K}`), "pass");
  for (const c of [`echo x > ${K}`, `cp /tmp/x ${K}`, `cp ${K} /tmp/x`, `rsync ${K} /tmp/x`, `mv /tmp/x ${K}`, `rm ${K}`, `echo x | tee ${K}`, `cat ${K} > ${K}`, `cat ${K} ${K}.bak > ${K}`]) {
    assert.equal(sh(c), "deny", c);
  }
});

test("overlay: every non-key file in ~/.ssh stays denied", () => {
  for (const f of ["id_ed25519", "config", "known_hosts", "authorized_keys", "link.pub", "hard.pub", "notakey.pub", "missing.pub", "sub/k.pub"]) {
    assert.equal(ov("read", { path: `~/.ssh/${f}` }), "deny", `read ${f}`);
    assert.equal(sh(`cat ~/.ssh/${f}`), "deny", `cat ${f}`);
  }
  assert.equal(ov("read", { path: "~/.aws/x.pub" }), "deny");
  assert.equal(sh("cat ~/.aws/x.pub"), "deny");
});

test("overlay: an owner path rule that names .pub still denies", () => {
  // owner path denies are read from the merged `paths.deny` (permoverlay.ts buildOverlayRules)
  for (const pattern of ["*/.ssh/*.pub", "*.pub"]) {
    const strict = buildOverlayRules(readBaseline(PKG)!, { paths: { deny: [pattern] } }, {}, agent);
    assert.ok(strict.pathRules.some((r) => r.pattern === pattern && r.action === "deny"), `rule ${pattern} loaded`);
    const kind = (tool: string, input: Record<string, unknown>): string => checkToolCall(strict, tool, input, octx())?.kind ?? "pass";
    assert.equal(kind("read", { path: K }), "deny", `${pattern} read`);
    assert.equal(kind("bash", { command: `cat ${K}` }), "deny", `${pattern} cat`);
  }
  // a rule that does not name `.pub` (the baseline `*/.ssh/*`) is the one the exemption skips
  assert.ok(rules.pathRules.some((r) => r.pattern === "*/.ssh/*" && r.action === "deny"));
  assert.equal(ov("read", { path: K }), "pass");
});

// item 4: the gate allows with the rule id floor-pubkey-read, a write or another file stays blocked
test("the gate: a public key read is allowed as floor-pubkey-read, a write is blocked", () => {
  const roots = { worktree: work, scratch: [], tmp: [], scratchBase: path.join(base, "scr"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false } as never;
  const g = (tool: string, input: Record<string, unknown>): unknown => gateDecide(tool, input, work, { env: () => env, roots: () => roots });
  assert.deepEqual(g("read", { path: K }), { allow: true, rule: "floor-pubkey-read", layer: "rule" });
  // a shell command spells the absolute path with forward slashes: in bash syntax a backslash is an escape (`D:\a\x` reads `D:ax`)
  const fssh = ssh.replace(/\\/g, "/");
  assert.deepEqual(g("bash", { command: `cat ${fssh}/k.pub` }), { allow: true, rule: "floor-pubkey-read", layer: "rule" });
  assert.deepEqual(g("bash", { command: `ssh-keygen -l -f ${fssh}/k.pub` }), { allow: true, rule: "floor-pubkey-read", layer: "rule" });
  assert.equal((g("write", { path: K, content: "x" }) as { rule?: string }).rule, "floor-secret-path");
  assert.equal((g("read", { path: "~/.ssh/id_ed25519" }) as { rule?: string }).rule, "floor-secret-path");
  assert.notEqual((g("bash", { command: `cat ${fssh}/k.pub /etc/hosts` }) as { rule?: string } | undefined)?.rule, "floor-pubkey-read");
});

// item 5: windows spellings, the platform simulated over the real temp home
test("win32: the Windows spellings of the profile all name the key, a write stays denied", () => {
  const wenv: FloorEnv = { ...env, platform: "win32" };
  for (const w of [`${ssh}\\k.pub`, `${ssh}/k.pub`, "~\\.ssh\\k.pub", "~/.ssh/k.pub"]) {
    assert.equal(secretPath(w, wenv, true), null, w);
    assert.equal(secretPath(w, wenv, false)?.rule, "floor-secret-path", w);
  }
  assert.equal(secretPath("~\\.ssh\\id_ed25519", wenv, true)?.rule, "floor-secret-path");
  assert.equal(secretPath("~\\.ssh\\sub\\k.pub", wenv, true)?.rule, "floor-secret-path");
  // a drive path that is not this home is no known file: fail closed
  assert.equal(secretPath("C:\\Users\\x\\.ssh\\k.pub", wenv, true)?.rule, "floor-secret-path");
});

// item 4: %USERPROFILE%, $env:USERPROFILE and ${env:USERPROFILE} are the home dir like `~`
test("win32: the profile variables read the key, the private key and writes stay denied", () => {
  const wenv: FloorEnv = { ...env, platform: "win32" };
  const spellings = ["%USERPROFILE%\\.ssh\\", "%userprofile%/.ssh/", "$env:USERPROFILE\\.ssh\\", "${env:USERPROFILE}\\.ssh\\"];
  for (const s of spellings) {
    assert.equal(secretPath(`${s}k.pub`, wenv, true), null, `${s}k.pub`);
    assert.equal(secretPath(`${s}k.pub`, wenv, false)?.rule, "floor-secret-path", `write ${s}k.pub`);
    for (const f of ["id_ed25519", "config", "known_hosts", "authorized_keys", "notakey.pub"]) assert.equal(secretPath(`${s}${f}`, wenv, true)?.rule, "floor-secret-path", `${s}${f}`);
  }
  // the overlay: powershell and cmd read commands
  const ps = (command: string): string => ov("powershell", { command }, { platform: "win32", shell: "powershell" });
  for (const s of spellings) {
    for (const cmd of ["Get-Content", "gc", "cat", "type"]) {
      assert.equal(ps(`${cmd} ${s}k.pub`), "pass", `${cmd} ${s}k.pub`);
      assert.equal(ps(`${cmd} ${s}id_ed25519`), "deny", `${cmd} ${s}id_ed25519`);
    }
    assert.equal(ps(`Set-Content ${s}k.pub x`), "deny", `Set-Content ${s}k.pub`);
    assert.equal(ps(`Copy-Item ${s}k.pub C:\\x`), "deny", `Copy-Item ${s}k.pub`);
    assert.equal(ps(`Get-Content ${s}k.pub > ${s}k.pub`), "deny", `redirect ${s}k.pub`);
  }
  // the path tools take the same spellings
  assert.equal(ov("read", { path: "%USERPROFILE%\\.ssh\\k.pub" }, { platform: "win32" }), "pass");
  assert.equal(ov("read", { path: "%USERPROFILE%\\.ssh\\id_ed25519" }, { platform: "win32" }), "deny");
});

// item 3: every copy of a key stays denied, at the floors, the overlay and the path tools
test("a copy of a public key is denied: cp, rsync, foreman_copy", () => {
  for (const c of [`cp ${K} /tmp/x`, `rsync ${K} /tmp/x`, `rsync -a ${K} /tmp/x`, `cp --remove-source-files ${K} /tmp/x`]) {
    assert.ok(line(c) !== null, c);
    assert.equal(sh(c), "deny", c);
  }
  assert.equal(line(`cp ${K} /tmp/x`), "floor-secret-path");
  assert.equal(pathFloors({ src: K, dst: "/tmp/x" }, env, "foreman_copy", undefined, false)?.rule, "floor-secret-path");
  assert.equal(ov("foreman_copy", { src: K, dst: "/tmp/x" }), "deny");
  assert.equal(ov("foreman_move", { src: K, dst: "/tmp/x" }), "deny");
});

// item 5: the trace names the rule also for the `~` / `$HOME` spellings
test("the gate traces floor-pubkey-read for the tilde and $HOME spellings", () => {
  const roots = { worktree: work, scratch: [], tmp: [], scratchBase: path.join(base, "scr"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false } as never;
  const g = (tool: string, input: Record<string, unknown>): { rule?: string } | undefined => gateDecide(tool, input, work, { env: () => env, roots: () => roots }) as { rule?: string } | undefined;
  for (const c of [`cat ${K}`, `ssh-keygen -l -f ${K}`, `ssh-keygen -lf ${K}`, `ssh-keygen -l -E md5 -f ${K}`, "cat $HOME/.ssh/k.pub", "cat ${HOME}/.ssh/k.pub", `head -1 ${K}`]) {
    assert.equal(g("bash", { command: c })?.rule, "floor-pubkey-read", c);
  }
  // not a verified read of a key: no pubkey rule
  for (const c of [`cat ${K} ~/.ssh/id_ed25519`, "cat ~/x.txt", `cat ${K} ~/x.txt`, `ssh-keygen -y -f ${K}`, `ssh-keygen -p -f ${K}`, `ssh-keygen -c -f ${K}`, `ssh-keygen -R ${K}`, `cp ${K} /tmp/x`, `cat ${K} > ~/x.txt`]) {
    assert.notEqual(g("bash", { command: c })?.rule, "floor-pubkey-read", c);
  }
  assert.equal(g("bash", { command: "cat ~/x.txt" })?.rule, undefined, "a plain tilde read keeps its old (unallowed) verdict");
});

test("ssh-keygen fingerprint spellings are read-class, key-printing and writing flags are not", () => {
  for (const c of [`ssh-keygen -l -f ${K}`, `ssh-keygen -lf ${K}`, `ssh-keygen -l -E md5 -f ${K}`, `ssh-keygen -l -E sha256 -f ${K}`]) assert.equal(line(c), null, c);
  for (const c of [`ssh-keygen -y -f ${K}`, `ssh-keygen -p -f ${K}`, `ssh-keygen -c -f ${K}`, `ssh-keygen -R ${K}`, `ssh-keygen -l -f ${K} -p`]) assert.equal(line(c), "floor-secret-path", c);
});

// round 2: bare programs only, every PowerShell operand a verified key, no HOME binding
const gateRule = (command: string): string | undefined => {
  const roots = { worktree: work, scratch: [], tmp: [], scratchBase: path.join(base, "scr"), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false } as never;
  return (gateDecide("bash", { command }, work, { env: () => env, roots: () => roots }) as { rule?: string } | undefined)?.rule;
};

test("a path-qualified program gets no pubkey rule", () => {
  const fwd = (p: string): string => p.replace(/\\/g, "/");
  for (const c of [`./cat ${K}`, `~/bin/cat ${K}`, `/tmp/x/cat ${fwd(ssh)}/k.pub`, `${fwd(work)}/cat ${fwd(ssh)}/k.pub`]) {
    assert.notEqual(gateRule(c), "floor-pubkey-read", c);
  }
  assert.equal(gateRule(`cat ${K}`), "floor-pubkey-read");
});

test("a backslash path in a bash line is an escape, so it names no key", () => {
  for (const c of [`cat ${home}\\.ssh\\k.pub`]) assert.notEqual(gateRule(c), "floor-pubkey-read", c);
});

test("a line that binds HOME gets no pubkey rule", () => {
  for (const c of ["HOME=/x cat $HOME/.ssh/k.pub", `export HOME=/x; cat ${K}`, `HOME=/x; cat ${K}`]) {
    assert.notEqual(gateRule(c), "floor-pubkey-read", c);
  }
});

test("win32 powershell: every operand must be a verified key", () => {
  const ps = (command: string): string => ov("powershell", { command }, { platform: "win32", shell: "powershell" });
  assert.equal(ps("Get-Content ${env:USERPROFILE}\\.ssh\\k.pub \\.ssh\\k.pub"), "deny");
  assert.equal(ps("Get-Content $env:USERPROFILE\\.ssh\\k.pub \\.ssh\\k.pub"), "deny");
  assert.equal(ps("Get-Content %USERPROFILE%\\.ssh\\k.pub \\.ssh\\k.pub"), "deny");
  assert.equal(ps("Get-Content \\.ssh\\k.pub"), "deny");
  for (const w of ["${env:USERPROFILE}\\.ssh\\k.pub", "$env:USERPROFILE\\.ssh\\k.pub", "%USERPROFILE%\\.ssh\\k.pub"]) assert.equal(ps(`Get-Content ${w}`), "pass", w);
  assert.equal(ps("Get-Content ${env:USERPROFILE}\\.ssh\\k.pub -TotalCount 1"), "pass");
});
