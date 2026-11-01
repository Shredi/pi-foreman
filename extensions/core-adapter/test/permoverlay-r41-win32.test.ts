// R41: the floor set holds drive-less configured paths; on win32 a drive-resolved candidate (`D:\pf41\agent\...`) must hit it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, ownStateRead, readBaseline, type MatchCtx } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/pf41/agent", "/pf41/pkg", undefined, false, undefined);
const ctx: MatchCtx = { cwd: "D:\\work\\proj", home: "D:\\Users\\pf41", platform: "win32", role: "main" };
const bash = (command: string) => checkToolCall(rules, "bash", { command }, ctx);

test("r41 win32: a drive-resolved candidate hits a drive-less floored folder and a drive-less ancestor", () => {
  assert.equal(bash("rclone copy r:d D:/pf41/agent/pi-foreman/state/../")?.rule, "floor");
  assert.equal(bash("rm -rf /pf41/agent/pi-foreman//state/../")?.rule, "floor");
  assert.equal(bash("rm -rf D:/pf41/agent/..")?.rule, "floor");
  assert.notEqual(bash("rm -rf D:/work/proj/x")?.rule, "floor");
});

test("r41 win32: a forward-slash spelling of the native own-read entry joins the chain, a recursive grep does not", () => {
  const c: MatchCtx = { ...ctx, ownReads: ["D:\\pf41\\agent\\pi-foreman\\state\\usage\\s1.jsonl"] };
  const f = "D:/pf41/agent/pi-foreman/state/usage/s1.jsonl";
  assert.equal(ownStateRead(`cat ${f}; grep x ${f}`, c), true);
  assert.equal(ownStateRead(`cat ${f}; grep -r x D:/pf41`, c), false);
});
