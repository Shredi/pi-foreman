// A5: the null device is no write: /dev/null on every platform, NUL (any case) on win32 only (on darwin/linux `> NUL` creates a file).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writesOutside } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { redirectOk } from "../effects.ts";
import { nullDevice } from "../pathnorm.ts";
import { ruleCallOf } from "../rules.ts";
import { parseShell } from "../shellast.ts";
import { splitChain } from "../shellchain.ts";

const redirects = (line: string) => (splitChain(line)?.segments ?? []).flatMap((s) => s.redirects);

test("nullDevice: /dev/null everywhere, NUL case-folded on win32 only", () => {
  for (const p of ["win32", "darwin", "linux"]) assert.equal(nullDevice(p, "/dev/null"), true, p);
  for (const t of ["NUL", "nul", "Nul"]) {
    assert.equal(nullDevice("win32", t), true, t);
    assert.equal(nullDevice("darwin", t), false, t);
    assert.equal(nullDevice("linux", t), false, t);
  }
  assert.equal(nullDevice("win32", "NULL"), false);
  assert.equal(nullDevice("win32", "out/nul"), false);
});

test("redirectOk: >/dev/null, 2>/dev/null, &>/dev/null on every platform; >NUL and 2>nul on win32 only", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const line of ["ls >/dev/null", "ls 2>/dev/null", "ls &>/dev/null", "ls > /dev/null"]) {
      const rs = redirects(line);
      assert.equal(rs.length, 1, line);
      assert.equal(redirectOk(rs[0], null, null, [], platform), true, `${platform}: ${line}`);
    }
  }
  for (const line of ["ls >NUL", "ls 2>nul", "ls > NUL", "ls &>Nul"]) {
    const rs = redirects(line);
    assert.equal(rs.length, 1, line);
    assert.equal(redirectOk(rs[0], null, null, [], "win32"), true, `win32: ${line}`);
    assert.equal(redirectOk(rs[0], null, null, [], "darwin"), false, `darwin: ${line}`);
    assert.equal(redirectOk(rs[0], null, null, [], "linux"), false, `linux: ${line}`);
  }
});

test("writesOutside (defaults SINK): a NUL redirect is no write outside on win32", () => {
  const roots: GateRoots = { worktree: "/w", scratch: [], tmp: [], scratchBase: "/w/.s", owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false };
  const out = (line: string, platform: string) => writesOutside({ tool: "bash", input: { command: line }, segments: parseShell(line, { cwd: "/w" }), text: line }, { roots, platform, cwd: "/w" });
  for (const p of ["win32", "darwin", "linux"]) assert.equal(out("ls >/dev/null", p), false, p);
  assert.equal(out("ls >NUL", "win32"), false);
  assert.equal(out("ls 2>nul", "win32"), false);
  assert.equal(out("ls >NUL", "linux"), true);
});

test("allow-rule redirect rule: a NUL redirect is no write on win32, a file write elsewhere", () => {
  const writes = (line: string, platform: string) => {
    const segments = parseShell(line);
    return ruleCallOf("bash", { command: line }, { cwd: "/w", home: "/h", platform, segments }).segments?.[0].writesRedirect;
  };
  assert.equal(writes("ls >NUL", "win32"), false);
  assert.equal(writes("ls 2>nul", "win32"), false);
  assert.equal(writes("ls >NUL", "darwin"), true);
  assert.equal(writes("ls 2>nul", "linux"), true);
  for (const p of ["win32", "darwin", "linux"]) assert.equal(writes("ls &>/dev/null", p), false, p);
});
