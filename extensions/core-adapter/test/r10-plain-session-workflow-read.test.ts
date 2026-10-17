// R10 P1 item 5 (e): a plain Pi main session (no round, its main checkout as cwd) reads the parent's workflow ledger / `.workflow/*.md` in the
// configured hub (`paths.hubWorkflow`). Reproduced first through the layers, with the session wired as index.ts wires it (readOnlyRoots =
// sessionOwnedSplit with hubFlow, no round dirs, nothing forwarded):
// - overlay (checkToolCall, `readable` = hubWorkflowReadable): passes (unchanged).
// - review link, surface `bash` (the PS bash rules asked): readRootsBashAllow already allows it (hubFlow is a read-only owned root).
// - review link, surface external_directory_read with a bash payload (the permission system's bash external-directory gate raised it when its
//   rendered hub keys did not cover the path, e.g. a config rendered before paths.hubWorkflow was set): ASKED. readRootPathAllow returned null
//   for every bash payload and the hub read root was added (mainFlowOf) only to forwarded child asks. Fixed there: a non-forwarded bash
//   external-directory READ ask is allowed ("hub-workflow") when the whole command classifies as a read inside the cwd and the configured
//   hub `.workflow` dirs (read only); a write, a write-capable surface and an unconfigured foreign `.workflow` still ask.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { OverlayRules } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { bashRules } from "../timeoutallow.ts";
import { hubWorkflowReadable, sessionOwnedSplit, hubWorkflowDirs } from "../roundsurface.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";
const w = fs.realpathSync(mkTestTmp("pf-r10-plainwf-"));
after(() => rmTestTmp(w));
// the plain session's main checkout, the configured hub (the parent's workflow), and a foreign repo nobody configured
const main = path.join(w, "repo");
const hub = path.join(w, "hub");
const foreign = path.join(w, "foreign");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
for (const d of [main, path.join(hub, ".workflow"), path.join(foreign, ".workflow"), ag]) fs.mkdirSync(d, { recursive: true });
for (const f of [path.join(hub, ".workflow", "LEDGER-r9.md"), path.join(hub, ".workflow", "plan.md"), path.join(foreign, ".workflow", "LEDGER.md")]) fs.writeFileSync(f, "- [ ] 1. x\n");
if (posix) execFileSync("git", ["init", "-q", main], { stdio: "ignore" });
const ledger = path.join(hub, ".workflow", "LEDGER-r9.md");

const registry: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
/** A plain main session as index.ts builds it: no round dirs, no ledger, readOnlyRoots from sessionOwnedSplit (hubFlow = configured hubWorkflow). */
const plain = (hubCfg: unknown): ReviewSession => {
  const split = sessionOwnedSplit({ scratch: [], rounds: [], handoffs: [], hubFlow: hubWorkflowDirs(hubCfg) });
  return { isChild: false, cwd: main, provider: "a", config: () => ({ paths: { hubWorkflow: hubCfg } }), registry, intent: "", bashRules: () => bashRules(baseline, {}), ownedRoots: () => split.write, readOnlyRoots: () => split.read, roundDirs: () => [] };
};
let n = 0;
/** The permission system's bash external-directory ask: the command and the uncovered external paths. */
const gateAsk = (command: string, paths: string[], surface: string) => ({
  requestId: `e${++n}`,
  source: "tool_call",
  agentName: null,
  toolName: "bash",
  command,
  payload: { kind: "bash_external_directory", request: { surface, toolName: "bash", value: command }, evidence: [{ label: "working directory", text: main }, ...paths.map((p) => ({ label: "external path", text: p }))] },
});
const link = async (hubCfg: unknown, d: object): Promise<string> => {
  const r = new ForemanReview();
  r.upsert("s", plain(hubCfg));
  return (await r.authorize("s", d as never)).kind;
};
const gate = (hubCfg: unknown, command: string, paths: string[], surface = "external_directory_read") => link(hubCfg, gateAsk(command, paths, surface));

