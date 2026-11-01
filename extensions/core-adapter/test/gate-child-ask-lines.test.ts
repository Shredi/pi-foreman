// r79 item 5 (childask.ts): the child ask file carries `cause` and `reason` lines, role, run, tool and the whole command (no 4000-character cut);
// the wait for the ruling ends early when the parent's owner turns away.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { awaitChildRuling, nextAskN, readChildAsk, writeChildAsk, writeChildRuling } from "../childask.ts";

function dir(t: { after(f: () => void): void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-child-ask-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const BASE = { tool: "bash", cwd: "/w", session: "s1", role: "builder", run: "r1", deadline: 1234567 };

test("the ask file carries cause, reason, role, run, tool, cwd and the command; readChildAsk parses it back", (t) => {
  const d = dir(t);
  const n = writeChildAsk(d, { ...BASE, payload: "kubectl apply -f x.yaml", cause: "danger-deploy", reason: "classifier: nothing\nmatched" });
  assert.equal(n, 1);
  const text = fs.readFileSync(path.join(d, "ask.md"), "utf8");
  assert.match(text, /^# Ask 1: gate danger-deploy for bash\n/);
  assert.match(text, /\ncause: danger-deploy\nreason: classifier: nothing matched\n/);
  assert.match(text, /\nrole: builder\nrun: r1\ndeadline: 1234567\n/);
  const a = readChildAsk(d)!;
  assert.deepEqual([a.n, a.cause, a.reason, a.role, a.run, a.tool, a.cwd, a.payload, a.deadline], [1, "danger-deploy", "classifier: nothing matched", "builder", "r1", "bash", "/w", "kubectl apply -f x.yaml", 1234567]);
});

test("cause values rule <text>, selfmod and no rule matches survive the round trip", (t) => {
  const d = dir(t);
  for (const [i, cause] of ["rule Bash(git push *)", "selfmod", "no rule matches"].entries()) {
    writeChildAsk(d, { ...BASE, payload: "p", cause, reason: "r" });
    const a = readChildAsk(d)!;
    assert.deepEqual([a.n, a.cause], [i + 1, cause]);
  }
});

test("the whole command is written: no 4000-character cut, heredoc and code fences included", (t) => {
  const d = dir(t);
  const payload = `cat <<'EOF'\n${"z".repeat(9000)}\n\`\`\`\ninner fence\n\`\`\`\nEOF`;
  writeChildAsk(d, { ...BASE, payload, cause: "danger-opaque", reason: "r" });
  assert.equal(readChildAsk(d)!.payload, payload);
  assert.doesNotMatch(fs.readFileSync(path.join(d, "ask.md"), "utf8"), /more chars/);
});

test("the next ask is above every header and ruling present", (t) => {
  const d = dir(t);
  assert.equal(nextAskN(d), 1);
  writeChildAsk(d, { ...BASE, payload: "p", cause: "c", reason: "r" });
  writeChildRuling(d, 1, { allow: true });
  writeChildRuling(d, 4, { allow: false, reason: "no" });
  assert.equal(nextAskN(d), 5);
});

test("a ruling is read: ALLOW, DENY with a reason, a foreign first line", async (t) => {
  const d = dir(t);
  writeChildRuling(d, 1, { allow: true });
  writeChildRuling(d, 2, { allow: false, reason: "not now" });
  fs.writeFileSync(path.join(d, "ruling-3.md"), "maybe\n");
  assert.equal((await awaitChildRuling(d, 1, 1000, 5)).answer, "allow");
  assert.deepEqual(await awaitChildRuling(d, 2, 1000, 5), { answer: "deny", first: "DENY", reason: "not now" });
  assert.equal((await awaitChildRuling(d, 3, 1000, 5)).answer, "other");
  assert.equal((await awaitChildRuling(d, 9, 30, 5)).answer, "timeout");
});

test("the wait ends with away when the parent's owner turns away, long before the deadline", async (t) => {
  const d = dir(t);
  let probes = 0;
  const t0 = Date.now();
  const r = await awaitChildRuling(d, 1, 60_000, 5, undefined, () => ++probes >= 2, 20);
  assert.equal(r.answer, "away");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(probes, 2);
});

test("a throwing away probe counts as present; a ruling that arrives still wins", async (t) => {
  const d = dir(t);
  setTimeout(() => writeChildRuling(d, 1, { allow: true }), 80);
  const r = await awaitChildRuling(d, 1, 5000, 5, undefined, () => Promise.reject(new Error("probe")), 20);
  assert.equal(r.answer, "allow");
});

