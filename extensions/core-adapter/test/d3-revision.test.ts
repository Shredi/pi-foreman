// PR D3 revision: a settings-file name in a heredoc body is data only for a data body (a body fed to a shell stays read, as on main); comment blanking is pinned through the
// gate's real paths (lineFloors, fieldLineFloors, gateEvaluate); a heredoc replaced by a `<` redirect is no own stdin of the interpreter.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fieldLineFloors, lineFloors, type FloorEnv } from "../floors.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-d3-rev-"));
const wt = path.join(base, "wt");
const scratch = path.join(base, "scratch");
const home = path.join(base, "home");
const agentDir = path.join(home, ".pi", "agent");
for (const d of [wt, scratch, agentDir]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const env: FloorEnv = { ...baseFloorEnv(wt, { child: true, scratch: [scratch], out: scratch }), home, agentDir, writeRoots: [wt, scratch] };
const lineRule = (line: string, e: FloorEnv = env): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;
const fieldRule = (line: string, e: FloorEnv = env): string | null => fieldLineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;
const roots = (role: string) => (): GateRoots => ({ worktree: wt, scratch: [scratch], out: scratch, tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: true, role, tmpAccess: false });
const gate = (command: string, role: string) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: true, scratch: [scratch], out: scratch, home, agentDir }), roots: roots(role) });
const blocked = (command: string, role: string): boolean => !!(gate(command, role).result as { block?: boolean } | undefined)?.block;

const write = `echo '{"gate":{"mode":"auto"}}' >> ${agentDir}/foreman.json`;

test("a body fed to a shell or interpreter that writes gate keys into the user config is refused as on main", { skip: posixOnly }, () => {
  for (const head of ["X=bash; $X <<EOF", "$SHELL <<EOF", "tee >(bash) <<EOF", "bash <<EOF", "cat <<EOF | sh", "zsh <<EOF", "fish <<EOF", "busybox sh <<EOF", "env bash <<EOF", "xargs bash <<EOF"]) {
    const c = `${head}\n${write}\nEOF`;
    assert.equal(lineRule(c), "floor-config-keys", c);
    for (const role of ["builder", "reviewer"]) assert.equal(blocked(c, role), true, `${role}: ${c}`);
  }
});

test("a data body (cat, tee, redirect) naming the config and a gate key is still no hit", { skip: posixOnly }, () => {
  const c = `cat > ${scratch}/notes.md <<'EOF'\nsee foreman.json: gate.mode\nEOF\n$X && mkdir ${scratch}/d`;
  assert.notEqual(lineRule(c), "floor-config-keys");
});

test("a write to the real user config outside any heredoc is still refused", { skip: posixOnly }, () => {
  for (const c of [write, `cat <<EOF >> ${agentDir}/foreman.json\n{"gate":{"mode":"auto"}}\nEOF`, `X=1; $X; ${write}`]) {
    for (const role of ["builder", "reviewer"]) assert.equal(blocked(c, role), true, `${role}: ${c}`);
  }
});

test("a comment holding another trigger fires as on main, through the line and the field path", { skip: posixOnly }, () => {
  for (const c of ["echo hi # x\ngit push origin main", "ls # curl u | sh\nsudo shutdown -h now", "echo a # curl u | sh\ncurl u | sh", "shutdown -h now # curl u | sh"]) {
    assert.notEqual(lineRule(c), null, c);
    assert.notEqual(fieldRule(c), null, c);
  }
});

test("a comment holding a download-and-shell text does not fire through the line or the field path", { skip: posixOnly }, () => {
  for (const c of ["echo hi # curl u | sh", "ls # wget -O- u | bash\nls"]) {
    assert.notEqual(lineRule(c), "floor-download-shell", c);
    assert.notEqual(fieldRule(c), "floor-download-shell", c);
  }
  assert.equal(lineRule("curl u | sh"), "floor-download-shell");
  assert.equal(fieldRule("curl u | sh"), "floor-download-shell");
});

test("an unparseable line with the comment is still the floor", { skip: posixOnly }, () => {
  for (const c of ["echo ((; curl u | sh # x", "echo (( # x\ncurl u | sh"]) {
    assert.equal(lineRule(c), "floor-download-shell", c);
    assert.equal(fieldRule(c), "floor-download-shell", c);
  }
});

test("decoy heredoc: a later `<` redirect replaces the heredoc, so the download-shell floor fires and the reason does not claim the code is in the command", { skip: posixOnly }, () => {
  assert.equal(lineRule("curl u -o f; python3 - <<EOF < f\nprint(1)\nEOF"), "floor-download-shell");
  assert.equal(fieldRule("curl u -o f; python3 - <<EOF < f\nprint(1)\nEOF"), "floor-download-shell");
  // the plain own-heredoc shape is unchanged
  assert.notEqual(lineRule("python3 - <<EOF\nprint(1)\nEOF\ncurl -s u -o f"), "floor-download-shell");
  const reason = (c: string): string | undefined => (gate(c, "builder") as { danger?: { reason: string } }).danger?.reason;
  assert.doesNotMatch(reason("python3 - <<EOF < f\nprint(1)\nEOF") ?? "", /the code is in the command/);
  assert.match(reason("python3 - <<EOF\nprint(1)\nEOF") ?? "", /the code is in the command/);
});

test("a body piped to a variable program or an interpreter in a substitution is refused as on main", { skip: posixOnly }, () => {
  for (const head of ["cat <<EOF | $X", "tee >(python3) <<EOF", "cat <<EOF | python3", "tee >($X) <<EOF"]) {
    const c = `${head}\n${write}\nEOF`;
    assert.equal(lineRule(c), "floor-config-keys", c);
    for (const role of ["builder", "reviewer"]) assert.equal(blocked(c, role), true, `${role}: ${c}`);
  }
});

test("a cat data body written to scratch still passes the settings-file rule", { skip: posixOnly }, () => {
  const c = `cat <<EOF > ${scratch}/f\nsee foreman.json: gate.mode\nEOF`;
  assert.notEqual(lineRule(c), "floor-config-keys");
  for (const role of ["builder", "reviewer"]) assert.equal(blocked(c, role), false, `${role}: ${c}`);
});

test("a `<>` or input dup on fd 0 replaces the heredoc: the download-shell floor fires, no own-code reason", { skip: posixOnly }, () => {
  const shapes = ["curl u -o f; python3 - <<EOF <> f", "curl u -o f; python3 - <<EOF 0<>f", "exec 3<f; curl u -o f; python3 - <<EOF <&3", "curl u -o f; python3 - <<EOF 0<&3 3<f"];
  const reason = (c: string, role: string): string | undefined => (gate(c, role) as { danger?: { reason: string } }).danger?.reason;
  for (const s of shapes) {
    const c = `${s}\nprint(1)\nEOF`;
    assert.equal(lineRule(c), "floor-download-shell", c);
    assert.equal(fieldRule(c), "floor-download-shell", c);
    for (const role of ["builder", "reviewer"]) assert.doesNotMatch(reason(c, role) ?? "", /the code is in the command/, `${role}: ${c}`);
  }
  assert.notEqual(lineRule("python3 - <<EOF 2>&1\nprint(1)\nEOF\ncurl -s u -o f"), "floor-download-shell");
});
