// R19 item 1 follow-up: own-CLI allow needs an explicit path head and has no `session status` verb.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { readBaseline } from "../permoverlay.ts";
import { bashRules } from "../timeoutallow.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const posix = process.platform !== "win32";
const w = fs.realpathSync(mkTestTmp("pf-owncli-b-"));
after(() => rmTestTmp(w));

const root = path.join(w, "root");
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
fs.writeFileSync(path.join(root, "bin", "foreman"), "#!/bin/sh\n", { mode: 0o755 });
const ownBin = path.join(root, "bin", "foreman");
const baseline = readBaseline(PKG)!;
const noModel: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };

async function run(value: string): Promise<string> {
  const r = new ForemanReview();
  r.upsert("s", {
    isChild: false, cwd: root, provider: "a", config: () => ({}), registry: noModel, intent: "",
    trace: () => {}, bashRules: () => bashRules(baseline, {}), foremanRoot: () => root,
  });
  try {
    return (await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash" })).kind;
  } catch (e) {
    return `threw ${(e as Error).message}`;
  }
}

test("own_cli_session_status_not_allowed", { skip: !posix }, async () => {
  assert.notEqual(await run(`${ownBin} session status`), "allow");
});

test("own_cli_bare_head_not_allowed", { skip: !posix }, async () => {
  assert.notEqual(await run(`foreman session open a b`), "allow");
});

test("own_cli_dot_slash_relative_head_allowed", { skip: !posix }, async () => {
  assert.equal(await run(`./bin/foreman session list`), "allow");
});
