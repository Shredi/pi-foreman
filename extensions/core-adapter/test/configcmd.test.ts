import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_APPLIED_LINE, CONFIG_USAGE, configResultText, parseConfigArgs } from "../configcmd.ts";

const dir = "/agent/dir";

test("validate: fixed argv with the agent dir last", () => {
  assert.deepEqual(parseConfigArgs(["validate"], dir), { argv: ["validate", "--agent-dir", dir], applies: false });
});

test("validate takes no arguments", () => {
  for (const extra of [["--json"], ["x"], ["--agent-dir", "/other"]]) assert.deepEqual(parseConfigArgs(["validate", ...extra], dir), { usage: CONFIG_USAGE });
});

test("apply-preset: name only", () => {
  assert.deepEqual(parseConfigArgs(["apply-preset", "openai"], dir), { argv: ["apply-preset", "openai", "--agent-dir", dir], applies: true });
});

test("apply-preset: --foreman and --dry-run in any order, agent dir last", () => {
  const want = { argv: ["apply-preset", "openai", "--foreman", "p/m", "--dry-run", "--agent-dir", dir], applies: false };
  assert.deepEqual(parseConfigArgs(["apply-preset", "openai", "--foreman", "p/m", "--dry-run"], dir), want);
  assert.deepEqual(parseConfigArgs(["apply-preset", "openai", "--dry-run", "--foreman", "p/m"], dir), want);
});

test("a typed --agent-dir, --user-file, --session-json or --trusted-project is refused", () => {
  for (const flag of [["--agent-dir", "/x"], ["--user-file", "/x"], ["--session-json", "/x"], ["--trusted-project"], ["--json"], ["--project-dir", "/x"]]) {
    assert.deepEqual(parseConfigArgs(["apply-preset", "openai", ...flag], dir), { usage: CONFIG_USAGE }, flag.join(" "));
    assert.deepEqual(parseConfigArgs(["validate", ...flag], dir), { usage: CONFIG_USAGE }, flag.join(" "));
  }
});

test("a name or --foreman value starting with - is refused", () => {
  assert.deepEqual(parseConfigArgs(["apply-preset", "-x"], dir), { usage: CONFIG_USAGE });
  assert.deepEqual(parseConfigArgs(["apply-preset", "--dry-run"], dir), { usage: CONFIG_USAGE });
  assert.deepEqual(parseConfigArgs(["apply-preset", "openai", "--foreman", "--agent-dir"], dir), { usage: CONFIG_USAGE });
  assert.deepEqual(parseConfigArgs(["apply-preset", "openai", "--foreman", "-m"], dir), { usage: CONFIG_USAGE });
});

test("missing name, missing --foreman value, repeated flags and extra words are refused", () => {
  for (const words of [["apply-preset"], ["apply-preset", "openai", "--foreman"], ["apply-preset", "openai", "--dry-run", "--dry-run"], ["apply-preset", "openai", "--foreman", "a/b", "--foreman", "c/d"], ["apply-preset", "openai", "extra"]]) {
    assert.deepEqual(parseConfigArgs(words, dir), { usage: CONFIG_USAGE }, words.join(" "));
  }
});

test("unknown or missing verb gives the usage line", () => {
  assert.deepEqual(parseConfigArgs([], dir), { usage: CONFIG_USAGE });
  assert.deepEqual(parseConfigArgs(["merged"], dir), { usage: CONFIG_USAGE });
  assert.deepEqual(parseConfigArgs(["resolve", "--role", "builder"], dir), { usage: CONFIG_USAGE });
});

test("the usage line names both forms", () => {
  assert.match(CONFIG_USAGE, /\/foreman config apply-preset <name> \[--foreman <model id>\] \[--dry-run\]/);
  assert.match(CONFIG_USAGE, /\/foreman config validate/);
});

test("the follow-up line comes only after a successful real apply", () => {
  const real = parseConfigArgs(["apply-preset", "openai"], dir);
  const dry = parseConfigArgs(["apply-preset", "openai", "--dry-run"], dir);
  const val = parseConfigArgs(["validate"], dir);
  assert.ok("applies" in real && "applies" in dry && "applies" in val);
  if (!("applies" in real && "applies" in dry && "applies" in val)) return;
  assert.equal(configResultText("done", real.applies, true), `done\n${CONFIG_APPLIED_LINE}`);
  assert.equal(configResultText("done", real.applies, false), "done");
  assert.equal(configResultText("done", dry.applies, true), "done");
  assert.equal(configResultText("ok", val.applies, true), "ok");
  assert.equal(CONFIG_APPLIED_LINE, "run /foreman setup to apply the models");
});
