// Security review cycle 1 fixes (S1/S2, S3/S6, S10-S15, S17, S27, foreman_move/foreman_copy, Windows paths): what stays after the permission
// overlay was deleted is the baseline's find asks (S14) and isSelfHost.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline } from "../baseline.ts";
import { isSelfHost } from "../owned.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-harden-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cwd = path.join(root, "proj");
const pkgRoot = path.join(root, "pkg");
for (const d of [cwd, pkgRoot]) fs.mkdirSync(d, { recursive: true });

test("S14: find -exec/-execdir/-delete are asks in the baseline (PS prompts)", () => {
  for (const p of ["find * -exec*", "find * -execdir*", "find * -delete*"]) assert.ok(baseline.bash.ask.includes(p), p);
});

test("isSelfHost: equal, inside, sibling prefix, outside, symlinked cwd", () => {
  assert.equal(isSelfHost(pkgRoot, pkgRoot), true);
  fs.mkdirSync(path.join(pkgRoot, "sub"), { recursive: true });
  assert.equal(isSelfHost(path.join(pkgRoot, "sub"), pkgRoot), true);
  fs.mkdirSync(pkgRoot + "-x", { recursive: true });
  assert.equal(isSelfHost(pkgRoot + "-x", pkgRoot), false);
  assert.equal(isSelfHost(cwd, pkgRoot), false);
  assert.equal(isSelfHost(cwd, path.join(root, "agent", "git", "github.com", "o", "pi-foreman")), false); // package-cache clone outside cwd
  const link = path.join(root, "link");
  try {
    fs.symlinkSync(path.join(pkgRoot, "sub"), link, "dir");
    assert.equal(isSelfHost(link, pkgRoot), true);
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
  assert.equal(isSelfHost("C:\\Dev\\PI-Foreman\\x", "c:\\dev\\pi-foreman", "win32"), true);
  assert.equal(isSelfHost("C:\\Dev\\pi-foreman-x", "C:\\Dev\\pi-foreman", "win32"), false);
});
