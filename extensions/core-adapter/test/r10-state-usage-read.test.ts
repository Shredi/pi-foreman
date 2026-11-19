// R10 P1 item 1 (a): the foreman's own `{agentDir}/pi-foreman/state/usage` is readable with read-only shell verbs (ls/cat/head/tail/wc/stat) and
// ONLY the narrow python form of ruling D1 (`python3 -c` with a single print(open('<literal>').read()) or json.load(open('<literal>'))); every other
// python form asks, writes into state/ stay protected, a child stays denied. The rendered external_directory rules (scripts/permissions_gen.py
// external_rules over the baseline) are checked here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r10-usage-")));
after(async () => {
  await waitQuiet(path.join(w, "home", ".pi", "agent", "pi-foreman", "state"));
  rmTestTmp(w);
});
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const usage = path.join(state, "usage");
for (const d of [ws, usage]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(usage, "u.jsonl"), "{}\n");

const U = usage;
const F = path.join(usage, "u.jsonl");

// the rendered external_directory_read rules (permissions_gen.py external_rules): last match wins, `*` matches any characters including `/`
test("rendered external_directory_read: the usage dir and its files are read-allowed, not write-allowed (permissions_gen external_rules)", { skip: posixOnly }, () => {
  const ext = (JSON.parse(fs.readFileSync(path.join(PKG, "config", "permissions.baseline.json"), "utf8")) as { externalDirectory: { allow: string[]; read: string[]; ask: string[] } }).externalDirectory;
  const fill = (ps: string[]): string[] => ps.map((p) => p.replaceAll("{agentDir}", ag)).filter((p) => !p.includes("{"));
  const re = (p: string): RegExp => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  const hit = (ps: string[], v: string): boolean => fill(ps).some((p) => re(p).test(v));
  for (const v of [U, F]) {
    assert.ok(hit(ext.read, v), v);
    assert.ok(!hit(ext.allow, v), `write-capable ${v}`);
  }
});
