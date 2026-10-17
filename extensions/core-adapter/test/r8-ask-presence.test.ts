// R8 item 13: ask presence. The hand shows only while `.ask` is unanswered (`.seen` differs) AND `needs_ruling: yes`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AskContract } from "../askcontract.ts";
import { BlockedTracker } from "../herdr.ts";
import { askOpen } from "../ruling.ts";

function rig(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r8ask-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, "handoffs", "20261012-100000-kid");
  fs.mkdirSync(own, { recursive: true });
  const tracker = new BlockedTracker({ emit: () => undefined, on: () => undefined });
  const contract = new AskContract({ ownDirs: () => [own], block: (label) => tracker.own(label) });
  return { own, tracker, contract };
}
const ask = (r: ReturnType<typeof rig>, text: string) => {
  fs.writeFileSync(path.join(r.own, "ask.md"), text);
  return r.contract.onFileWritten(path.join(r.own, "ask.md"));
};

test("r8 ask presence: an informational ask never sets blocked, even after an open one", (t) => {
  const r = rig(t);
  assert.equal(ask(r, "# Ask 1: q\nneeds_ruling: yes\n"), "ask");
  assert.equal(r.tracker.active, true);
  assert.equal(ask(r, "# Ask 2: fyi\nneeds_ruling: no\n"), "note");
  assert.equal(r.tracker.active, false);
  r.contract.recheck();
  assert.equal(r.tracker.active, false);
  assert.equal(askOpen(r.own), false);
});

test("r8 ask presence: a stale .ask never blocks an informational ask.md (recheck)", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, ".ask"), "ask-1\n");
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: fyi\nneeds_ruling: no\n");
  r.contract.recheck();
  assert.equal(r.tracker.active, false);
});

test("r8 ask presence: reading ruling-<n>.md writes .seen and flips the state at once", (t) => {
  const r = rig(t);
  ask(r, "# Ask 4: q\nneeds_ruling: yes\n");
  assert.equal(r.tracker.active, true);
  fs.writeFileSync(path.join(r.own, "ruling-4.md"), "A\n");
  assert.equal(r.contract.onRulingWake(path.join(r.own, "ruling-4.md")), true);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8"), "ruling-4.md\n");
  assert.equal(r.tracker.active, false);
});

test("r8 ask presence: presence is cleared when the ask is answered and returns for the next ask", (t) => {
  const r = rig(t);
  ask(r, "# Ask 1: q\nneeds_ruling: yes\n");
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-1.md\n");
  r.contract.recheck();
  assert.equal(r.tracker.active, false);
  ask(r, "# Ask 2: q2\nneeds_ruling: yes\n");
  assert.equal(r.tracker.active, true);
  assert.equal(askOpen(r.own), true);
});

test("r8 ask presence: the hand shows only while .ask != .seen and needs_ruling: yes", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: q\nneeds_ruling: yes\n");
  fs.writeFileSync(path.join(r.own, ".ask"), "ask-1\n");
  assert.equal(askOpen(r.own), true);
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-9.md\n");
  assert.equal(askOpen(r.own), true, "a different ruling does not answer it");
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-1.md\n");
  assert.equal(askOpen(r.own), false);
  fs.rmSync(path.join(r.own, ".seen"));
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: q\nneeds_ruling: no\n");
  assert.equal(askOpen(r.own), false);
});
