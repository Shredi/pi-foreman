// matchProtected: ssh option words after the host, combined flags and `--` (review finding A; neutral fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { effectCtx } from "../effects.ts";
import { matchProtected } from "../protected.ts";
import type { ProtectedMatch } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import { parseShell } from "../shellast.ts";
import type { RuleCall } from "../rules.ts";

const cwd = process.cwd();
const home = path.join(cwd, "pf-prot-match-ssh", "home");
const env = { home, platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entries: ProtectedEntry[] = [{ id: "P1", kind: "host", glob: "prod-*.example.net", source: "user" }];
const sh = (line: string): ProtectedMatch | null => {
  const segments = parseShell(line, { cwd });
  return matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
};

test("an option word after the host that runs a command makes the remote opaque", () => {
  assert.equal(sh("ssh prod-1.example.net -o ProxyCommand=x ls")?.remoteOpaque, true);
  assert.equal(sh("ssh prod-1.example.net -oLocalCommand=x ls")?.remoteOpaque, true);
  assert.equal(sh("ssh prod-1.example.net -o RemoteCommand=x ls")?.remoteOpaque, true);
  assert.equal(sh("ssh prod-1.example.net -F cfg ls")?.remoteOpaque, true);
  assert.equal(sh("ssh -oProxyCommand=x prod-1.example.net ls")?.remoteOpaque, true);
});

test("a harmless option after the host still matches with remote classes", () => {
  const m = sh("ssh prod-1.example.net -o StrictHostKeyChecking=no uptime");
  assert.deepEqual(m?.entries.map((e) => e.id), ["P1"]);
  assert.equal(m?.remoteOpaque, false);
  assert.equal(m?.remoteClasses.length, 1);
});

test("combined short flags before the host", () => {
  const m = sh("ssh -vp 22 prod-1.example.net uptime");
  assert.deepEqual(m?.entries.map((e) => e.id), ["P1"]);
  assert.equal(m?.remoteOpaque, false);
  assert.equal(m?.remoteClasses.length, 1);
  assert.deepEqual(sh("ssh -Nv prod-1.example.net uptime")?.entries.map((e) => e.id), ["P1"]);
});

test("-- ends the options: the host follows it", () => {
  const m = sh("ssh -- prod-1.example.net uptime");
  assert.deepEqual(m?.entries.map((e) => e.id), ["P1"]);
  assert.equal(m?.remoteClasses.length, 1);
});

test("-t after the host is an option word; the quoted command is the remote command", () => {
  const m = sh("ssh prod-1.example.net -t 'touch data/x'");
  assert.deepEqual(m?.entries.map((e) => e.id), ["P1"]);
  assert.equal(m?.remoteOpaque, false);
  assert.ok(m?.remoteClasses.includes("write-in"));
});

test("combined flags with a ProxyCommand option make the remote opaque", () => {
  assert.equal(sh("ssh -vo ProxyCommand=x prod-1.example.net uptime")?.remoteOpaque, true);
});

test("host globs fold case and one trailing dot", () => {
  assert.deepEqual(sh("ssh prod-1.example.net. uptime")?.entries.map((e) => e.id), ["P1"]);
  assert.deepEqual(sh("ssh PROD-1.example.net uptime")?.entries.map((e) => e.id), ["P1"]);
});

test("a jump host is matched", () => {
  assert.deepEqual(sh("ssh -J prod-9.example.net dev-1.example.net uptime")?.entries.map((e) => e.id), ["P1"]);
});
