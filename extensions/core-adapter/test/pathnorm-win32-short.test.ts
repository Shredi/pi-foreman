// r79 item 16, Windows CI (8.3 short tmpdir names): a path spelled `C:/Users/RUNNER~1/...` is a literal word, and a short and a long spelling of one
// directory meet in the one normaliser. A stubbed win32 file system, as in gate-floors-win32.test.ts (`RUNNER~1` is the 8.3 alias of `runneradmin`).
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("a git attributes file under .workflow/ spelled with an 8.3 name is a literal path (not floored); outside it is", () => {
  const env: FloorEnv = { platform: "win32", cwd: "C:\\Users\\runneradmin\\wt", home: "C:\\Users\\runneradmin", resolver };
  const hit = (v: string) => lineFloors(`git -c core.attributesFile=${v} merge x`, parseShell(`git -c core.attributesFile=${v} merge x`, { cwd: env.cwd }), env)?.rule ?? null;
  assert.equal(hit("C:/Users/runneradmin/wt/.workflow/a"), null);
  assert.equal(hit("C:/Users/RUNNER~1/wt/.workflow/a"), null);
  assert.equal(hit("C:/Users/RUNNER~1/wt/src/a"), "floor-git-attributes-file");
});

test("rm of a glob under the worktree spelled short is inside; the same glob outside it is floor-delete-outside", () => {
  const env: FloorEnv = { platform: "win32", cwd: "C:\\Users\\runneradmin\\wt", home: "C:\\Users\\runneradmin", writeRoots: ["C:\\Users\\runneradmin\\wt"], resolver };
  const rule = (l: string) => lineFloors(l, parseShell(l, { cwd: env.cwd }), env)?.rule ?? null;
  assert.equal(rule("rm C:/Users/RUNNER~1/wt/.workflow/notes?.md"), null);
  assert.equal(rule("rm C:/Users/runneradmin/wt/.workflow/notes?.md"), null);
  assert.equal(rule("rm C:/Users/RUNNER~1/other/notes?.md"), "floor-delete-outside");
});
