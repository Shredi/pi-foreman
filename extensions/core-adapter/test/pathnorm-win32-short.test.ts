// r79 item 16, Windows CI (8.3 short tmpdir names): a path spelled `C:/Users/RUNNER~1/...` is a literal word, and a short and a long spelling of one
// directory meet in the one normaliser. A stubbed win32 file system, as in gate-floors-win32.test.ts (`RUNNER~1` is the 8.3 alias of `runneradmin`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PermStore, type GitRun } from "../permconfig.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { sameOrUnder, tildeWord, type Resolver } from "../pathnorm.ts";
import { webReadAllow } from "../webread.ts";

const TABLE = new Map<string, string>([
  ["c:\\users", "C:\\Users"],
  ["c:\\users\\runneradmin", "C:\\Users\\runneradmin"],
  ["c:\\users\\runner~1", "C:\\Users\\runneradmin"],
  ["c:\\users\\runneradmin\\wt", "C:\\Users\\runneradmin\\wt"],
  ["c:\\users\\runner~1\\wt", "C:\\Users\\runneradmin\\wt"],
  ["c:\\users\\runneradmin\\wt\\.workflow", "C:\\Users\\runneradmin\\wt\\.workflow"],
  ["c:\\users\\runner~1\\wt\\.workflow", "C:\\Users\\runneradmin\\wt\\.workflow"],
  ["c:\\users\\runneradmin\\scr", "C:\\Users\\runneradmin\\scr"],
  ["c:\\users\\runner~1\\scr", "C:\\Users\\runneradmin\\scr"],
]);
const resolver: Resolver = (p) => TABLE.get(p.replace(/\//g, "\\").toLowerCase()) ?? null;

test("tildeWord: only a leading or assignment tilde expands; an 8.3 name does not", () => {
  for (const w of ["~", "~/x", "a=~/x", "--file=~/x", "PATH=a:~/b"]) assert.equal(tildeWord(w), true, w);
  for (const w of ["C:/Users/RUNNER~1/AppData", "C:\\Users\\RUNNER~1\\x", "/tmp/a~b", "x"]) assert.equal(tildeWord(w), false, w);
});

test("short/long: sameOrUnder meets the two spellings of the scratch dir", () => {
  assert.ok(sameOrUnder("win32", "C:\\Users\\RUNNER~1\\scr", "C:\\Users\\runneradmin\\scr\\mine\\p", "C:\\work", resolver));
  assert.ok(sameOrUnder("win32", "C:\\Users\\runneradmin\\scr", "C:/Users/RUNNER~1/scr/mine/p", "C:\\work", resolver));
  assert.ok(!sameOrUnder("win32", "C:\\Users\\RUNNER~1\\scr", "C:/Users/RUNNER~1/scrx/p", "C:\\work", resolver));
});

test("curl -o into the own scratch spelled with an 8.3 name is a web read; a tilde expansion still is not", () => {
  // host-native paths (webread resolves with the host's path module); the `~` in the name is what the check must not trip on
  const ctx = { cwd: "/work", scratch: ["/Users/RUNNER~1/scr"] };
  const v = (cmd: string) => webReadAllow("bash", { command: cmd }, ctx);
  assert.equal(v("curl -sS https://example.com/p -o /Users/RUNNER~1/scr/mine/p").ok, true);
  assert.equal(v("curl -sS https://example.com/p -o /Users/RUNNER~1/other/p").ok, false);
  assert.equal(v("curl -sS https://example.com/p -o ~/p").ok, false);
});

// pre-fix: isWord rejected every `~`, so the `-c core.attributesFile=C:/Users/RUNNER~1/...` value was not a literal word and the line floored (floor-git-attributes-file)
test("a git attributes file under .workflow/ spelled with an 8.3 name is a literal path (not floored); outside it is", () => {
  const env: FloorEnv = { platform: "win32", cwd: "C:\\Users\\runneradmin\\wt", home: "C:\\Users\\runneradmin", resolver };
  const hit = (v: string) => lineFloors(`git -c core.attributesFile=${v} merge x`, parseShell(`git -c core.attributesFile=${v} merge x`, { cwd: env.cwd }), env)?.rule ?? null;
  assert.equal(hit("C:/Users/runneradmin/wt/.workflow/a"), null);
  assert.equal(hit("C:/Users/RUNNER~1/wt/.workflow/a"), null);
  assert.equal(hit("C:/Users/RUNNER~1/wt/src/a"), "floor-git-attributes-file");
});

// pre-fix: resolveWord read `env.platform === "win32"` only, so with no env.platform (the real run, platform = process.platform) the win32 path was resolved
// with posix rules and the short-spelled worktree was outside: floor-delete-outside. The case sets no env.platform and overrides process.platform instead.
test("rm of a glob under the worktree spelled short is inside; the same glob outside it is floor-delete-outside", () => {
  const env: FloorEnv = { cwd: "C:\\Users\\runneradmin\\wt", home: "C:\\Users\\runneradmin", writeRoots: ["C:\\Users\\runneradmin\\wt"], resolver };
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...orig, value: "win32" });
  try {
    const rule = (l: string) => lineFloors(l, parseShell(l, { cwd: env.cwd }), env)?.rule ?? null;
    assert.equal(rule("rm C:/Users/RUNNER~1/wt/.workflow/notes?.md"), null);
    assert.equal(rule("rm C:/Users/runneradmin/wt/.workflow/notes?.md"), null);
    assert.equal(rule("rm C:/Users/RUNNER~1/other/notes?.md"), "floor-delete-outside");
  } finally {
    Object.defineProperty(process, "platform", orig);
  }
});

