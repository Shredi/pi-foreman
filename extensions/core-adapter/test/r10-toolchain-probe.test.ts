// R10 P1 item 3 (c): read-only toolchain probes. The permission system read-allows the baseline `externalDirectory.probe` dirs (toolchain bin dirs,
// the npx cache; scripts/permissions_gen.py probe_read_patterns, read keys only). Exec of a found binary as the command word stays with the
// permission system's bash rules (no allow row matches it, so it asks).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline } from "../baseline.ts";
import { bashRules, hits } from "../timeoutallow.ts";
import { posixOnly } from "./_platform.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-probe-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [ws, ag, path.join(home, ".npm", "_npx", "abc"), path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, ".npm", "_npx", "abc", "package.json"), "{}\n");

const prules = bashRules(baseline, {});

test("expected-open (R10c): the permission system's bash rules allow which/ls/stat (no PS bash ask)", () => {
  for (const cmd of ["which node", "ls /usr/local/bin", "stat ~/.npm/_npx"]) assert.ok(hits(prules.allow, cmd, home), cmd);
});

test("(decision: ask) exec of a found binary: the overlay leaves the command word to the permission system, whose bash rules have no allow row for it", { skip: posixOnly }, () => {
  for (const cmd of ["/usr/local/bin/foo --version", `${path.join(home, ".npm", "_npx", "abc", "bin")} x`]) {
    assert.ok(!hits(prules.allow, cmd, home), `PS allow ${cmd}`);
  }
});

test("the probe list in the baseline is the fixed generic list (no owner path)", () => {
  assert.deepEqual(baseline.externalDirectory?.probe, ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "~/.local/bin", "~/.npm/_npx", "~/.npm-global/bin", "%APPDATA%/npm"]);
});
