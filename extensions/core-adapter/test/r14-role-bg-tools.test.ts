// R14 ruling 10: the finalizer and reviewer roles list NO bg_run, bg_status or bg_logs while the pi-background-tasks add-on is not wired
// conditionally. pi-subagents treats `tools` as a strict allowlist and refuses to start a child that names an unavailable tool ("Agent
// 'reviewer' requested unavailable child tools: bg_run, bg_status, bg_logs"), so without the add-on every reviewer launch ended exit 1
// with no verdict. The guard map still covers bg_run for sessions that have the add-on.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ADDON_BG_TOOL, isShellTool } from "../toolmap.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BG = ["bg_run", "bg_status", "bg_logs"];
const frontmatter = (role: string): Record<string, string> => {
  const text = fs.readFileSync(path.join(pkgRoot, "agents", `${role}.md`), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(m, `${role}.md has frontmatter`);
  return Object.fromEntries(m[1].split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
};
const defaults = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "foreman.defaults.json"), "utf8")) as { roles: Record<string, { tools: string[] }> };

for (const role of ["finalizer", "reviewer"]) {
  test(`${role}: no bg_run, bg_status, bg_logs in the agent tools or the default role tools`, () => {
    const tools = frontmatter(role).tools.split(",").map((x) => x.trim());
    for (const b of BG) assert.equal(tools.includes(b), false, `${role}.md tools has no ${b}`);
    for (const b of BG) assert.equal(defaults.roles[role].tools.includes(b), false, `defaults roles.${role}.tools has no ${b}`);
  });
}

test("bg_run is a guarded shell tool like bash", () => {
  assert.equal(ADDON_BG_TOOL, "bg_run");
  assert.equal(isShellTool("bg_run"), true);
});
