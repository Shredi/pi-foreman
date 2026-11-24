// A heredoc inside a command substitution is no data for the policy-file scan: its output becomes another command's arguments.
// Expectations are those of base 8917c56d: floor-policy-file, an ask in main and a deny in a child (builder and reviewer roles alike).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

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

test("the top-level data heredoc onto an own scratch file stays silent", () => {
  const l = `cat > ${path.join(path.sep, "s", "scr", "probe.test.ts")} <<'EOF'\n${P}\nEOF\nnode --test ${path.join(path.sep, "s", "scr", "probe.test.ts")}`;
  assert.equal(shape(l, env), null);
  assert.equal(shape(l, { ...env, child: true }), null);
});
