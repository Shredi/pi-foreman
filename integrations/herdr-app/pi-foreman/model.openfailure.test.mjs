import test from "node:test";
import assert from "node:assert/strict";
import { openFailure } from "./model.js";
import * as plan from "../pi-foreman-plan/model.js";

const LSO = "_LSOpenURLsWithCompletionHandler() failed with error -600 for the URL https://example.org/o/r/pull/1.";

for (const [name, f] of [["Agents", openFailure], ["Plan", plan.openFailure]]) {
  test(`${name} mod: openFailure is empty for a clean exit`, () => {
    assert.equal(f({ code: 0, stdout: "", stderr: "noise" }), "");
  });

  test(`${name} mod: openFailure names the exit code and the first stderr line only`, () => {
    assert.equal(f({ code: 1, stderr: `${LSO}\nsecond line` }), `exit 1: ${LSO}`);
    assert.equal(f({ code: 2, stderr: "\n  \nfirst real line\nnext" }), "exit 2: first real line");
    assert.equal(f({ code: 3, stderr: "" }), "exit 3");
    assert.equal(f({ code: 3 }), "exit 3");
  });

  test(`${name} mod: openFailure gives a thrown error's message`, () => {
    assert.equal(f(new Error("cannot run open: program not found")), "cannot run open: program not found");
  });

  test(`${name} mod: openFailure drops control characters and ANSI escapes, and keeps one line`, () => {
    const out = f({ code: 1, stderr: "\x1b[31mred\x1b[0m\ttext\x07 here\x00\r\nnext" });
    assert.equal(out, "exit 1: red text here");
    assert.equal(f(new Error("a\nb\x1b[1mc\x1b[0m")), "a bc");
    assert.doesNotMatch(out, /[\x00-\x1f\x7f]/);
  });

  test(`${name} mod: openFailure caps an over-long message with an ellipsis`, () => {
    const out = f({ code: 1, stderr: "x".repeat(5000) });
    assert.equal(out.length, 160);
    assert.ok(out.endsWith("…"));
    assert.ok(out.startsWith("exit 1: xxx"));
    assert.equal(f(new Error("y".repeat(5000))).length, 160);
  });

  test(`${name} mod: openFailure never throws on odd input`, () => {
    const odd = [null, undefined, 5, "text", [], {}, { code: null }, { code: 1.5, stderr: 7 }, { code: "x", stderr: { a: 1 } }, { code: 1, stderr: ["a"] }, Object.create(null), new Error(), { message: "m" }];
    for (const v of odd) {
      assert.doesNotThrow(() => f(v));
      assert.equal(typeof f(v), "string");
    }
    assert.equal(f({ code: 1.5, stderr: 7 }), "exit 1.5");
  });
}
