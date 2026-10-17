// Ledger 9 (10b): a steer written after the launch wait already resolved is taken once the wait ends and shown in its result.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { SteerWatch, STEER_WATCH_HEADER, foldSteer, takeLateSteer } from "../steerwatch.ts";

function setup(t: { after(fn: () => void): void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-swr-")));
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

test("a steer written after the wait resolved (before the poll ran) is delivered in the result once the wait ends", (t) => {
  const { dir, w, timers, tick } = setup(t);
  const stop = w.start(() => {}, 10, timers);
  tick(); // no steer yet
  stop(); // the run ended: the wait resolved first
  put(dir, "steer-1.md", "use approach B", 2000); // the steer lands after the resolution
  const steer = takeLateSteer(w, ""); // the final take at the end of the launch wait (index.ts holdLaunch calls it)
  const out = foldSteer(w, steer, "run done", true);
  assert.ok(out.startsWith("run done\n") && out.includes(STEER_WATCH_HEADER) && out.includes("use approach B"), "delivered in the result");
  assert.equal(w.take(), "", "delivered once: not offered again");
});

test("a steer written after the wait resolved and not shown (aborted turn) stays pending for the next wait", (t) => {
  const { dir, w, timers, tick } = setup(t);
  const stop = w.start(() => {}, 10, timers);
  tick();
  stop();
  put(dir, "steer-1.md", "keep me", 2000);
  const late = takeLateSteer(w, "");
  assert.equal(foldSteer(w, late, "run done", false), "run done");
  assert.ok(w.take().includes("keep me"), "still pending");
});

test("a steer taken by the poll during the wait and a late steer after it resolved are both delivered, poll steer first", (t) => {
  const { dir, w, timers, tick } = setup(t);
  let polled = "";
  const stop = w.start((text) => (polled = text), 10, timers);
  tick(); // baseline: nothing yet
  put(dir, "steer-1.md", "first steer", 2000);
  tick(); // the poll takes the first steer
  assert.ok(polled.includes("first steer"));
  stop();
  put(dir, "steer-2.md", "second steer", 3000);
  const steer = takeLateSteer(w, polled);
  assert.ok(steer.startsWith(polled) && steer.includes("\n\n") && steer.includes("second steer"), "both, poll steer first");
  const out = foldSteer(w, steer, "run done", true);
  assert.ok(out.includes("first steer") && out.includes("second steer"));
  assert.equal(w.take(), "", "delivered once");
});
