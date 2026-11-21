import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDest } from "../tmpscratch.ts";

// A fake file system: /tmp exists (really /private/tmp, as on macOS), /tmp/out links outside,
// /tmp/link is a symlink that stays inside /tmp, /tmp/dir is a real directory holding a planted /tmp/dir/b that links outside.
const links: Record<string, string> = { "/tmp": "/private/tmp", "/tmp/out": "/srv/x", "/tmp/link": "/private/tmp/other", "/tmp/dir": "/private/tmp/dir", "/tmp/dir/b": "/srv/y" };
const deps = { exists: (p: string) => p in links, realpath: (p: string) => links[p] ?? null };

test("tmpDest: new paths under /tmp and an existing real dir pass", () => {
  for (const d of ["/tmp/x", "/tmp/work/", "/tmp/x/y.txt", "/tmp/y/z", "/tmp/dir"]) assert.ok(tmpDest(d, deps), d);
});

test("tmpDest: /tmp itself, escapes, relative paths and planted links are refused", () => {
  for (const d of ["/tmp", "/tmp/", "/tmp/../etc/x", "/tmp/x/../../etc/y", "/srv/y", "~/x", "x", "/tmp/out/x", "/tmp/link", "/tmp/dir/b/c"]) assert.ok(!tmpDest(d, deps), d);
});
