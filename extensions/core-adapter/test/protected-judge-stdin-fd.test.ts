// The ssh stdin /dev/null exemption counts only input redirects on stdin (fd absent or 0); neutral fixtures (prod-db).
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectCtx } from "../effects.ts";
import { matchProtected } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import { parseShell } from "../shellast.ts";
import type { RuleCall } from "../rulecall.ts";

const cwd = process.cwd();
const env = { home: cwd, platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entries: ProtectedEntry[] = [{ id: "P1", kind: "host", glob: "prod-db", note: "production", source: "user" }];
const opaque = (line: string): boolean => {
  const segments = parseShell(line, { cwd });
  const m = matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
  assert.ok(m, line);
  return m.remoteOpaque;
};

test("a /dev/null redirect on another fd does not exempt a fed stdin", () => {
  assert.equal(opaque("cat s.sh | ssh prod-db bash 3</dev/null"), true);
  assert.equal(opaque("cat s.sh | ssh prod-db bash 3<>/dev/null"), true);
  assert.equal(opaque("ssh prod-db bash < s.sh 3</dev/null"), true);
});

test("a /dev/null redirect on stdin (fd 0) still exempts", () => {
  assert.equal(opaque("cat s | ssh prod-db bash 0</dev/null"), false);
});
