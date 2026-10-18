// R12 item 5: a newer ruling-*.md is read before any child launch and checkpoint press; ruling-<name>.ack records it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { SteerWatch, pickupRuling } from "../steerwatch.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r12-")));
  t.after(() => rmTestTmp(d));
  return d;
}
const put = (dir: string, name: string, text: string, sec: number): void => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, "utf8");
  fs.utimesSync(f, sec, sec);
};
const nowSec = (): number => Math.floor(Date.now() / 1000);

test("ruling_pre_x_then_xb_launch_follows_xb_and_ack_names_xb", (t) => {
  const dir = tmp(t);
  const w = new SteerWatch(() => dir, Date.now() - 60_000);
  put(dir, "ruling-pre-x.md", "RULING X", nowSec() - 5); // present at the first poll, but written after the session start
  put(dir, "ruling-pre-xb.md", "RULING XB", nowSec() - 1);
  const text = pickupRuling(w, "launch builder", new Date("2026-01-02T03:04:05Z"));
  assert.ok(text.includes("RULING XB"));
  assert.ok(!text.includes("RULING X\n") && !text.includes("ruling-pre-x.md"));
  assert.equal(fs.readFileSync(path.join(dir, "ruling-pre-xb.ack"), "utf8"), "2026-01-02T03:04:05.000Z launch builder\n");
  assert.equal(fs.existsSync(path.join(dir, "ruling-pre-x.ack")), false);
  assert.equal(pickupRuling(w, "launch builder"), ""); // delivered once
  // a fresh watch (restart) honours the persisted last-read record
  assert.equal(pickupRuling(new SteerWatch(() => dir, Date.now() - 60_000), "launch builder"), "");
});

test("ruling_pickup_before_checkpoint_press", (t) => {
  const dir = tmp(t);
  const w = new SteerWatch(() => dir, Date.now() - 60_000);
  put(dir, "ruling-old.md", "OLD", nowSec() - 3600); // before the session start: baseline
  assert.equal(pickupRuling(w, "checkpoint plan-r12.md"), "");
  put(dir, "ruling-new.md", "NEW RULING", nowSec());
  const text = pickupRuling(w, "checkpoint plan-r12.md", new Date("2026-01-02T03:04:05Z"));
  assert.ok(text.includes("NEW RULING"));
  assert.equal(fs.readFileSync(path.join(dir, "ruling-new.ack"), "utf8"), "2026-01-02T03:04:05.000Z checkpoint plan-r12.md\n");
  assert.equal(fs.existsSync(path.join(dir, "ruling-old.ack")), false);
});
