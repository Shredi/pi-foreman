// R6 lane 3/4 security review fixes: which handoff dirs count, self-written rulings, FAIL without timestamp,
// ask state only from the child-side dir, secret redaction in denied-command traces, review count deferral.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AskContract } from "../askcontract.ts";
import { initialReviewGate, onReviewVerdicts } from "../bound.ts";
import { BlockedTracker } from "../herdr.ts";
import { childHandoffDirs, ownHandoffDirs } from "../owned.ts";
import { parentApproval, SelfRulings, snapshotRulings } from "../ruling.ts";
import { redactCommand, sanitizeTrace } from "../trace.ts";

const FAIL_AT = 5_000_000_000;
const failed = onReviewVerdicts(initialReviewGate(), ["fail"], FAIL_AT);

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-sec-")));
  const handoffs = path.join(root, "handoffs");
  const mk = (name: string, parent: string, child: string) => {
    const d = path.join(handoffs, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "parent"), `${parent}\n`);
    fs.writeFileSync(path.join(d, "child"), `${child}\n`);
    return d;
  };
  return { handoffs, mk, up: mk("up", "other", "me"), down: mk("down", "me", "kid") };
}

const approve = (dir: string, name = "ruling.md", sec = FAIL_AT / 1000 + 100) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, "APPROVED\n");
  fs.utimesSync(f, sec, sec);
  return f;
};

test("sec 1: childHandoffDirs lists only dirs whose child file names this session", () => {
  const r = rig();
  assert.deepEqual(childHandoffDirs(r.handoffs, "me"), [r.up]);
  assert.deepEqual(childHandoffDirs(r.handoffs, "kid"), [r.down]);
  assert.deepEqual(ownHandoffDirs(r.handoffs, "me").sort(), [r.down, r.up].sort());
});

test("sec 1: APPROVED in a parent-side dir is not named", () => {
  const r = rig();
  approve(r.down);
  assert.equal(parentApproval(childHandoffDirs(r.handoffs, "me"), FAIL_AT), null);
});

test("sec 1: child-side dir, parent-written ruling newer than FAIL is named", () => {
  const r = rig();
  const f = approve(r.up);
  assert.equal(parentApproval(childHandoffDirs(r.handoffs, "me"), FAIL_AT, new SelfRulings()), f);
});

test("sec 1: a ruling this session wrote (write or shell) is not named; a later parent write is", () => {
  const r = rig();
  const self = new SelfRulings();
  const dirs = childHandoffDirs(r.handoffs, "me");
  const f = approve(r.up);
  self.mark(f);
  assert.equal(parentApproval(dirs, FAIL_AT, self), null, "write/edit");
  fs.rmSync(f);
  const before = snapshotRulings(dirs);
  const g = approve(r.up, "ruling-2.md");
  self.markChanged(before, dirs);
  assert.equal(parentApproval(dirs, FAIL_AT, self), null, "shell redirect");
  approve(r.up, "ruling-2.md", FAIL_AT / 1000 + 500); // the parent overwrites it later
  assert.equal(parentApproval(dirs, FAIL_AT, self), g);
});

test("sec 3: a parent-side dir with .ask and no .seen does not block this session", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.down, ".ask"), "ask-1\n"); // a child of this session asks it
  fs.writeFileSync(path.join(r.up, ".ask"), "ask-1\n");
  const tracker = new BlockedTracker({ emit: () => undefined, on: () => undefined });
  const contract = new AskContract({ ownDirs: () => childHandoffDirs(r.handoffs, "me"), block: (label) => tracker.own(label) });
  contract.recheck();
  assert.equal(tracker.active, true, "its own child-side ask blocks");
  fs.writeFileSync(path.join(r.up, ".seen"), "ruling.md\n");
  contract.recheck();
  assert.equal(tracker.active, false, "the parent-side .ask alone never blocks");
  contract.releaseAll();
});

test("sec 4: denied-command traces redact secret-shaped tokens", () => {
  const fake = "0123456789abcdef0123456789abcdef";
  const cases: Array<[string, string]> = [
    ['curl -H "Authorization: Bearer abc.def-ghi" https://x.test', "abc.def-ghi"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNz' x", "dXNlcjpwYXNz"],
    ["run --token=hunter2 --now", "hunter2"],
    ["export API_KEY=fixturevalue", "fixturevalue"],
    ["mysql password=fixturepw", "fixturepw"],
    ["x secret: 'two words'", "two words"],
    ["git clone https://user:pw1234@host.test/r.git", "pw1234"],
    ["aws --k AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["use ghp_abcdefghijkl1234", "ghp_abcdefghijkl1234"],
    ["use sk-abcdefghijkl1234", "sk-abcdefghijkl1234"],
    [`echo ${fake}`, fake],
    ["echo QUJDREVGR0hJSktMTU5PUFFSU1RVVldY", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldY"],
  ];
  for (const [cmd, secret] of cases) {
    const out = redactCommand(cmd);
    assert.ok(!out.includes(secret), `${cmd} -> ${out}`);
    assert.match(out, /\[redacted\]/);
    const t = sanitizeTrace({ event: "launch_refused", command: cmd });
    assert.ok(!String(t.command).includes(secret));
  }
  assert.equal(redactCommand("git status --short"), "git status --short");
  assert.equal(redactCommand(`cat ${os.homedir()}/notes.md`), "cat ~/notes.md");
});

test("sec 5/7: the review count and warning are set after the last launch refusal; review shadows use the reviewer policy", () => {
  const src = fs.readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const commit = src.indexOf("s.reviewCount += pendingReviews");
  assert.ok(commit > src.indexOf("reason: \"rank_policy\""));
  assert.ok(commit > src.indexOf("reason: \"strong_no_reason\""));
  assert.equal(src.match(/s\.reviewCount \+=/g)?.length, 1);
  assert.equal(src.match(/s\.budgetWarned = true/g)?.length, 1);
  assert.ok(src.indexOf("s.budgetWarned = true") > commit);
  assert.match(src, /refused: \(m\) => rankRefusalFor\(s\.config\.config, foremanAt, m, \["reviewer"\]\)/);
});
