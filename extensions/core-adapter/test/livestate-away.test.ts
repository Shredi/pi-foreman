// Presence file: `away: true` while a warm window is open and the owner is away (D12), read from a getter at write time.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";

const read = (d: string, id: string) => JSON.parse(fs.readFileSync(path.join(liveDir(d), `${id}.json`), "utf8"));

test("the snapshot carries away only while the getter says so; a throwing getter leaves it out", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ls-away-"));
  const l = LiveState.start({ agentDir: d, sessionId: "a", cwd: "/w", mode: "rpc", env: {} }, () => [])!;
  assert.equal("away" in read(d, "a"), false, "no getter, no field");
  let cur = true;
  l.setAwayGetter(() => cur);
  assert.equal(l.snapshot().away, true);
  l.write();
  assert.equal(read(d, "a").away, true);
  cur = false;
  assert.equal("away" in l.snapshot(), false, "read at write time: it cannot go stale");
  l.setAwayGetter(() => {
    throw new Error("boom");
  });
  assert.equal("away" in l.snapshot(), false);
  l.stop();
  fs.rmSync(d, { recursive: true, force: true });
});
