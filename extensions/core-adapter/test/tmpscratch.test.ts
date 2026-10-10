import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline } from "../permoverlay.ts";
import { bashRules, deterministicAllow } from "../timeoutallow.ts";
import { isTmpScratch } from "../tmpscratch.ts";

// A fake file system: /tmp exists (really /private/tmp, as on macOS), /tmp/out links outside,
// /tmp/link is a symlink that stays inside /tmp, /tmp/dir is a real directory holding a planted /tmp/dir/b
// that links outside. `source` stands in for the effect context's read check (timeoutallow.ts).
const links: Record<string, string> = { "/tmp": "/private/tmp", "/tmp/out": "/srv/x", "/tmp/link": "/private/tmp/other", "/tmp/dir": "/private/tmp/dir", "/tmp/dir/b": "/srv/y" };
const deps = { platform: "linux", exists: (p: string) => p in links, realpath: (p: string) => links[p] ?? null, isDir: (p: string) => p === "/tmp/dir", source: (s: string) => !s.startsWith("/etc") };

test("isTmpScratch: cp and mkdir into /tmp are allowed", () => {
  for (const c of ["cp -r /app /tmp/x", "cp -Rp src a.txt /tmp/work/", "cp -a '/app dir' /tmp/x", "cp f /tmp/x/y.txt", "mkdir -p /tmp/x /tmp/y/z", "mkdir /tmp/x", "cp a /tmp/dir"])assert.ok(isTmpScratch(c, deps), c);
});

test("isTmpScratch: chains, rm, other destinations, escapes, redirects and Windows are refused", () => {
  for (const c of [
    "cp -r /app /tmp/x && rm -rf /app", "mkdir -p /tmp/x; ls", "cp a /tmp/x | tee b", "rm -rf /tmp/x", "cp -r /app /app2",
    "cp /etc/passwd /tmp", "mkdir -p /tmp", "mkdir -p /tmp/../etc/x", "cp a /tmp/x/../../etc/y", "cp a /tmp/x > log",
    "cp a $(echo /tmp/x)", "cp a `x` /tmp/y", "cp -f a /tmp/x", "cp -t /srv a", "cp a", "mkdir -m 777 /tmp/x",
    "cp a /tmp/out/x", "cp a /tmp/link","mkdir -p /tmp/x /srv/y", "cp /tmp/x/*.py /tmp/y", "mkdir -p ~/x",
  ]) assert.ok(!isTmpScratch(c, deps), c);
  assert.ok(!isTmpScratch("mkdir -p /tmp/x", { ...deps, platform: "win32" }));
});

test("isTmpScratch: sources pass the read check; into an existing dir the written path is checked; BSD cp -r refused", () => {
  assert.ok(!isTmpScratch("cp f /tmp/x", { ...deps, source: undefined }), "no read check, no cp");
  assert.ok(isTmpScratch("mkdir -p /tmp/x", { ...deps, source: undefined }));
  for (const c of ["cp /etc/hosts /tmp/x", "cp b /tmp/dir", "cp -R src /tmp/dir", "cp -a a /tmp/dir/"]) assert.ok(!isTmpScratch(c, deps), c);
  assert.ok(!isTmpScratch("cp -r src /tmp/x", { ...deps, platform: "darwin" }));
  assert.ok(isTmpScratch("cp -R src /tmp/x", { ...deps, platform: "darwin" }));
});

test("deterministicAllow: tmp-scratch label, unless a user's ask or deny rule catches it", () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const baseline = readBaseline(pkgRoot)!;
  assert.equal(deterministicAllow(bashRules(baseline, {}), "cp -r /app /tmp/x", deps), "tmp-scratch");
  assert.equal(deterministicAllow(bashRules(baseline, {}), "rm -rf /tmp/x", deps), null);
  assert.equal(deterministicAllow(bashRules(baseline, { safety: { permissions: { ask: ["cp *"] } } }), "cp -r /app /tmp/x", deps), null);
});
