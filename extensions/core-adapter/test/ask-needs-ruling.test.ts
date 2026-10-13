// R6 friction: `needs_ruling: no` on ask.md never blocks; a ruling read writes .seen and unblocks at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AskContract } from "../askcontract.ts";
import { BlockedTracker } from "../herdr.ts";

function rig(t: { after(fn: () => void): void }) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-askn-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const own = path.join(root, "handoffs", "20261012-100000-kid");
  fs.mkdirSync(own, { recursive: true });
  const emitted: unknown[] = [];
  const tracker = new BlockedTracker({ emit: (_c, d) => void emitted.push(d), on: () => undefined });
  const contract = new AskContract({ ownDirs: () => [own], block: (label) => tracker.own(label) });
  return { own, emitted, tracker, contract };
}

test("ask.md with `needs_ruling: no`: no .ask, no blocked signal, a note", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: fyi\nneeds_ruling: no\n\nI picked A.\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "ask.md")), "note");
  assert.equal(fs.existsSync(path.join(r.own, ".ask")), false);
  assert.equal(r.tracker.active, false);
  assert.deepEqual(r.emitted, []);
});

test("ask.md with `needs_ruling: yes` or no such line still blocks", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: q\nneeds_ruling: yes\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "ask.md")), "ask");
  assert.equal(r.tracker.active, true);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 2: q2\n\nno needs_ruling line\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "ask.md")), "ask");
  assert.equal(fs.readFileSync(path.join(r.own, ".ask"), "utf8"), "ask-2\n");
});

test("reading ruling-<n>.md writes .seen with that name and the blocked state flips back immediately", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: q\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  assert.equal(r.tracker.active, true);
  fs.writeFileSync(path.join(r.own, "ruling-1.md"), "go with A\n");
  assert.equal(r.contract.onRulingWake(path.join(r.own, "ruling-1.md")), true);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8"), "ruling-1.md\n");
  assert.equal(r.tracker.active, false);
  assert.deepEqual(r.emitted.at(-1), { active: false });
});

test("reading ruling.md writes .seen ruling.md", (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 3: q\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  fs.writeFileSync(path.join(r.own, "ruling.md"), "ok\n");
  assert.equal(r.contract.onRulingWake(path.join(r.own, "ruling.md")), true);
  assert.equal(fs.readFileSync(path.join(r.own, ".seen"), "utf8"), "ruling.md\n");
  assert.equal(r.tracker.active, false);
});