// (core.hooksPath, not core.editor: only a floored key makes the exemption observable.)
// pre-fix: the config target and the scratch root were compared in one spelling each, and the `~` in `RUNNER~1` made the git line a non-literal word, so
// `git config` under the own scratch with a short-spelled root was not exempt: floor-git-config
test("git config --file under the own scratch is exempt when spelled short (8.3) like its root; a mixed spelling stays floored", () => {
  // drive-less spellings: configTargets resolves the operand with the host's path module, so this reads the same on every host
  const short = new Map<string, string>([["\\users\\runneradmin", "\\Users\\runneradmin"], ["\\users\\runner~1", "\\Users\\runneradmin"], ["\\users\\runneradmin\\scr", "\\Users\\runneradmin\\scr"], ["\\users\\runner~1\\scr", "\\Users\\runneradmin\\scr"]]);
  const f = (scratch: string, file: string): string | null => {
    const env: FloorEnv = { platform: "win32", cwd: "/work", home: "/Users/runneradmin", scratch: [scratch], resolver: (p) => short.get(p.replace(/\//g, "\\").toLowerCase()) ?? null };
    const l = `git config --file ${file} core.hooksPath x`;
    return lineFloors(l, parseShell(l, { cwd: env.cwd }), env)?.rule ?? null;
  };
  // every spelling of the target must sit under some spelling of the root, so a mixed pair stays floored (conservative); the same spelling of both is exempt
  assert.equal(f("/Users/RUNNER~1/scr", "/Users/RUNNER~1/scr/mine/cfg"), null);
  assert.equal(f("/Users/runneradmin/scr", "/Users/runneradmin/scr/mine/cfg"), null);
  assert.equal(f("/Users/runneradmin/scr", "/Users/RUNNER~1/scr/mine/cfg"), "floor-git-config");
  assert.equal(f("/Users/runneradmin/scr", "/Users/RUNNER~1/other/cfg"), "floor-git-config");
});

const tmp = fs.realpathSync.native(mkTestTmp("pf79-short-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// pre-fix: permconfig.test.ts compared fs.realpathSync (which keeps a win32 8.3 tmpdir name) with git's long spelling, so the trust check's canonical path
// mismatched on Windows CI. The source is unchanged; this pins that the trust check accepts git's long spelling of the main checkout when cwd is spelled otherwise.
test("trust check: the main checkout git reports (long spelling) is the canonical path of the one the tmpdir spells (short)", () => {
  const main = path.join(tmp, "main");
  const wt = path.join(tmp, "wt");
  fs.mkdirSync(path.join(main, ".workflow"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(main, ".workflow", "permissions.json"), JSON.stringify({ allow: ["Bash(p *)"] }));
  const git: GitRun = (args) => {
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${fs.realpathSync.native(main)}\nHEAD abc\n\nworktree ${wt}\nHEAD abc\n` };
    return { status: args[0] === "check-ignore" ? 0 : 1, stdout: "" };
  };
  const s = new PermStore({ agentDir: path.join(tmp, "agent"), cwd: wt, home: tmp, git });
  assert.equal(fs.realpathSync.native(s.main()), fs.realpathSync.native(main));
  assert.equal(s.projectDistrust(), null);
  assert.equal(s.resolve().projectTrusted, true);
});
