// R10 P1 item 5 (e): a plain Pi main session (no round, its main checkout as cwd) reads the parent's workflow ledger / `.workflow/*.md` in the
// configured hub (`paths.hubWorkflow`) through the overlay (checkToolCall, `readable` = hubWorkflowReadable).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { OverlayRules } from "../permoverlay.ts";
import { hubWorkflowReadable } from "../roundsurface.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";
const w = fs.realpathSync(mkTestTmp("pf-r10-plainwf-"));
after(() => rmTestTmp(w));
const main = path.join(w, "repo");
const hub = path.join(w, "hub");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [main, path.join(hub, ".workflow"), ag]) fs.mkdirSync(d, { recursive: true });
const ledger = path.join(hub, ".workflow", "LEDGER-r9.md");
fs.writeFileSync(ledger, "- [ ] 1. x\n");
if (posix) execFileSync("git", ["init", "-q", main], { stdio: "ignore" });

test("expected-open (R10e): plain session overlay passes a read of the hub ledger (readable = hubWorkflowReadable)", { skip: !posix }, () => {
  const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, main, undefined, false);
  const ctx = { cwd: main, home, platform: process.platform, role: "main" as const, readable: hubWorkflowReadable([hub]) };
  assert.equal(checkToolCall(rules, "bash", { command: `cat ${ledger}` }, ctx)?.kind ?? "pass", "pass");
  assert.equal(checkToolCall(rules, "read", { path: ledger }, ctx)?.kind ?? "pass", "pass");
});
