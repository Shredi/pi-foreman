import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import type { LiveDot } from "../livestate.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

function written(dots: LiveDot[]): LiveDot[] {
  const agent = mkTestTmp("r78u-");
  const l = LiveState.start({ agentDir: agent, sessionId: "s1", cwd: agent, mode: "rpc", env: {} }, () => [], undefined, undefined, undefined, () => dots);
  assert.ok(l);
  l.flush();
  const f = JSON.parse(fs.readFileSync(path.join(liveDir(agent), "s1.json"), "utf8")) as { dots: LiveDot[] };
  l.stop();
  rmTestTmp(agent);
  return f.dots;
}

test("the presence dot keeps an https url and omits others", () => {
  const good = "https://example.test/acme/app/pull/7";
  const got = written([
    { n: 7, state: "ok", label: "#7", src: "pr", url: good },
    { n: 8, state: "ok", label: "#8", src: "pr", url: "http://example.test/acme/app/pull/8" },
    { n: 9, state: "ok", label: "#9", src: "pr", url: "https://example.test/a b" },
    { n: 10, state: "ok", label: "#10", src: "pr", url: "javascript:1" },
    { n: 11, state: "ok", label: "#11", src: "pr" },
    { n: null, state: "ok", label: "ext", src: "ext", url: good },
  ]);
  assert.equal(got[0].url, good);
  for (const d of got.slice(1)) assert.equal("url" in d, false);
  assert.equal(got.length, 6);
});
