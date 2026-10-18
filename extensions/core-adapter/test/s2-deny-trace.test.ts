// R5 P2 S2 (ledger 11, 8f-trace + R3 + R4): a silent deny traces its reason with the matched rule; home paths stay hidden.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { denyFields, sanitizeTrace, scrubReason } from "../trace.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";
import { childHandoffDirs } from "../owned.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-tr-")));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
fs.mkdirSync(path.join(repo, "config"), { recursive: true });
const rules = buildOverlayRules(baseline, {}, {}, path.join(repo, "agent"), repo, undefined, true);

test("a write-protection deny of a shell command traces the rule as <repo>/… and no home path", { skip: !posix }, () => {
  const command = "echo x > config/foreman.defaults.json";
  const d = checkToolCall(rules, "bash", { command }, { cwd: repo, home: os.homedir(), platform: process.platform, role: "child" });
  assert.equal(d?.kind, "deny");
  const row = sanitizeTrace({ event: "overlay", toolFamily: "bash", decision: "deny", ...denyFields(d!.reason, "bash", { command }, "builder", [pkgRoot, repo]) });
  assert.ok(String(row.reason).includes("rule '<repo>/config/foreman.defaults.json'"), String(row.reason));
  assert.ok(!String(row.reason).includes(os.homedir()) && !String(row.reason).includes(repo));
  assert.match(String(row.command), /^echo x > /);
});

test("scrubReason keeps rule ids and hides home paths", () => {
  const home = os.homedir();
  assert.equal(scrubReason("denied (rule '*/.git' matched '--exclude-dir=.git' in a shell command)").startsWith("denied (rule '*/.git' matched "), true);
  assert.ok(scrubReason("denied (path rule '**/.env' matched '.env')").includes("path rule '**/.env'"));
  assert.ok(scrubReason("denied (rule '<repo>/package.json' matched 'package.json')").includes("rule '<repo>/package.json'"));
  const h = scrubReason(`denied (rule '${home}/.pi/agent/foreman.json' matched '${home}/.pi/agent/foreman.json')`);
  assert.ok(!h.includes(home), h);
  assert.ok(h.includes("rule '~/.pi/agent/foreman.json'"), h);
  assert.ok(scrubReason("rule '/opt/other/place/x' matched").includes("rule '[path]'"));
});

test("a self_ruling guard row carries the command and a non-empty reason", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-sr-")));
  try {
    const up = path.join(root, "handoffs", "up");
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, "parent"), "other\n");
    fs.writeFileSync(path.join(up, "child"), "me\n");
    const dirs = childHandoffDirs(path.join(root, "handoffs"), "me");
    const input = { command: `cp x ${path.join(up, "ruling-1.md")}` };
    const why = await selfRulingRefusal("bash", input, root, dirs);
    assert.equal(why, SELF_RULING_REASON);
    const row = sanitizeTrace({ event: "guard", guard: "self_ruling", toolFamily: "bash", decision: "blocked", ...denyFields(`self_ruling: ${why}`, "bash", input, "builder", [pkgRoot, root]) });
    assert.equal(row.reason, `self_ruling: ${SELF_RULING_REASON}`);
    assert.match(String(row.command), /^cp x /);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-ruling guard: read-only pipelines pass, a real write to the parent's ruling is refused", async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-sr2-")));
  try {
    const up = path.join(root, "handoffs", "up");
    fs.mkdirSync(up, { recursive: true });
    fs.writeFileSync(path.join(up, "parent"), "other\n");
    fs.writeFileSync(path.join(up, "child"), "me\n");
    const dirs = childHandoffDirs(path.join(root, "handoffs"), "me");
    const runs = path.join(root, "pi-subagents-uid-501", "async-subagent-runs", "run-1");
    for (const command of [
      `grep -o '"model":"[^"]*"' status.json events.jsonl | sort | uniq -c`,
      `ls ${runs}; grep -ho '"model":"[^"]*"' *.json | sort | uniq -c`,
      `cd ${runs} && grep -ho '"model":"[^"]*"' *.json | sort | uniq -c`,
    ]) assert.equal(await selfRulingRefusal("bash", { command }, runs, dirs), undefined, command);
    for (const command of [`echo APPROVED > ${path.join(up, "ruling-1.md")}`, `sort -o ${path.join(up, "ruling.md")} x`, `cat x | tee ${path.join(up, "ruling-2.md")}`]) assert.equal(await selfRulingRefusal("bash", { command }, runs, dirs), SELF_RULING_REASON, command);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
