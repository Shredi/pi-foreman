// Ledger r8 items 5/6: Windows child-bash classification. Git Bash runs the line, so parseShell (posix) is what bash executes:
// an unquoted `C:\x` is `C:x` (drive-relative), `"C:\x"` / `'C:\x'` keep `C:\x`. shellvars.ts resolves the win32 value forms
// (`X:/...`, quoted `X:\...`, a native $PWD / $FOREMAN_SCRATCH) only for platform "win32". Simulated win32 (injected platform,
// path.win32 fixtures, no file system) runs on every host; each test is named by its literal shell line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../psunits.ts";
import { readBaseline } from "../baseline.ts";
import { resolveVars } from "../shellvars.ts";
import { classify } from "../effects.ts";
import type { EffectCtx } from "../effects.ts";
import { splitChain } from "../shellchain.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

// win32 world: worktree C:\w\proj, scratch C:\t\pfs\s1
const wCwd = "C:\\w\\proj";
const wScratch = "C:\\t\\pfs\\s1";

// the POSIX twin: worktree /w/proj, scratch /t/pfs/s1
const pCwd = "/w/proj";
const pScratch = "/t/pfs/s1";

/** The resolved words of the last changed unit (resolveVars on the posix parse), or null when nothing resolves. */
const resolved = (line: string, platform: string, env: Record<string, string>): string[] | null => {
  const p = parseShell(line);
  const r = [...resolveVars(p.pipelines, p.seps, env, () => false, line, platform).values()];
  return r.length ? r[r.length - 1] : null;
};
const wEnv = { FOREMAN_SCRATCH: wScratch, PWD: wCwd };
const pEnv = { FOREMAN_SCRATCH: pScratch, PWD: pCwd };

test("win32: H=C:/Profiles/RUNNER~1/x; cat $H/f (an 8.3 short-name tilde resolves)", () => {
  assert.deepEqual(resolved("H=C:/Profiles/RUNNER~1/x; cat $H/f", "win32", wEnv), ["cat", "C:/Profiles/RUNNER~1/x/f"]);
  assert.deepEqual(resolved("cd C:/Profiles/RUNNER~1; H=$PWD; cat $H/f", "win32", wEnv), ["cat", "C:\\Profiles\\RUNNER~1/f"]);
  // a tilde bash may expand never resolves: at a word start, after `/`, `=` or `:`, or before a non-digit
  for (const line of ["H=C:/Profiles/~1; cat $H/f", "H=C:/a~b; cat $H/f", "H=/x; cat ~$H"]) assert.equal(resolved(line, "win32", wEnv), null, line);
});

// ---------------------------------------------------------------- the quoted native forms resolve to the native path

test('win32: H="C:\\Profiles\\u\\.ssh"; cat $H/id_rsa resolves to the native path', () => {
  assert.deepEqual(resolved('H="C:\\Profiles\\u\\.ssh"; cat $H/id_rsa', "win32", wEnv), ["cat", "C:\\Profiles\\u\\.ssh/id_rsa"]);
  assert.deepEqual(resolved("H='C:\\Profiles\\u\\.ssh'; cat $H/id_rsa", "win32", wEnv), ["cat", "C:\\Profiles\\u\\.ssh/id_rsa"]);
  // in double quotes `\\` is one `\` (a UNC path needs four); two leave the root-relative `\srv\share`: not certain
  assert.deepEqual(resolved('H="\\\\\\\\srv\\\\share"; cat $H/f', "win32", wEnv), ["cat", "\\\\srv\\share/f"]);
  assert.equal(resolved('H="\\\\srv\\share"; cat $H/f', "win32", wEnv), null);
  // a trailing `\` escapes the closing quote: outside the grammar
  assert.equal(resolved('H="C:\\x\\"; cat $H/f', "win32", wEnv), null);
});

test("win32: cd C:x; H=$PWD/.ssh; cat $H/id_rsa (a drive-relative cd makes the tracked cwd unknown)", () => {
  assert.equal(resolved("cd C:x; H=$PWD/.ssh; cat $H/id_rsa", "win32", wEnv), null);
  assert.equal(resolved("cd C:\\w; H=$PWD; cat $H/f", "win32", wEnv), null, "the posix parse leaves C:w");
});

