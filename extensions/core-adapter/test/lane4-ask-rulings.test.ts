// R6 lane 4: ruling mechanics (harness-written .seen, blocked recomputed from files, stale ruling ignored,
// parent ruling as verdict, pid wait dedupe) and the ask -> ruling -> seen -> gate scenario end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AskContract } from "../askcontract.ts";
import { emptySteps, finishRefusal, initialReviewGate, onReviewVerdicts, openSteps, reviewHint, withParentRuling } from "../bound.ts";
import { BlockedTracker } from "../herdr.ts";
import { askOpen, parentApproval, rulingFresh, rulingNeeded } from "../ruling.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const LIMITS: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-lane4-")));
  const own = path.join(root, "handoffs", "20261012-100000-kid");
  fs.mkdirSync(own, { recursive: true });
  const emitted: unknown[] = [];
  const tracker = new BlockedTracker({ emit: (_c, d) => void emitted.push(d), on: () => undefined });
  const contract = new AskContract({ ownDirs: () => [own], block: (label) => tracker.own(label) });
  return { root, own, emitted, tracker, contract };
}

const setTimes = (file: string, sec: number) => fs.utimesSync(file, sec, sec);

function clockRuntime(extra: Partial<ConstructorParameters<typeof WaitRuntime>[0]> = {}) {
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
  const rt = new WaitRuntime({ timers, now: () => now, limits: () => LIMITS, stat: size, mtime, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined, ...extra });
  return { rt, advance, wakes };
}

test("4a: a ruling wait waking writes .seen itself and clears the blocked state", () => {
  const r = rig();
  const w = clockRuntime({ onRulingWake: (f) => void r.contract.onRulingWake(f) });
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: which schema?\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  assert.equal(r.tracker.active, true);
  assert.ok("id" in w.rt.start({ kind: "file", path: path.join(r.own, "ruling-1.md"), note: "" }));
  w.advance(10_000);
  assert.equal(w.wakes.length, 0);
  fs.writeFileSync(path.join(r.own, "ruling-1.md"), "Use schema A.\n");
  w.advance(10_000);
  assert.equal(w.wakes.length, 1);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8").trim(), "ruling-1.md");
  assert.equal(r.tracker.active, false);
  assert.deepEqual(r.emitted.at(-1), { active: false });
  w.rt.dispose();
});

test("4a: ruling.md wakes too; a hand-written .seen is idempotent with the harness's", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 3: q\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  fs.writeFileSync(path.join(r.own, "ruling.md"), "go\n");
  assert.equal(r.contract.onRulingWake(path.join(r.own, "ruling.md")), true);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8").trim(), "ruling.md");
  assert.equal(r.tracker.active, false);
  assert.equal(r.contract.onRulingWake(path.join(r.own, "ruling.md")), true);
  assert.equal(r.contract.onRulingWake(path.join(r.own, "plan.md")), false);
  assert.equal(r.tracker.active, false);
});

test("4a: blocked is recomputed from the files on any .seen write, including one made by bash", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 2: q\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  assert.equal(askOpen(r.own), true);
  // a .seen naming another ruling does not end ask 2
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-1.md\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, ".seen")), "seen");
  assert.equal(r.tracker.active, true, "stale .seen: still blocked");
  // bash writes the right one; the bash-result watcher rechecks
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-2.md\n");
  r.contract.recheck();
  assert.equal(r.tracker.active, false);
  // removing .seen by bash re-blocks: not a sticky flag
  fs.rmSync(path.join(r.own, ".seen"));
  r.contract.recheck();
  assert.equal(r.tracker.active, true);
  r.contract.releaseAll();
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
  const w = clockRuntime({ onRulingWake: (f) => void r.contract.onRulingWake(f) });
  w.rt.start({ kind: "file", path: ruling, note: "" });
  w.advance(60_000);
  assert.equal(w.wakes.length, 0, "keeps waiting");
  assert.equal(fs.existsSync(path.join(r.own, ".seen")), false);
  setTimes(ruling, 3_000_000);
  assert.equal(rulingFresh(ruling), true);
  w.advance(60_000);
  assert.equal(w.wakes.length, 1);
  w.rt.dispose();
});

test("4c: finish gate: refused with FAIL, accepted after a newer APPROVED ruling; older / non-APPROVED do not count", () => {
  const r = rig();
  const failAt = 5_000_000_000; // ms
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], failAt);
  const refusal = (dirs: string[]) => {
    const gate = withParentRuling(failed, dirs);
    const missing = openSteps({ ...emptySteps(), builder: 1 }, ["builder", "reviewer"], "pass", gate);
    return missing.length ? finishRefusal("standard", missing, reviewHint(gate)) : "";
  };
  assert.match(refusal([r.own]), /requires reviewer \(re-review needed: last verdict FAIL\)/);
  const ruling = path.join(r.own, "ruling.md");
  fs.writeFileSync(ruling, "APPROVED\nship it\n");
  setTimes(ruling, failAt / 1000 - 100);
  assert.match(refusal([r.own]), /requires reviewer \(re-review needed: last verdict FAIL\)/, "older than the FAIL");
  setTimes(ruling, failAt / 1000 + 100);
  assert.equal(refusal([r.own]), "");
  assert.equal(parentApproval([r.own], failAt), ruling);
  fs.writeFileSync(ruling, "Looks fine to me\n");
  setTimes(ruling, failAt / 1000 + 100);
  assert.match(refusal([r.own]), /re-review needed: last verdict FAIL/, "first line not APPROVED/SHIP");
  fs.rmSync(ruling);
  fs.writeFileSync(path.join(r.own, "ruling-4.md"), "SHIP\n");
  setTimes(path.join(r.own, "ruling-4.md"), failAt / 1000 + 100);
  assert.equal(refusal([r.own]), "");
});

test("4c: /foreman close lists what the parent would have to rule", () => {
  assert.equal(rulingNeeded([]), "");
  const t = rulingNeeded(["reviewer"]);
  assert.match(t, /Missing: reviewer/);
  assert.match(t, /APPROVED or SHIP/);
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

test("4f: ask -> ruling -> .seen by the harness -> blocked cleared -> finish gate accepts the parent ruling", () => {
  const r = rig();
  const w = clockRuntime({ onRulingWake: (f) => void r.contract.onRulingWake(f) });
  const failAt = Date.now() - 60_000;
  const failed = onReviewVerdicts(initialReviewGate(), ["fail"], failAt);
  const open = () => openSteps({ ...emptySteps(), builder: 1 }, ["builder", "reviewer"], "pass", withParentRuling(failed, [r.own]));
  assert.deepEqual(open(), ["reviewer"]);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: may I ship?\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  assert.equal(r.tracker.active, true);
  w.rt.start({ kind: "file", path: path.join(r.own, "ruling-1.md"), note: "" });
  fs.writeFileSync(path.join(r.own, "ruling-1.md"), "APPROVED\nship\n");
  w.advance(10_000);
  assert.equal(w.wakes.length, 1);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8").trim(), "ruling-1.md");
  assert.equal(r.tracker.active, false);
  assert.deepEqual(open(), []);
  w.rt.dispose();
});