const READS: [string, string[]][] = [
  [`cat ${ledger}`, [ledger]],
  [`head -50 ${ledger}`, [ledger]],
  [`grep -nF '- [ ]' ${ledger}`, [ledger]],
  [`ls ${hub}/.workflow`, [path.join(hub, ".workflow")]],
  [`wc -l ${hub}/.workflow/plan.md ${ledger}`, [path.join(hub, ".workflow", "plan.md"), ledger]],
  [`sed -n '1,40p' ${hub}/.workflow/plan.md`, [path.join(hub, ".workflow", "plan.md")]],
  [`cat ${ledger} | head -20`, [ledger]],
];
for (const [cmd, paths] of READS) {
  test(`expected-open (R10e): plain session ${cmd.split(w).join("<tmp>")} (review link external_directory_read: hub-workflow)`, { skip: !posix }, async () => {
    assert.equal(await gate([hub], cmd, paths), "allow");
    assert.equal(await gate(hub, cmd, paths), "allow", "hubWorkflow as a string");
  });
}

test("expected-open (R10e): plain session bash-surface ask and read-tool ask of the hub ledger (review link)", { skip: !posix }, async () => {
  assert.equal(await link([hub], { requestId: "b1", surface: "bash", agentName: "foreman", command: `cat ${ledger}`, toolName: "bash" }), "allow");
  assert.equal(await link([hub], { requestId: "r1", source: "tool_call", agentName: null, toolName: "read", path: ledger, payload: { kind: "external_directory", request: { surface: "external_directory_read", toolName: "read", value: ledger }, evidence: [] } }), "allow");
});

test("expected-open (R10e): plain session overlay passes a read of the hub ledger (readable = hubWorkflowReadable)", { skip: !posix }, () => {
  const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, main, undefined, false);
  const ctx = { cwd: main, home, platform: process.platform, role: "main" as const, readable: hubWorkflowReadable([hub]) };
  assert.equal(checkToolCall(rules, "bash", { command: `cat ${ledger}` }, ctx)?.kind ?? "pass", "pass");
  assert.equal(checkToolCall(rules, "read", { path: ledger }, ctx)?.kind ?? "pass", "pass");
});

const WRITES: [string, string[], string][] = [
  [`cp x ${ledger}`, [ledger], "external_directory_read"],
  [`echo x > ${ledger}`, [ledger], "external_directory_read"],
  [`echo x >> ${ledger}`, [ledger], "external_directory"],
  [`tee ${ledger}`, [ledger], "external_directory"],
  [`sed -i '' 's/x/y/' ${ledger}`, [ledger], "external_directory_read"],
  [`rm ${ledger}`, [ledger], "external_directory"],
  [`cat ${ledger}`, [ledger], "external_directory"],
  [`cat ${ledger} > ${hub}/.workflow/copy.md`, [ledger, path.join(hub, ".workflow", "copy.md")], "external_directory_read"],
  [`cat ${ledger} | sh`, [ledger], "external_directory_read"],
];
for (const [cmd, paths, surface] of WRITES) {
  test(`(decision: ask) plain session ${cmd.split(w).join("<tmp>")} [${surface}] (review link defers)`, { skip: !posix }, async () => {
    assert.notEqual(await gate([hub], cmd, paths, surface), "allow");
  });
}

test("(decision: ask) plain session: an unconfigured foreign .workflow, an empty config and a forwarded child ask are not hub-workflow (review link)", { skip: !posix }, async () => {
  const fl = path.join(foreign, ".workflow", "LEDGER.md");
  assert.notEqual(await gate([hub], `cat ${fl}`, [fl]), "allow", "foreign");
  assert.notEqual(await gate([hub], `cat ${ledger} ${fl}`, [ledger, fl]), "allow", "hub and foreign");
  assert.notEqual(await gate([], `cat ${ledger}`, [ledger]), "allow", "no hubWorkflow");
  assert.notEqual(await gate(undefined, `cat ${ledger}`, [ledger]), "allow", "unset hubWorkflow");
  assert.notEqual(await gate([hub], `cat ${hub}/other.md`, [path.join(hub, "other.md")]), "allow", "hub outside .workflow");
  assert.notEqual(await link([hub], { ...gateAsk(`cat ${ledger}`, [ledger], "external_directory_read"), forwarding: true, agentName: "builder" }), "allow", "forwarded");
});