const eRoot = "C:\\w\\proj";
const eExists = (p: string): boolean => /^c:\\w(\\proj(\\(f|src|src\\main\\.go))?)?$/i.test(p) || /^c:\\t(\\pfs(\\s1)?)?$/i.test(p);
const ectx: EffectCtx = { cwd: eRoot, root: eRoot, scratch: [wScratch], platform: "win32", realpath: (p) => (eExists(p) ? path.win32.resolve(p) : null), exists: eExists, isFile: (p) => /\\f$/i.test(p), isDir: (p) => eExists(p) && !/\\f$/i.test(p), isLink: () => false, readFile: () => null };
const allowW = (cmd: string): string | null => deterministicAllow(bashRules(baseline, {}), cmd, { scratchDirs: [wScratch], effects: ectx, platform: "win32" });

test("win32 effects: cat C:\\w\\proj\\f (unquoted) is no read; no deterministic allow", () => {
  assert.equal(splitChain("cat C:\\w\\proj\\f"), null);
  assert.equal(classify("cat C:\\w\\proj\\f", ectx), "unknown");
  assert.equal(allowW("cat C:\\w\\proj\\f"), null);
  assert.equal(classify("cat C:wprojf", ectx), "unknown", "what bash runs: drive-relative");
});

test("win32 effects: cp f C:\\w\\proj\\g (unquoted writer) is not write-in; no deterministic allow", () => {
  assert.equal(classify("cp f C:\\w\\proj\\g", ectx), "unknown");
  assert.equal(allowW("cp f C:\\w\\proj\\g"), null);
  assert.equal(classify("cp f C:wprojg", ectx), "write-out", "what bash runs: a drive-relative target is outside");
  assert.equal(allowW("cp f C:wprojg"), null);
});

test("win32 effects: cat C:/w/proj/f and cat 'C:\\w\\proj\\f' are reads inside the worktree; cat \"C:\\w\\proj\\f\" is no allow", () => {
  assert.equal(classify("cat C:/w/proj/f", ectx), "read");
  assert.equal(classify("cat 'C:\\w\\proj\\f'", ectx), "read");
  // splitChain models no `\` inside double quotes: fail closed, no deterministic allow
  assert.equal(classify('cat "C:\\w\\proj\\f"', ectx), "unknown");
  assert.equal(allowW('cat "C:\\w\\proj\\f"'), null);
  assert.equal(classify("cat C:/Profiles/u/.ssh/id_rsa", ectx), "unknown");
});

// ---------------------------------------------------------------- resolved words (rescued from the deleted overlay half of the tests)

test("win32: S=$FOREMAN_SCRATCH; mkdir -p $S/x resolves to the native scratch", () => {
  assert.deepEqual(resolved("S=$FOREMAN_SCRATCH; mkdir -p $S/x", "win32", wEnv), ["mkdir", "-p", "C:\\t\\pfs\\s1/x"]);
});

test("win32: cd C:/w/proj; S=$PWD/out; cat $S/f resolves under the native cwd", () => {
  assert.deepEqual(resolved("cd C:/w/proj; S=$PWD/out; cat $S/f", "win32", wEnv), ["cat", "C:\\w\\proj/out/f"]);
});

test("win32: H=C:\\Profiles\\u\\.ssh; cat $H/id_rsa (unquoted) stays unresolved", () => {
  assert.equal(resolved("H=C:\\Profiles\\u\\.ssh; cat $H/id_rsa", "win32", wEnv), null);
  assert.equal(allowW("H=C:\\w\\proj; cat $H/f"), null, "no deterministic allow");
});

test("posix: S=$FOREMAN_SCRATCH; mkdir -p $S/x resolves to the posix scratch", () => {
  assert.deepEqual(resolved("S=$FOREMAN_SCRATCH; mkdir -p $S/x", "linux", pEnv), ["mkdir", "-p", "/t/pfs/s1/x"]);
});

// ---------------------------------------------------------------- POSIX twins: no change off win32

test("posix: H=C:/Profiles/u/.ssh; cat $H/id_rsa (no win32 forms off win32)", () => {
  for (const line of ["H=C:/Profiles/u/.ssh; cat $H/id_rsa", 'H="C:\\Profiles\\u\\.ssh"; cat $H/id_rsa', "H='C:\\x'; cat $H/f", "H=/a/RUNNER~1; cat $H/f"]) {
    for (const platform of ["linux", "darwin"]) assert.equal(resolved(line, platform, pEnv), null, `${platform}: ${line}`);
  }
  // a native base is not certain off win32
  assert.equal(resolved("S=$FOREMAN_SCRATCH; cat $S/f", "linux", wEnv), null);
  // `cd C:x` off win32 is a relative directory name, as before
  assert.deepEqual(resolved("cd C:x; H=$PWD; cat $H/f", "linux", pEnv), ["cat", "/w/proj/C:x/f"]);
});
