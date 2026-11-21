// The default Python lists have one source (profiles.mjs); the bin/ launchers keep a copy of their own, pinned equal here (test-only text reading).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { POSIX_PYTHONS, WIN_PYTHONS } from "../profiles.mjs";
import { pythonCandidates } from "../python.ts";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const text = (f: string): string => fs.readFileSync(path.join(BIN, f), "utf8");
const winList = WIN_PYTHONS.map((c) => [c.command, ...c.args].join(" "));

for (const f of ["foreman", "ledger", "foreman-worktree-setup"]) {
  test(`bin/${f} tries the POSIX list of profiles.mjs, in order`, () => {
    const m = /for c in ([^;]+); do/.exec(text(f));
    assert.ok(m, "a `for c in` list");
    assert.deepEqual(m[1].trim().split(/\s+/), POSIX_PYTHONS);
  });
}

for (const f of ["foreman.cmd", "ledger.cmd"]) {
  test(`bin/${f} tries the Windows list of profiles.mjs, in order`, () => {
    const t = text(f);
    const names = [...t.matchAll(/^where (\S+) >nul/gm)].map((m) => m[1]).filter((n) => n !== "node");
    assert.deepEqual(names, WIN_PYTHONS.map((c) => c.command));
    const args = [...t.matchAll(/^set "PF_PYARGS=([^"]*)"/gm)].map((m) => m[1]).filter(Boolean);
    assert.deepEqual(args, WIN_PYTHONS.flatMap((c) => c.args));
  });
}

for (const f of ["foreman.ps1", "ledger.ps1"]) {
  test(`bin/${f} tries the Windows list of profiles.mjs, in order`, () => {
    const got = [...text(f).matchAll(/Name = '([^']+)'; Pre = @\(([^)]*)\)/g)].map((m) => [m[1], ...m[2].split(",").map((a) => a.trim().replace(/^'|'$/g, "")).filter(Boolean)].join(" "));
    assert.deepEqual(got, winList);
  });
}

test("the adapter's resolver builds its defaults from the same lists", () => {
  assert.deepEqual(pythonCandidates({ platform: "linux" }).map((c) => c.command), POSIX_PYTHONS);
  assert.deepEqual(pythonCandidates({ platform: "win32" }).map((c) => [c.command, ...c.args].join(" ")), winList);
});
