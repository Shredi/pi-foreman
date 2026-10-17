// Ledger 10b (revision): a steer that arrives just as the run ends is delivered only once it is shown or appended.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { SteerWatch, STEER_WATCH_HEADER, foldSteer } from "../steerwatch.ts";

function setup(t: { after(fn: () => void): void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-swl-")));
  t.after(() => rmTestTmp(dir));
  const w = new SteerWatch(() => dir);
  let fn: (() => void) | null = null;
  const timers = { set: (f: () => void) => ((fn = f), 1), clear: () => void (fn = null) };
  return { dir, w, timers, tick: () => fn?.() };
}

const put = (dir: string, name: string, text: string, sec: number): void => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, text, "utf8");
  fs.utimesSync(f, sec, sec);
};

test("a steer taken as the run ends resolved non-abort is appended to the result text and stays delivered", (t) => {
  const { dir, w, timers, tick } = setup(t);
  let steer = "";
  const stop = w.start((x) => (steer = x), 10, timers);
  put(dir, "steer-1.md", "late steer", 2000);
  tick(); // the wait resolves with the run end in the same turn
  stop();
  const out = foldSteer(w, steer, "run done", true);
  assert.ok(out.startsWith("run done\n") && out.includes(STEER_WATCH_HEADER) && out.includes("late steer"));
  assert.equal(w.take(), "", "delivered: not offered again");
});

test("a steer taken but not shown (aborted turn) stays pending for the next wait", (t) => {
  const { dir, w, timers, tick } = setup(t);
  let steer = "";
  const stop = w.start((x) => (steer = x), 10, timers);
  put(dir, "steer-1.md", "keep me", 2000);
  tick();
  stop();
  assert.equal(foldSteer(w, steer, "run done", false), "run done");
  const next = w.take();
  assert.ok(next.includes("keep me"), "still pending");
  assert.equal(w.take(), "");
});

test("a released steer that replaced an older mark is pending again and the older mark is kept", (t) => {
  const { dir, w, timers, tick } = setup(t);
  put(dir, "steer-1.md", "first", 1000);
  let got = "";
  let stop = w.start((x) => (got = x), 10, timers);
  put(dir, "steer-1.md", "second", 3000);
  tick();
  stop();
  w.release();
  assert.ok(got.includes("second"));
  assert.ok(w.take().includes("second"));
  assert.equal(w.take(), "");
  stop = () => {};
  stop();
});
