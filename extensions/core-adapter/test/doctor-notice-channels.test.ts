// /foreman doctor: pi-subagents control.notifyChannels must be ["event"] (registry.ts noticeChannelsDoctor).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { noticeChannelsDoctor } from "../registry.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-doctor-nc-")));
process.on("exit", () => rmTestTmp(tmp));

const agentWith = (name: string, cfg: unknown): string => {
  const agent = path.join(tmp, name);
  if (cfg === undefined) return agent;
  fs.mkdirSync(path.join(agent, "extensions", "subagent"), { recursive: true });
  fs.writeFileSync(path.join(agent, "extensions", "subagent", "config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return agent;
};

test("doctor: no WARN when control.notifyChannels is [event], other keys do not matter", () => {
  assert.deepEqual(noticeChannelsDoctor(agentWith("ok", { control: { notifyChannels: ["event"], needsAttentionAfterMs: 5 }, worktreeSetupHook: "/x" })), []);
});

test("doctor: WARN for a missing file, a missing key, the default channels and a different value", () => {
  for (const [name, cfg] of [["nofile", undefined], ["empty", {}], ["nokey", { control: {} }], ["three", { control: { notifyChannels: ["event", "async", "intercom"] } }], ["intercom", { control: { notifyChannels: ["event", "intercom"] } }], ["bad", "{not json"]] as const) {
    const lines = noticeChannelsDoctor(agentWith(name, cfg));
    assert.equal(lines.length, 1, name);
    assert.match(lines[0], /^WARN control\.notifyChannels is not \["event"\] in .*config\.json.*run \/foreman setup/, name);
  }
});
