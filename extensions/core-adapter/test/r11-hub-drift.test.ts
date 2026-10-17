// R11 P1b item 2: `paths.hubWorkflow` against the live rendered permission-system config (hubdrift.ts, wired into /foreman doctor and
// /foreman setup). A config rendered while paths.hubWorkflow was unset has no `<hub>/.workflow` read key, so a plain session's ledger read there
// matches only the `external_directory["*"] = "ask"` catch-all. Temp dirs only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { hubWorkflowDriftLines } from "../hubdrift.ts";
import { psGlobalConfigPath } from "../permsys.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const w = fs.realpathSync(mkTestTmp("pf-r11-hubdrift-"));
after(() => rmTestTmp(w));
const slash = (s: string): string => s.split("\\").join("/");
let n = 0;
/** A fresh agent dir whose live permission-system config carries `read` as external_directory_read (null = no file). */
const agent = (read: Record<string, string> | null): string => {
  const ag = path.join(w, `agent${++n}`);
  fs.mkdirSync(ag, { recursive: true });
  if (read) {
    fs.mkdirSync(path.dirname(psGlobalConfigPath(ag)), { recursive: true });
    fs.writeFileSync(psGlobalConfigPath(ag), JSON.stringify({ permission: { "*": "ask", external_directory: { "*": "ask" }, external_directory_read: read } }));
  }
  return ag;
};
const hub = path.join(w, "hub");
const hubFlow = path.join(hub, ".workflow").split("\\").join("/");

test("doctor_warns_hub_workflow_set_config_lacks_patterns", () => {
  const lines = hubWorkflowDriftLines({ agentDir: agent({ "/elsewhere/*": "allow" }), hubWorkflow: [hub], checkouts: [] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^WARN paths\.hubWorkflow is set/);
  assert.ok(lines[0].includes(hubFlow));
  assert.match(lines[0], /re-run foreman setup/);
  // only one of the two keys still warns
  const half = hubWorkflowDriftLines({ agentDir: agent({ [hubFlow]: "allow" }), hubWorkflow: hub, checkouts: [] });
  assert.match(half[0] ?? "", /^WARN /);
});

test("doctor_no_warning_when_config_has_hub_patterns", () => {
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: agent({ [hubFlow]: "allow", [`${hubFlow}/*`]: "allow" }), hubWorkflow: [hub], checkouts: [] }), []);
  // a missing live file is the permission-file check's FAIL, not this line
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: agent(null), hubWorkflow: [hub], checkouts: [] }), []);
});

test("doctor_info_hub_workflow_unset_ledger_dir_above_worktree", () => {
  const git = path.join(w, "git");
  const main = path.join(git, "repo");
  const round = path.join(git, "repo.worktrees", "r1");
  for (const d of [main, round, path.join(git, ".workflow")]) fs.mkdirSync(d, { recursive: true });
  const ag = agent({ "/elsewhere/*": "allow" });
  // a .workflow without a ledger file: no hint
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: [round] }), []);
  fs.writeFileSync(path.join(git, ".workflow", "LEDGER-r1.md"), "- [ ] 1. x\n");
  for (const checkouts of [[round], [main], [main, round]]) {
    const lines = hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts });
    assert.equal(lines.length, 1, String(checkouts));
    assert.match(lines[0], /^INFO /);
    assert.ok(lines[0].includes(`set paths.hubWorkflow to ${git} `));
    assert.match(lines[0], /not set automatically/);
  }
  // set (and rendered): no hint, no warning
  const ok = agent({ [`${slash(git)}/.workflow`]: "allow", [`${slash(git)}/.workflow/*`]: "allow" });
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ok, hubWorkflow: [git], checkouts: [round] }), []);
  // a ledger dir elsewhere (not one level above the main checkout) gives no hint
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: [path.join(w, "other", "repo")] }), []);
});

test("doctor_hub_workflow_dot_segment_no_false_warning", () => {
  const dotted = `${w}/./hub/`;
  // the resolved spelling (what permissions_gen renders through pathlib) and the typed one (trailing `/` stripped) both satisfy the check
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: agent({ [hubFlow]: "allow", [`${hubFlow}/*`]: "allow" }), hubWorkflow: [dotted], checkouts: [] }), []);
  const typed = `${slash(w)}/./hub/.workflow`;
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: agent({ [typed]: "allow", [`${typed}/*`]: "allow" }), hubWorkflow: dotted, checkouts: [] }), []);
  // neither spelling: one WARN naming the resolved dir
  const lines = hubWorkflowDriftLines({ agentDir: agent({ "/elsewhere/*": "allow" }), hubWorkflow: [dotted, hub], checkouts: [] });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`for ${hubFlow}:`), lines[0]);
});

test("doctor_hub_workflow_drift_win32_and_posix_platform_branches", () => {
  // set branch, win32 flavour: `C:\\hub` compares as `C:/hub/.workflow` (pure strings, any host)
  const win = agent({ "C:/hub/.workflow": "allow", "C:/hub/.workflow/*": "allow" });
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: win, hubWorkflow: "C:\\hub", checkouts: [], platform: "win32" }), []);
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: win, hubWorkflow: "C:\\hub\\.\\", checkouts: [], platform: "win32" }), []);
  const warn = hubWorkflowDriftLines({ agentDir: agent({ "/elsewhere/*": "allow" }), hubWorkflow: ["C:\\hub"], checkouts: [], platform: "win32" });
  assert.equal(warn.length, 1);
  assert.ok(warn[0].includes("for C:/hub/.workflow:"), warn[0]);
  // unset branch: a checkout not absolute in the given flavour is skipped (a POSIX path under win32, a drive path under posix)
  const ag = agent({ "/elsewhere/*": "allow" });
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: ["/git/repo.worktrees/r1", "git\\repo"], platform: "win32" }), []);
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: ["C:\\git\\repo.worktrees\\r1", "git/repo"], platform: "linux" }), []);
  // a drive root has nothing above it: no hint
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: ["C:\\"], platform: "win32" }), []);
  // the host flavour finds the ledger dir above a round worktree (win32 branch on a Windows host, posix elsewhere)
  const git = path.join(w, "git2");
  const round = path.join(git, "repo.worktrees", "r1");
  fs.mkdirSync(round, { recursive: true });
  fs.mkdirSync(path.join(git, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(git, ".workflow", "LEDGER-r1.md"), "- [ ] 1. x\n");
  const host = process.platform === "win32" ? "win32" : "linux";
  const lines = hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: [round], platform: host });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(`set paths.hubWorkflow to ${git} `), lines[0]);
});
