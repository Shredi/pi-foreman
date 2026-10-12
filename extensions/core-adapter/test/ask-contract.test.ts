import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AskContract, parseAskHeader } from "../askcontract.ts";
import { BlockedTracker } from "../herdr.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ask-")));
  const own = path.join(root, "handoffs", "20261012-100000-kid");
  const other = path.join(root, "handoffs", "20261012-100500-other");
  fs.mkdirSync(own, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const emitted: unknown[] = [];
  const tracker = new BlockedTracker({ emit: (_c, d) => void emitted.push(d), on: () => undefined });
  const contract = new AskContract({ ownDirs: () => [own], block: (label) => tracker.own(label) });
  return { root, own, other, emitted, tracker, contract };
}

test("ask header: `# Ask <n>: <topic>` on the first line only", () => {
  assert.deepEqual(parseAskHeader("# Ask 2: which schema?\n\nbody"), { n: 2, topic: "which schema?" });
  assert.equal(parseAskHeader("body\n# Ask 2: x"), null);
  assert.equal(parseAskHeader("# Ask two: x"), null);
  assert.equal(parseAskHeader("# Ask 3:"), null);
});

test("ask contract: ask.md in the own handoff dir touches .ask and signals blocked", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: which schema?\n\nOptions A, B.\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "ask.md")), "ask");
  assert.equal(fs.readFileSync(path.join(r.own, ".ask"), "utf8"), "ask-1\n");
  assert.deepEqual(r.emitted, [{ active: true, label: "ask 1: which schema?" }]);
  assert.equal(r.tracker.active, true);
});

test("ask contract: .seen in the own handoff dir ends the blocked signal; shutdown releases too", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 1: q\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  fs.writeFileSync(path.join(r.own, ".seen"), "ruling-1.md\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, ".seen")), "seen");
  assert.equal(r.tracker.active, false);
  assert.deepEqual(r.emitted.at(-1), { active: false });
  fs.writeFileSync(path.join(r.own, "ask.md"), "# Ask 2: q2\n");
  r.contract.onFileWritten(path.join(r.own, "ask.md"));
  assert.equal(r.tracker.active, true);
  r.contract.releaseAll();
  assert.equal(r.tracker.active, false);
});

test("ask contract: other paths do nothing (other handoff dir, other names, bad header)", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.other, "ask.md"), "# Ask 1: q\n");
  assert.equal(r.contract.onFileWritten(path.join(r.other, "ask.md")), null);
  fs.writeFileSync(path.join(r.own, "plan.md"), "# Ask 1: q\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "plan.md")), null);
  fs.writeFileSync(path.join(r.own, "ask.md"), "no header\n");
  assert.equal(r.contract.onFileWritten(path.join(r.own, "ask.md")), null);
  assert.equal(r.contract.onFileWritten(path.join(r.own, "sub", "ask.md")), null);
  assert.equal(fs.existsSync(path.join(r.own, ".ask")), false);
  assert.equal(fs.existsSync(path.join(r.other, ".ask")), false);
  assert.deepEqual(r.emitted, []);
});
