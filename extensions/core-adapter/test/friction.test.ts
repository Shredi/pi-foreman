import { test } from "node:test";
import assert from "node:assert/strict";
import { frictionNoteOf, frictionOfRunEnd, kindOfNote, scrubPaths } from "../friction.ts";
import { retroEnabled, traceEnabled } from "../retro.ts";

const end = (output: string, extra: Record<string, unknown> = {}) => ({ runId: "r1", agent: "builder", success: true, results: [{ agent: "builder", output }], ...extra });

test("friction: none, empty and missing lines emit nothing", () => {
  assert.deepEqual(frictionOfRunEnd(end("1. Files changed: a\n2. Friction: none")), []);
  assert.deepEqual(frictionOfRunEnd(end("6. **Friction:** None.")), []);
  assert.deepEqual(frictionOfRunEnd(end("Friction:   \n")), []);
  assert.deepEqual(frictionOfRunEnd(end("no tail at all")), []);
  assert.deepEqual(frictionOfRunEnd({ nope: 1 }), []);
});

test("friction: single line, numbered and bold forms", () => {
  assert.equal(frictionNoteOf("Friction: the brief lacked the test command"), "the brief lacked the test command");
  assert.equal(frictionNoteOf("6. **Friction:** retried twice"), "retried twice");
  assert.equal(frictionNoteOf("- **Friction**: x blocked"), "x blocked");
  assert.deepEqual(frictionOfRunEnd(end("5. Missing: none\n6. Friction: a skill was missing")), [{ role: "builder", runId: "r1", kind: "skill", note: "a skill was missing" }]);
});

test("friction: up to two continuation lines, stopping at a new label or item", () => {
  assert.equal(frictionNoteOf("6. Friction: one\ntwo\nthree\nfour"), "one two three");
  assert.equal(frictionNoteOf("6. Friction: one\nNext: other"), "one");
  assert.equal(frictionNoteOf("6. Friction: one\n7. item"), "one");
  assert.equal(frictionNoteOf("6. Friction: one\n\ntwo"), "one");
});

test("friction: paths reduce to basenames", () => {
  assert.equal(scrubPaths("see /srv/proj/src/a.ts and ~/x/b.md"), "see a.ts and b.md");
  assert.equal(scrubPaths("failed on C:\\work\\proj\\c.py, then (D:/w/d.go)."), "failed on c.py, then (d.go).");
  assert.equal(scrubPaths("plain words only"), "plain words only");
  assert.equal(frictionNoteOf("Friction: could not read /srv/app/conf/x.json"), "could not read x.json");
});

test("friction: note is clipped to 120 characters", () => {
  assert.equal(frictionNoteOf(`Friction: ${"a".repeat(300)}`)?.length, 120);
});

test("friction: kind guesses", () => {
  const cases: Array<[string, string]> = [
    ["edit was denied", "permission"],
    ["the skill was unclear", "skill"],
    ["wrong model for the job", "routing"],
    ["AGENTS said otherwise", "rule"],
    ["the brief was thin", "agent"],
    ["tool crash", "harness-bug"],
    ["something else", "prompt"],
    ["a task", "prompt"],
  ];
  for (const [note, kind] of cases) assert.equal(kindOfNote(note), kind, note);
});

test("friction: several results each report their own line; summary is used without output", () => {
  const data = { runId: "r2", success: true, results: [{ agent: "builder", output: "Friction: no test command" }, { agent: "explorer", summary: "5. Friction: guard blocked a read" }, { agent: "reviewer", output: "Friction: none" }] };
  assert.deepEqual(frictionOfRunEnd(data).map((f) => [f.role, f.kind]), [["builder", "prompt"], ["explorer", "rule"]]);
});

test("retro: effective enable and trace follow the mode unless set explicitly", () => {
  for (const [conf, mode, want] of [[null, "tui", true], [null, "rpc", true], [null, "json", false], [null, "print", false], [null, undefined, false], [true, "print", true], [false, "tui", false]] as const) {
    assert.equal(retroEnabled(conf, mode), want, `${conf}/${mode}`);
  }
  assert.equal(traceEnabled(null, true), true);
  assert.equal(traceEnabled(undefined, false), false);
  assert.equal(traceEnabled(false, true), false);
  assert.equal(traceEnabled(true, false), true);
});
