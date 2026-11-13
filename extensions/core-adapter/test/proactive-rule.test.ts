// The working-ahead rules: a tagged section at the end of instructions/foreman.md (proactive=on), the session text of a default
// session, and the docs section that owns it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyVariants } from "../ledgercall.ts";
import { r11Rig } from "./_r11rig.ts";

const root = path.join(import.meta.dirname, "..", "..", "..");
const rules = fs.readFileSync(path.join(root, "instructions", "foreman.md"), "utf8");
const TAG = "<!--proactive=on-->";
const defaults = { ladder: "on", ownerScript: "on", ownerReadable: "on", reviewMarks: "on", show: "on", protect: "on" };

/** Every phrase carries one condition of the section. */
const phrases = [
  "### Working ahead",
  "At a natural pause",
  "findings that share a cause",
  "a finding seen a second time",
  "a fault that blocks or slows running work",
  "Take up each ripe group once",
  "name in your reply what you are holding back",
  "restores behaviour",
  "confirm it on disk first",
  "When an item of the running ledger already covers the fix, do it there; otherwise open a separate session",
  "tell the owner in one or two plain sentences what you started and why",
  "a default that changes",
  "a gate, guard or permission that loosens",
  "a new config key or its default",
  "a wire or file format",
  "cost that grows",
  "something outside the repository",
  "an architectural decision",
  "your own doubt whether it is a fix at all",
  "Put several follow-ups into one question to the owner",
  "tier, ledger, review before a PR, the checkpoint at heavy, the confirm for a new session, owner scripts and guard approvals all hold",
  "children never push or merge",
  "Keep to a budget or limit the owner stated",
  "the host's resources are tight",
  "In a session a parent opened",
];

test("proactive=on renders the working-ahead section with every condition", () => {
  const on = applyVariants(rules, { ...defaults, proactive: "on" });
  for (const want of phrases) assert.ok(on.includes(want), want);
  assert.match(on, /^### Working ahead$/m);
  assert.ok(!on.includes("<!--proactive"), "the tag is stripped");
});

test("the key absent renders none of the section and equals the file without the tagged lines", () => {
  const off = applyVariants(rules, defaults);
  for (const want of phrases) assert.ok(!off.includes(want), want);
  const without = rules.split("\n").filter((l) => !l.startsWith(TAG)).join("\n");
  assert.equal(off, applyVariants(without, defaults));
  assert.equal(applyVariants(rules, { ...defaults, proactive: "off" }), off);
});

test("every line from the separator before the heading to the end of the file is tagged", () => {
  const lines = rules.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => l === `${TAG}### Working ahead`);
  assert.ok(at > 0, "the heading is a tagged line");
  assert.equal(lines[at - 1], TAG, "a tagged empty line separates the section");
  for (const l of lines.slice(at - 1)) assert.ok(l.startsWith(TAG), l.slice(0, 60));
  assert.ok(lines.slice(0, at - 1).every((l) => !l.startsWith(TAG)), "no earlier line carries the tag");
});

test("the section holds no digit and no model or vendor name", () => {
  const section = rules.split("\n").filter((l) => l.startsWith(TAG)).join("\n");
  assert.ok(!/\d/.test(section), "no digit");
  assert.ok(!/claude|sonnet|opus|fable|gpt|gemini|copilot|openrouter/i.test(section));
});

test("a default session's system text contains the section", async (t) => {
  const r = await r11Rig(t, {}, {
    ctx: { getSystemPrompt: () => "", sessionManager: { getSessionId: () => "pr-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] }, ui: { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerTool: () => undefined, getActiveTools: () => ["read", "bash"], getAllTools: () => [], setActiveTools: () => undefined, appendEntry: () => undefined },
  });
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string>, skills: [] } };
  await r.fire("before_agent_start", event);
  const text = event.systemPromptOptions.sections["pi-foreman"] ?? "";
  assert.match(text, /Foreman rules/);
  assert.match(text, /^### Working ahead$/m);
});

test("docs/ceremony.md carries the Working ahead section with both ruling additions", () => {
  const doc = fs.readFileSync(path.join(root, "docs", "ceremony.md"), "utf8");
  const at = doc.indexOf("\n## Working ahead\n");
  assert.ok(at > 0, "the section exists");
  const end = doc.indexOf("\n## ", at + 1);
  const body = doc.slice(at, end);
  assert.match(body, /without a way to open further sessions has the foreman propose the fix and wait/, "installation without a way to open sessions");
  assert.match(body, /propose/i);
  assert.match(body, /every foreman request/, "the cost sentence");
  assert.match(body, /plan-first|plan first/i, "a session for a new topic opens plan-first");
  assert.match(body, /never push or merge/);
  assert.ok(doc.indexOf("\n## Round flow") < at && at < doc.indexOf("\n## Further ceremony keys"), "between Round flow and Further ceremony keys");
});
