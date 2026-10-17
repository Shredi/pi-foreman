// r9 item 3 (Windows CI id 139): os.tmpdir() on the runner is the 8.3 short form `C:\Users\RUNNER~1\AppData\Local\Temp`, and the
// overlay's default realpath (fs.realpathSync) keeps short names, so the child temp-write deny knew only the short spelling: a write
// to the long spelling `C:/Users/runneradmin/AppData/Local/Temp/...` (what realpathSync.native returns) passed. On win32 the temp
// roots, the candidates and the child's own dirs now also go through the native realpath, which expands 8.3 names.
// Simulated win32 (injected platform, path.win32 world, os.tmpdir() through TMPDIR, no file system); each test is named by its literal line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const SHORT = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
const LONG = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
const toLong = (p: string): string => p.replace(/^C:\\Users\\RUNNER~1(?=\\|$)/i, "C:\\Users\\runneradmin");
const toShort = (p: string): string => p.replace(/^C:\\Users\\runneradmin(?=\\|$)/i, "C:\\Users\\RUNNER~1");
const fwd = (p: string): string => p.replace(/\\/g, "/");
const wHome = "C:\\Users\\runneradmin";
const wCwd = "D:\\a\\pf\\pf";
const wScratch = path.win32.join(LONG, "pi-foreman-scratch", "sess-8a", "L-child");
const wRules = buildOverlayRules(baseline, {}, {}, path.win32.join(wHome, ".pi", "agent"), "C:\\pkg", undefined, false);
// the JS realpath keeps the short name (identity here); the native one expands it
const wctx = (scratch = wScratch): MatchCtx => ({ cwd: wCwd, home: wHome, platform: "win32", role: "child", scratch, exists: () => false, isDir: () => false, realpath: (p) => p, realpathNative: toLong, list: () => [] });
const sh = (command: string, scratch?: string) => checkToolCall(wRules, "bash", { command }, wctx(scratch));

function withTmpdir(dir: string, fn: () => void): void {
  const old = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    fn();
  } finally {
    if (old === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = old;
  }
}

test("win32 child, temp dir C:\\Users\\RUNNER~1\\...\\Temp: echo x > C:/Users/runneradmin/AppData/Local/Temp/other/out.txt is denied (id 139)", () => {
  withTmpdir(SHORT, () => {
    const d = sh(`echo x > ${fwd(LONG)}/other/out.txt`);
    assert.equal(d?.kind, "deny");
    assert.match(d!.reason, /FOREMAN_SCRATCH/);
  });
});

test("win32 child, temp dir C:\\Users\\RUNNER~1\\...\\Temp: tee, cp and mkdir -p below C:/Users/runneradmin/AppData/Local/Temp are denied (id 139)", () => {
  withTmpdir(SHORT, () => {
    for (const c of [`echo x | tee ${fwd(LONG)}/out.txt`, `cp a.txt ${fwd(LONG)}/out.txt`, `mkdir -p ${fwd(LONG)}/d`]) assert.equal(sh(c)?.kind, "deny", c);
  });
});

test("win32 child, temp dir C:\\Users\\RUNNER~1\\...\\Temp: the write tool on C:\\Users\\runneradmin\\AppData\\Local\\Temp\\x.txt is denied (id 139)", () => {
  withTmpdir(SHORT, () => {
    const t = checkToolCall(wRules, "write", { path: path.win32.join(LONG, "x.txt"), content: "x" }, wctx());
    assert.equal(t?.kind, "deny");
    assert.ok(t!.reason.includes(wScratch), t!.reason);
  });
});

test("win32 child, temp dir C:\\Users\\RUNNER~1\\...\\Temp: echo x > C:/Users/RUNNER~1/AppData/Local/Temp/other/out.txt stays denied", () => {
  withTmpdir(SHORT, () => assert.equal(sh(`echo x > ${fwd(SHORT)}/other/out.txt`)?.kind, "deny"));
});

test("win32 child, temp dir C:\\Users\\runneradmin\\...\\Temp: echo x > C:/Users/RUNNER~1/AppData/Local/Temp/other/out.txt is denied (short spelling of a long temp dir)", () => {
  withTmpdir(LONG, () => assert.equal(sh(`echo x > ${fwd(SHORT)}/other/out.txt`)?.kind, "deny"));
});

test("win32 child: echo x > C:/Users/RUNNER~1/AppData/Local/Temp/link/out.txt with link -> its scratch stays denied (a symlink is no 8.3 alias)", () => {
  const link = path.win32.join(SHORT, "link");
  const viaLink = (p: string): string => (p.toLowerCase().startsWith(link.toLowerCase()) ? toShort(wScratch) + p.slice(link.length) : p);
  withTmpdir(SHORT, () => {
    const d = checkToolCall(wRules, "bash", { command: `echo x > ${fwd(link)}/out.txt` }, { ...wctx(), realpath: viaLink, realpathNative: (p) => toLong(viaLink(p)) });
    assert.equal(d?.kind, "deny");
  });
});

test("win32 child: its own scratch stays open under either spelling: echo x > <scratch>/out.txt (long and RUNNER~1 forms, scratch bound long or short)", () => {
  for (const tmp of [SHORT, LONG]) {
    withTmpdir(tmp, () => {
      for (const scratch of [wScratch, toShort(wScratch)]) {
        for (const word of [fwd(wScratch), fwd(toShort(wScratch))]) {
          const d = sh(`echo x > ${word}/out.txt`, scratch);
          assert.ok(!d || !/FOREMAN_SCRATCH/.test(d.reason), `${tmp} ${scratch} ${word}: ${d?.reason}`);
        }
      }
    });
  }
});
