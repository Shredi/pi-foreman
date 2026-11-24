// The plain-opening rules: PR body Summary, reviewer report opening, result opening.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { OWNER_TEXT_POINTS } from "../ownertext.ts";
import { closePrompt } from "../close.ts";
import { PR_TOOLS } from "../gitpack.ts";

const root = path.join(import.meta.dirname, "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");

test("foreman instructions put a plain Summary with a mermaid diagram above the Changelog", () => {
  const t = read("instructions", "foreman.md");
  assert.match(t, /PR body opens with a plain `## Summary` for the owner/);
  assert.match(t, /one small `mermaid` diagram/);
  assert.ok(t.indexOf("`## Summary` for the owner") < t.indexOf("then comes the `## Changelog`"));
});

test("reviewer instructions use the placeholder; the points are inserted at render", () => {
  const raw = read("instructions", "reviewer.md");
  assert.ok(raw.includes("{{ownerTextPoints}}"));
  assert.ok(raw.includes("RUNG_UP:"));
  const idx = read("extensions", "core-adapter", "index.ts");
  assert.ok(idx.includes('replaceAll("{{ownerTextPoints}}", () => OWNER_TEXT_POINTS)'));
  assert.ok(raw.replaceAll("{{ownerTextPoints}}", OWNER_TEXT_POINTS).includes(`points: ${OWNER_TEXT_POINTS}.`));
  assert.ok(!raw.replaceAll("{{ownerTextPoints}}", OWNER_TEXT_POINTS).includes("{{"));
});

test("handoff skill, close prompt and both session footers carry the plain-opening rule", () => {
  assert.match(read("skills", "handoff", "SKILL.md"), /opens with 2-4 plain sentences/);
  assert.match(closePrompt("r.md"), /2-4 plain sentences/);
  const py = read("scripts", "foreman_session.py");
  assert.equal(py.split("opening with 2-4 plain sentences for the owner").length - 1, 2);
});

test("pr_create names the body order", () => {
  const t = PR_TOOLS.find((x) => x.name === "pr_create")!;
  assert.match(t.description, /Body order: a plain `## Summary`.*then `## Changelog`/);
});
