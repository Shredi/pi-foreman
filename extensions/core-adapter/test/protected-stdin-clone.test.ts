// A cloned ssh segment loses the non-enumerable stdinFed fact: protected.ts must read that as fed (remote opaque), not as "no feed".
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ProtectedCache } from "../classifier.ts";
import type { ProtectedCall, ProtectedCheckCtx } from "../classifier.ts";
import { effectCtx } from "../effects.ts";
import { matchProtected } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import type { RuleCall } from "../rulecall.ts";
import { parseShell } from "../shellast.ts";
import type { ShellSegment } from "../shellast.ts";

const cwd = process.cwd();
const env = { home: path.join(cwd, "pf-prot-stdin-clone", "home"), platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entry: ProtectedEntry = { id: "P1", kind: "host", glob: "prod-db", source: "user" };
const line = "ssh prod-db 'vendorctl status'";

const matchOf = (segments: ShellSegment[]) =>
  matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, [entry], env);

const VERDICT = JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "reads" });
const registry = {
  find: () => ({ id: "m" }),
  complete: async () => ({ content: [{ type: "text", text: VERDICT }], stopReason: "stop", usage: { input: 1, output: 1 } }),
};

test("a spread-cloned ssh segment with no feed reads as fed: remote_opaque; the parsed one is not opaque", async () => {
  const parsed = parseShell(line, { cwd });
  const cloned = parsed.map((s) => ({ ...s }));
  assert.equal(cloned[0].stdinFed, undefined);
  const mc = matchOf(cloned);
  const mp = matchOf(parsed);
  assert.equal(mc?.remoteOpaque, true);
  assert.equal(mp?.remoteOpaque, false);
  const call: ProtectedCall = { tool: "bash", payload: line, kind: "owner", role: "foreman", cwd: "/w", worktree: "/w", branch: "main", remotes: [] };
  const run = async (match: NonNullable<typeof mc>) => {
    const c: ProtectedCheckCtx = { registry: registry as never, config: { providers: { fake: { roles: { review: { model: "fake/m" } } } } }, provider: "fake", timeoutMs: 200, match, task: "look", denyEntries: [], checkMode: "model", version: 1, away: false };
    return new ProtectedCache().check(call, c);
  };
  const rc = await run(mc!);
  assert.deepEqual([rc.accepted, rc.cause], ["refuse", "remote_opaque"]);
  assert.equal((await run(mp!)).accepted, "allow");
});
