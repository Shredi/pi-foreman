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
const posix = process.platform !== "win32";
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

test("doctor_info_hub_workflow_unset_ledger_dir_above_worktree", { skip: !posix }, () => {
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
  const ok = agent({ [`${git}/.workflow`]: "allow", [`${git}/.workflow/*`]: "allow" });
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ok, hubWorkflow: [git], checkouts: [round] }), []);
  // a ledger dir elsewhere (not one level above the main checkout) gives no hint
  assert.deepEqual(hubWorkflowDriftLines({ agentDir: ag, hubWorkflow: [], checkouts: [path.join(w, "other", "repo")] }), []);
});
