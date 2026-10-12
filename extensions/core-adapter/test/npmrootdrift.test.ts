// R3b point 8c: the resolved `npm root -g` against the root the rendered policy grants. The fixture is the
// R3 ask line (`command -v tsc …; ls /opt/homebrew/lib/node_modules | grep -i typescript`, a read of the global
// npm root from a child's bash): the root there is /opt/homebrew/lib/node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grantedNpmRoot, npmRootDrift, npmRootDriftNotice, readPolicy } from "../npmrootdrift.ts";

const R3_ROOT = "/opt/homebrew/lib/node_modules";
const agentDir = path.resolve("/t/agent");
/** A rendered policy with the two `{npmRoot}` read keys, as permissions_gen.py writes them. */
const policyFor = (root: string | null) => ({
  permission: {
    external_directory_read: {
      [`${agentDir}/pi-foreman`]: "allow",
      [`${agentDir}/pi-foreman/*`]: "allow",
      ...(root ? { [root]: "allow", [`${root}/*`]: "allow" } : {}),
    },
  },
});

test("R3 line: policy grants the resolved root -> silent, nothing to warn", () => {
  const seen = new Set<string>();
  const drift = npmRootDrift(R3_ROOT, policyFor(R3_ROOT));
  assert.equal(drift, null);
  assert.equal(npmRootDriftNotice(drift, seen), null);
  assert.equal(seen.size, 0);
});

test("R3 line: policy renders another root -> drift names both roots and warns", () => {
  const drift = npmRootDrift(R3_ROOT, policyFor("/opt/npm-old/lib/node_modules"));
  assert.deepEqual(drift, { resolved: R3_ROOT, rendered: "/opt/npm-old/lib/node_modules" });
  const note = npmRootDriftNotice(drift, new Set());
  assert.ok(note?.includes("npm root drifted: run `foreman setup`"));
  assert.ok(note?.includes(R3_ROOT) && note?.includes("/opt/npm-old/lib/node_modules"));
});

test("R3 line: warns once per session", () => {
  const seen = new Set<string>();
  const drift = npmRootDrift(R3_ROOT, policyFor("/opt/npm-old/lib/node_modules"));
  assert.ok(npmRootDriftNotice(drift, seen));
  assert.equal(npmRootDriftNotice(drift, seen), null);
  assert.ok(npmRootDriftNotice(drift, new Set()), "a new session warns again");
});

test("R3 line: policy without an npm root grant (open rig) stays silent", () => {
  const seen = new Set<string>();
  const drift = npmRootDrift(R3_ROOT, policyFor(null));
  assert.equal(drift, null);
  assert.equal(npmRootDriftNotice(drift, seen), null);
  assert.equal(seen.size, 0);
});

test("R3 line: an unresolved root, or a missing policy file, compares nothing", () => {
  assert.equal(npmRootDrift(null, policyFor("/opt/npm-old/lib/node_modules")), null);
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npmroot-")), "config.json");
  assert.equal(readPolicy(missing), null);
  assert.equal(npmRootDrift(R3_ROOT, readPolicy(missing)), null);
});

test("grantedNpmRoot: the key with its /* twin ending in node_modules; trailing slashes and backslashes normalised", () => {
  assert.equal(grantedNpmRoot(policyFor(R3_ROOT)), R3_ROOT);
  assert.equal(grantedNpmRoot({ permission: { external_directory_read: { "C:\\np\\node_modules": "allow", "C:\\np\\node_modules/*": "allow" } } }), "C:/np/node_modules");
  assert.equal(grantedNpmRoot({ permission: { external_directory_read: { [R3_ROOT]: "allow" } } }), null);
  assert.equal(npmRootDrift("C:\\np\\node_modules\\", { permission: { external_directory_read: { "C:/np/node_modules": "allow", "C:/np/node_modules/*": "allow" } } }), null);
});

test("readPolicy: reads the rendered JSON back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-npmroot-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(policyFor(R3_ROOT)));
  assert.equal(grantedNpmRoot(readPolicy(file)), R3_ROOT);
  fs.rmSync(dir, { recursive: true, force: true });
});
