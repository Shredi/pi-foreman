// R5 P2 S2 (ledger 11, R5/R5b/R5c): for children `</dev/null`, `<&-`, `2>&1`, `>/dev/null` are redirects, not operands or write targets;
// od/hexdump/xxd (without -r) are known readers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { childSurface } from "../roundsurface.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-rd-")));
after(() => rmTestTmp(base));
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
fs.mkdirSync(path.join(rt, "tests"), { recursive: true });
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(rt, "f"), "x\n");
fs.writeFileSync(path.join(rt, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc", "test:node": "node --test" } }));
fs.writeFileSync(path.join(rt, "tests", "test_a.py"), "");
// a run's script operands must be git-tracked inside the round worktree
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
const git = (...a: string[]): void => void execFileSync("git", ["-C", rt, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore", env: gitEnv });
if (posix) {
  git("init", "-q");
  git("add", ".");
}
const top = (d: string): string | null => (d.startsWith(rt) ? rt : null);
const r = buildOverlayRules(baseline, {}, {}, path.join(base, "agent"), pkgRoot, undefined, false);

const run = (role: string, command: string): string => {
  const s = childSurface([rt], rt, role, process.platform, top);
  return checkToolCall(r, "bash", { command }, { cwd: rt, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read })?.kind ?? "pass";
};

test("a reviewer's test runs with closed or null stdin pass", { skip: !posix }, () => {
  for (const cmd of [
    "npm run typecheck </dev/null",
    "npm run test:node </dev/null",
    "npm test </dev/null",
    "python3 -m unittest discover -s tests </dev/null",
    "npm run typecheck <&-",
    "npm run test:node <&-",
    "npm test <&-",
    "python3 -m unittest discover -s tests <&-",
    "npm test </dev/null 2>&1",
    "npm test 2>&1 </dev/null",
  ]) assert.equal(run("reviewer", cmd), "pass", cmd);
});

test("redirects to /dev/null and fd dups are no write targets for a reviewer", { skip: !posix }, () => {
  for (const cmd of ["cat f >/dev/null", "cat f > /dev/null 2>&1", "cat f 2>/dev/null", "git log --oneline -3 2>&1", "grep x f 2>&1 | head -3", "cat f 1>&2"]) assert.equal(run("reviewer", cmd), "pass", cmd);
});

test("real writes and real stdin files are still refused for a reviewer", { skip: !posix }, () => {
  for (const cmd of ["cat f > out.txt", "npm test > out.txt", "cat f >> out.txt", "npm test < .env", "npm test </dev/null > out.txt", "tee out.txt < f", "sed -i '' s/a/b/ f"]) assert.equal(run("reviewer", cmd), "deny", cmd);
});

test("od, hexdump and xxd (without -r) are known readers for a reviewer; xxd -r is not", { skip: !posix }, () => {
  for (const cmd of ["od -c f", "hexdump -C f", "xxd f", "xxd -l 16 f", "git show 3b77872 -- extensions/core-adapter/pressure.ts | head -40 | od -c", "cat f | xxd | head -3", "cat f | hexdump -C"]) assert.equal(run("reviewer", cmd), "pass", cmd);
  for (const cmd of ["xxd -r f out.bin", "xxd -r -p f", "cat f | xxd -r > out.bin", "xxd -r f"]) assert.equal(run("reviewer", cmd), "deny", cmd);
});
