// matchProtected: which protected entries a call touches and the effect classes of what it does (neutral fixtures).
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
const home = path.join(cwd, "pf-prot-match", "home");
const env = { home, platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const E = (kind: ProtectedEntry["kind"], glob: string, i: number): ProtectedEntry => ({ id: `P${i}`, kind, glob, source: "user" });
const entries = [E("host", "prod-*.example.net", 1), E("path", "ops/playbooks/**", 2), E("command", "deploy-*", 3)];

const sh = (line: string): ProtectedMatch | null => {
  const segments = parseShell(line, { cwd });
  return matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
};
const ids = (m: ProtectedMatch | null): string[] => (m ? m.entries.map((e) => e.id) : []);

test("read commands naming a protected path or command word do not match", () => {
  assert.equal(sh("git log -- ops/playbooks/deploy-x.yml"), null);
  assert.equal(sh("grep deploy-x ."), null);
  assert.equal(sh("cat ops/playbooks/deploy-x.yml"), null);
});

test("ssh host with a remote command: host matches, remote classes computed", () => {
  const m = sh("ssh prod-1.example.net 'docker ps; ip route get 1.1.1.1'");
  assert.deepEqual(ids(m), ["P1"]);
  assert.equal(m?.remoteClasses.length, 2);
  assert.equal(m?.remoteOpaque, false);
  assert.deepEqual(m?.kinds, ["host"]);
});

test("ssh user@host and a non-matching host", () => {
  assert.deepEqual(ids(sh("ssh -p 22 root@prod-2.example.net uptime")), ["P1"]);
  assert.equal(sh("ssh dev-1.example.net uptime"), null);
});

test("a remote command that cannot be stated is remoteOpaque", () => {
  assert.equal(sh("ssh prod-1.example.net 'for i in $(x); do rm $i; done'")?.remoteOpaque, true);
  assert.equal(sh("ssh prod-1.example.net")?.remoteOpaque, true);
});

test("command-running ssh options are opaque", () => {
  assert.equal(sh("ssh -o ProxyCommand='nc %h 22' prod-1.example.net true")?.remoteOpaque, true);
  assert.equal(sh("ssh -F cfg prod-1.example.net true")?.remoteOpaque, true);
});

test("scp to a protected host is a write-out match", () => {
  const m = sh("scp a prod-1.example.net:/srv/");
  assert.deepEqual(ids(m), ["P1"]);
  assert.ok(m?.classes.includes("write-out"));
});

test("curl: a plain GET does not match; a POST does, with write-out", () => {
  assert.equal(sh("curl https://prod-1.example.net/x"), null);
  const m = sh("curl -X POST -d @x https://prod-1.example.net/");
  assert.deepEqual(ids(m), ["P1"]);
  assert.ok(m?.classes.includes("write-out"));
});

test("a deploy program's path argument matches the path entry", () => {
  const m = sh("ansible-playbook ops/playbooks/deploy-x.yml");
  assert.deepEqual(ids(m), ["P2"]);
  assert.deepEqual(m?.kinds, ["path"]);
});

test("a redirect into a protected path matches", () => {
  assert.deepEqual(ids(sh("echo x > ops/playbooks/new.yml")), ["P2"]);
});

test("command entries match the program basename of any segment", () => {
  assert.deepEqual(ids(sh("./bin/deploy-site --dry-run")), ["P3"]);
});

test("classes lists every local segment, not only the worst", () => {
  const m = sh("ls && ssh prod-1.example.net true");
  assert.deepEqual(m?.classes, ["read", "unknown"]);
});

test("an opaque local segment is matched on its raw words and flagged opaque", () => {
  const m = sh("ssh prod-1.example.net $(cat hosts)");
  assert.ok(m);
  assert.equal(m?.opaque, true);
});

test("path tools: write to a protected path matches with write-out; elsewhere nothing", () => {
  const call = (p: string): RuleCall => ({ tool: "write", paths: [path.join(cwd, p)] });
  const m = matchProtected(call("ops/playbooks/a.yml"), undefined, entries, env);
  assert.deepEqual(ids(m), ["P2"]);
  assert.deepEqual(m?.classes, ["write-out"]);
  assert.equal(matchProtected(call("src/a.ts"), undefined, entries, env), null);
  assert.equal(matchProtected({ tool: "read", paths: [path.join(cwd, "ops/playbooks/a.yml")] }, undefined, entries, env), null);
});

test("no entries: null", () => {
  assert.equal(matchProtected({ tool: "bash" }, [], [], env), null);
});
