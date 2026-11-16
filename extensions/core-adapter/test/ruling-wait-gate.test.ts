// R6 lane 4, the parts that outlive the `.ask`/`.seen` tracking: a file wait on a ruling file, a ruling older than its ask.md ignored by the wait,
// a parent ruling as verdict (named in the refusal, never a verdict), the close line, the pid wait dedupe, and the finish gate staying open after a ruling.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emptySteps, finishRefusal, initialReviewGate, onReviewVerdicts, openSteps, reviewHint } from "../bound.ts";
import { parentApproval, rulingFresh, rulingNeeded, rulingOverrideNote } from "../ruling.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rwg-")));
  const own = path.join(root, "handoffs", "20261012-100000-kid");
  fs.mkdirSync(own, { recursive: true });
  return { root, own };
}

const setTimes = (file: string, sec: number) => fs.utimesSync(file, sec, sec);

function clockRuntime() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set(fn, ms) {
      due.set(++next, { at: now + ms, fn });
      return next;
    },
    clear(h) {
      due.delete(h as number);
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (id === undefined) break;
      due.delete(id);
      now = t!.at;
      t!.fn();
    }
    now = end;
  };
  const wakes: Outcome[][] = [];
  const size = (p: string): number | null => {
    try {
      return fs.statSync(p).size;
    } catch {
      return null;
    }
  };
  const mtime = (p: string): number | null => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  const rt = new WaitRuntime({ timers, now: () => now, limits: () => LIMITS, stat: size, mtime, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined });
  return { rt, advance, wakes };
}

test("4a: a file wait on ruling-1.md wakes when the file appears and writes nothing beside it", () => {
  const r = rig();
  const w = clockRuntime();
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: which schema?\n");
  assert.ok("id" in w.rt.start({ kind: "file", path: path.join(r.own, "ruling-1.md"), note: "" }));
  w.advance(10_000);
  assert.equal(w.wakes.length, 0);
  fs.writeFileSync(path.join(r.own, "ruling-1.md"), "Use schema A.\n");
  w.advance(10_000);
  assert.equal(w.wakes.length, 1);
  assert.equal(fs.existsSync(path.join(r.own, ".seen")), false);
  assert.equal(fs.existsSync(path.join(r.own, ".ask")), false);
  w.rt.dispose();
});

test("4b: a ruling older than ask.md is ignored (two mtimes)", () => {
  const r = rig();
  const ask = path.join(r.own, "ask.md");
  const ruling = path.join(r.own, "ruling-1.md");
  fs.writeFileSync(ask, "# Ask 1: q\n");
  fs.writeFileSync(ruling, "old\n");
  setTimes(ask, 2_000_000);
  setTimes(ruling, 1_000_000);
  assert.equal(rulingFresh(ruling), false);
  const w = clockRuntime();
  w.rt.start({ kind: "file", path: ruling, note: "" });
  w.advance(60_000);
  assert.equal(w.wakes.length, 0, "keeps waiting");
  setTimes(ruling, 3_000_000);
  assert.equal(rulingFresh(ruling), true);
  w.advance(60_000);
  assert.equal(w.wakes.length, 1);
  w.rt.dispose();
});

test("4c (ruling 3): a newer APPROVED ruling is named in the refusal and never lifts the gate; older / non-APPROVED are not named", () => {
  const r = rig();
  const failAt = 5_000_000_000; // ms
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], failAt);
  const refusal = (dirs: string[]) => {
    const missing = openSteps({ ...emptySteps(), builder: 1 }, ["builder", "reviewer"], "pass", failed);
    const named = parentApproval(dirs, failAt);
    return finishRefusal("standard", missing, reviewHint(failed)) + (named ? rulingOverrideNote(named, failAt) : "");
  };
  assert.match(refusal([r.own]), /requires reviewer \(re-review needed: last verdict FAIL\)/);
  const ruling = path.join(r.own, "ruling.md");
  fs.writeFileSync(ruling, "APPROVED\nship it\n");
  setTimes(ruling, failAt / 1000 - 100);
  assert.match(refusal([r.own]), /requires reviewer \(re-review needed: last verdict FAIL\)/, "older than the FAIL");
  setTimes(ruling, failAt / 1000 + 100);
  assert.match(refusal([r.own]), /requires reviewer \(re-review needed: last verdict FAIL\)/, "the gate stays shut");
  assert.equal(parentApproval([r.own], failAt), ruling);
  fs.writeFileSync(ruling, "Looks fine to me\n");
  setTimes(ruling, failAt / 1000 + 100);
  assert.equal(parentApproval([r.own], failAt), null, "first line not APPROVED/SHIP");
  fs.rmSync(ruling);
  fs.writeFileSync(path.join(r.own, "ruling-4.md"), "SHIP\n");
  setTimes(path.join(r.own, "ruling-4.md"), failAt / 1000 + 100);
  assert.equal(parentApproval([r.own], failAt), path.join(r.own, "ruling-4.md"));
});

test("4c: /foreman close lists what the parent would have to rule", () => {
  assert.equal(rulingNeeded([]), "");
  const t = rulingNeeded(["reviewer"]);
  assert.match(t, /Missing: reviewer/);
  assert.match(t, /parent must still rule/);
  assert.match(t, /\/ceremony <tier>/);
});

test("4e: a foreman_wait pid on a pid that is already watched returns the existing wait id", () => {
  const w = clockRuntime();
  const a = w.rt.start({ kind: "pid", pid: 4242, note: "bg", log: "/l" });
  assert.ok("id" in a);
  const b = w.rt.start({ kind: "pid", pid: 4242, note: "again" });
  assert.ok("id" in b && b.id === (a as { id: string }).id && b.deduped === true);
  assert.equal(w.rt.active, 1, "no second wait");
  const c = w.rt.start({ kind: "pid", pid: 4343, note: "other" });
  assert.ok("id" in c && c.id !== (a as { id: string }).id);
  w.rt.dispose();
});

test("4f: a ruling that wakes a file wait leaves the finish gate open: a parent ruling is no verdict", () => {
  const r = rig();
  const w = clockRuntime();
  const failAt = Date.now() - 60_000;
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], failAt);
  const open = () => openSteps({ ...emptySteps(), builder: 1 }, ["builder", "reviewer"], "pass", failed);
  assert.deepEqual(open(), ["reviewer"]);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: may I ship?\n");
  w.rt.start({ kind: "file", path: path.join(r.own, "ruling-1.md"), note: "" });
  fs.writeFileSync(path.join(r.own, "ruling-1.md"), "APPROVED\nship\n");
  w.advance(10_000);
  assert.equal(w.wakes.length, 1);
  assert.deepEqual(open(), ["reviewer"], "a parent ruling is no verdict");
  w.rt.dispose();
});
