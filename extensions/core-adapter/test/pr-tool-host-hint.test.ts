// D215: the host parameter of the pr tools tells a caller outside a checkout to name only `repo`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PR_TOOLS } from "../gitpack.ts";

test("the shared host parameter says: outside a checkout name only repo; host only from tools.prGithubHosts", () => {
  for (const name of ["pr_status", "pr_checks", "pr_comments"]) {
    const tool = PR_TOOLS.find((t) => t.name === name);
    assert.ok(tool, name);
    const host = (tool.parameters.properties as Record<string, { description: string }>).host.description;
    assert.match(host, /Outside a checkout name only `repo`/);
    assert.match(host, /tools\.prGithubHosts/);
  }
});

test("docs/tools.md carries the same hint", () => {
  const doc = readFileSync(fileURLToPath(new URL("../../../docs/tools.md", import.meta.url)), "utf8");
  assert.match(doc, /outside a checkout name only `repo`; add `host` only when it is in `tools\.prGithubHosts`/);
});
