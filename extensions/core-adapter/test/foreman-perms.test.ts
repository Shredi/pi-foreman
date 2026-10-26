// foreman perms candidates: grouping, thresholds and exclusions on synthetic decision-log records (no real log is read).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { candidateShape, findCandidates, main, shapeId } from "../../../scripts/foreman_perms.mjs";

let n = 0;
const rec = (shape: string, over: Record<string, unknown> = {}) => ({ ts: `2026-10-2${n++ % 9}T10:00:00.000Z`, tool: "bash", layer: "review", verdict: "allow", kind: "owner", shape, ...over });
const times = (k: number, shape: string, over: Record<string, unknown> = {}) => Array.from({ length: k }, () => rec(shape, over));

test("candidateShape generalises numbers, hashes and branch names", () => {
  assert.equal(candidateShape("git log -n 20 abc1234def"), "git log -n <n> <h>");
  assert.equal(candidateShape("git switch feat-x"), "git switch <branch>");
  assert.equal(candidateShape("git push -u origin feat-x"), "git push -u origin <branch>");
  assert.equal(candidateShape("git status && git switch other"), "git status && git switch <branch>");
  assert.equal(candidateShape("npm run build"), "npm run build");
  assert.equal(candidateShape("cat <worktree>/..."), "cat <worktree>/...");
});

test("threshold: review allows count at the minimum, below it nothing is listed", () => {
  assert.equal(findCandidates(times(4, "npm run lint")).length, 0);
  const rows = findCandidates(times(5, "npm run lint"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 5);
  assert.equal(rows[0].section, "allow");
  assert.equal(rows[0].id, shapeId("bash", "npm run lint"));
  assert.equal(findCandidates(times(2, "npm run lint"), 2).length, 1);
});

test("cached allows count, and shapes that differ only in numbers group together", () => {
  const recs = [...times(3, "git log -n 5"), ...times(2, "git log -n 30", { layer: "cache" })];
  const rows = findCandidates(recs);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 5);
});

test("a deny of any layer excludes the shape", () => {
  assert.equal(findCandidates([...times(6, "make all"), rec("make all", { verdict: "deny" })]).length, 0);
  assert.equal(findCandidates([...times(6, "make all"), rec("make all", { layer: "dialog", verdict: "deny", reason: "deny" })]).length, 0);
});

test("an owner override (dialog refusal) excludes the shape", () => {
  assert.equal(findCandidates([...times(6, "make all"), rec("make all", { layer: "dialog", verdict: "deny", reason: "deny" })]).length, 0);
  assert.equal(findCandidates([...times(2, "make all", { layer: "dialog", reason: "allow once" }), rec("make all", { layer: "dialog", verdict: "deny", reason: "deny" })]).length, 0);
});

test("a shape that ever hit a floor is never listed", () => {
  assert.equal(findCandidates([...times(8, "make all"), rec("make all", { layer: "floor", verdict: "deny", rule: "x" })]).length, 0);
  assert.equal(findCandidates([...times(8, "make all"), rec("make all", { layer: "floor", verdict: "allow" })]).length, 0);
});

test("owner dialog approvals: two are enough, one is not, ruling or deny answers do not count", () => {
  assert.equal(findCandidates([rec("make all", { layer: "dialog", reason: "allow once" })]).length, 0);
  const rows = findCandidates([rec("make all", { layer: "dialog", reason: "allow once" }), rec("make all", { layer: "dialog", reason: "allow for session" })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "dialog");
  assert.equal(findCandidates(times(3, "make all", { layer: "dialog", reason: "ruling-allow" })).length, 0);
});

test("default-layer allows do not make candidates; example and last seen come from the newest record", () => {
  assert.equal(findCandidates(times(9, "git status", { layer: "default" })).length, 0);
  const rows = findCandidates([rec("run a", { ts: "2026-10-01T00:00:00Z" }), ...times(4, "run b"), rec("run a", { ts: "2026-10-09T00:00:00Z" })].map((r) => ({ ...r, shape: r.shape === "run b" ? "run a" : r.shape })));
  assert.equal(rows[0].last >= "2026-10-09", true);
});

test("CLI candidates prints a table, reads only, and rejects bad arguments", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-perms-"));
  try {
    const log = path.join(dir, "log.jsonl");
    fs.writeFileSync(log, times(5, "npm run lint").map((r) => JSON.stringify(r)).join("\n") + "\n");
    const before = fs.readFileSync(log, "utf8");
    const lines: string[] = [];
    const orig = console.log;
    const origErr = console.error;
    console.log = (s: string) => void lines.push(String(s));
    console.error = () => undefined;
    try {
      assert.equal(main(["candidates", "--log", log]), 0);
      assert.equal(main(["candidates", "--log", log, "--min", "0"]), 2);
      assert.equal(main(["adopt", "abc"]), 2);
    } finally {
      console.log = orig;
      console.error = origErr;
    }
    assert.equal(lines.length, 2);
    assert.match(lines[1], new RegExp(`^${shapeId("bash", "npm run lint")}\\t5\\t.*\\tallow\\tbash\\tnpm run lint$`));
    assert.equal(fs.readFileSync(log, "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
