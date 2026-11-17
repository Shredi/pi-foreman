// A native backslash path to the parent's ruling or brief file is refused on win32 as a write target, quoted or not: bash drops an unquoted
// backslash, so the gate's parse sees another word, and the source text of the word is read as well (ruling.ts nativeNames). The contexts are
// synthetic (the platform is the last argument of selfRulingRefusal, the dir a literal Windows string), so every host runs these. Lines are data, never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

const H = "C:\\Users\\r\\H";
const CWD = "C:\\Users\\r";
const win = (command: string, dirs = [H]) => selfRulingRefusal("bash", { command }, CWD, dirs, "win32");
const spell = (f: string): string[] => [f, `'${f}'`, `"${f}"`];
const NAMES = ["ruling.md", "ruling-2.md", "brief-3.md"];

test("win32: a redirect to a native backslash path of a ruling or brief file is refused, unquoted, single- and double-quoted", () => {
  for (const n of NAMES) for (const f of spell(`${H}\\${n}`)) for (const op of [">", ">>"]) assert.equal(win(`echo A ${op} ${f}`), SELF_RULING_REASON, `echo A ${op} ${f}`);
});

test("win32: tee, cp and mv to a native backslash path of a ruling or brief file are refused, unquoted, single- and double-quoted", () => {
  for (const n of NAMES) {
    for (const f of spell(`${H}\\${n}`)) {
      for (const line of [`echo A | tee ${f}`, `echo A | tee -a ${f}`, `cp x ${f}`, `mv x ${f}`]) assert.equal(win(line), SELF_RULING_REASON, line);
    }
  }
});

test("win32 controls: a read of the same path, a ruling-plan.md or notes.md path, and a path of another dir are not refused", () => {
  for (const f of spell(`${H}\\ruling.md`)) {
    assert.equal(win(`cat ${f}`), undefined, `cat ${f}`);
    assert.equal(win(`cp ${f} x`), undefined, `cp ${f} x`);
  }
  for (const n of ["ruling-plan.md", "notes.md"]) {
    for (const f of spell(`${H}\\${n}`)) for (const line of [`echo A > ${f}`, `echo A | tee ${f}`, `cp x ${f}`, `mv x ${f}`]) assert.equal(win(line), undefined, line);
  }
  for (const f of spell("C:\\Users\\r\\other\\ruling.md")) assert.equal(win(`echo A > ${f}`), undefined, f);
});

test("win32 controls: a session with no child dir (the parent or a top-level session) is not refused", () => {
  for (const f of spell(`${H}\\ruling.md`)) assert.equal(win(`echo A > ${f}`, []), undefined, f);
});

test("the unquoted native spelling adds a refusal on win32 only: a posix platform reads the line as the parse does", () => {
  const line = `echo A > ${H}\\brief-3.md`;
  assert.equal(selfRulingRefusal("bash", { command: line }, CWD, [H], "linux"), undefined);
  assert.equal(selfRulingRefusal("bash", { command: line }, CWD, [H], "win32"), SELF_RULING_REASON);
});
