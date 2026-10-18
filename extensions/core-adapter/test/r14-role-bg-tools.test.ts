// R14 item 5: the finalizer and reviewer roles list bg_run, bg_status and bg_logs. A tool name loads no extension (pi-subagents docs/agents.md), so the
// test also pins what makes the add-on's extension load in the child: the agent is a background (`async: true`) child with no `extensions:` field,
// which loads the parent's ambient extensions; and the guard map covers bg_run.
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
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m, `${role}.md has frontmatter`);
  return Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
};
const defaults = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "foreman.defaults.json"), "utf8")) as { roles: Record<string, { tools: string[] }> };

for (const role of ["finalizer", "reviewer"]) {
  test(`${role}: bg_run, bg_status, bg_logs are in the agent tools and the default role tools`, () => {
    const fm = frontmatter(role);
    const tools = fm.tools.split(",").map((x) => x.trim());
    for (const b of BG) assert.ok(tools.includes(b), `${role}.md tools has ${b}`);
    for (const b of BG) assert.ok(defaults.roles[role].tools.includes(b), `defaults roles.${role}.tools has ${b}`);
  });
  test(`${role}: a background child without an extensions field, so the ambient add-on extension loads`, () => {
    const fm = frontmatter(role);
    assert.equal(fm.async, "true");
    assert.equal("extensions" in fm, false);
  });
}

test("bg_run is a guarded shell tool like bash", () => {
  assert.equal(ADDON_BG_TOOL, "bg_run");
  assert.equal(isShellTool("bg_run"), true);
});
