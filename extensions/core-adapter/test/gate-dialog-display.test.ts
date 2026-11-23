// The owner dialog's command display (gatedialog.ts commandDisplay): up to SHOW_ALL_LINES lines whole, else head, an omission line and tail;
// a line over LINE_MAX_CHARS shows its start and end with the hidden count; the full text goes to a trace file whenever something is cut and
// a stateDir is set, and the display names it. Without a stateDir, or when the write fails, the cap still applies and no file is named.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandDisplay, HEAD_LINES, SHOW_ALL_LINES, TAIL_LINES } from "../gatedialog.ts";

function stateDir(t: { after(f: () => void): void }): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dialog-display-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "state");
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const longLine = (n: number) => `echo ${"y".repeat(n)}`;

test("a 100-line command shows 8 head lines, the omission line naming the file, and 3 tail lines", (t) => {
  const dir = stateDir(t);
  const text = lines(100).join("\n");
  const r = commandDisplay(text, dir);
  const shown = r.text.split("\n");
  assert.equal(shown.length, HEAD_LINES + 1 + TAIL_LINES);
  assert.equal(shown[0], "line 1");
  assert.equal(shown[HEAD_LINES - 1], "line 8");
  assert.equal(shown[HEAD_LINES], `... [89 lines omitted; the full text is in ${r.file}]`);
  assert.deepEqual(shown.slice(-TAIL_LINES), ["line 98", "line 99", "line 100"]);
  assert.equal(fs.readFileSync(r.file!, "utf8"), text);
});

test("a 12-line command is shown whole and writes no file; 13 lines are cut", (t) => {
  const dir = stateDir(t);
  const whole = commandDisplay(lines(SHOW_ALL_LINES).join("\n"), dir);
  assert.equal(whole.file, undefined);
  assert.equal(whole.text, lines(SHOW_ALL_LINES).join("\n"));
  assert.equal(fs.existsSync(dir), false);
  const cut = commandDisplay(lines(SHOW_ALL_LINES + 1).join("\n"), dir);
  assert.equal(cut.text.split("\n").length, HEAD_LINES + 1 + TAIL_LINES);
  assert.match(cut.text, /\[2 lines omitted; the full text is in /);
});

test("a 5000-character single line shows its first 200 and last 80 characters around the hidden count, and the file holds all of it", (t) => {
  const dir = stateDir(t);
  const payload = longLine(5000);
  const r = commandDisplay(payload, dir);
  const shown = r.text.split("\n");
  assert.equal(shown.length, 2);
  assert.equal(shown[0], `${payload.slice(0, 200)}… [4725 characters omitted] …${payload.slice(-80)}`);
  assert.equal(shown[1], `... [the full text is in ${r.file}]`);
  assert.equal(fs.readFileSync(r.file!, "utf8"), payload);
});

test("a long command without a stateDir stays capped and names no file", () => {
  const many = commandDisplay(lines(100).join("\n"));
  assert.equal(many.file, undefined);
  assert.equal(many.text.split("\n").length, HEAD_LINES + 1 + TAIL_LINES);
  assert.match(many.text, /^\.\.\. \[89 lines omitted\]$/m);
  assert.doesNotMatch(many.text, /full text/);
  const long = commandDisplay(longLine(5000));
  assert.equal(long.file, undefined);
  assert.equal(long.text, `${longLine(5000).slice(0, 200)}… [4725 characters omitted] …${longLine(5000).slice(-80)}`);
  assert.doesNotMatch(long.text, /full text/);
});

test("a failing file write still caps the display and names no file", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dialog-display-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const blocker = path.join(root, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const many = commandDisplay(lines(100).join("\n"), path.join(blocker, "state"));
  assert.equal(many.file, undefined);
  assert.equal(many.text.split("\n").length, HEAD_LINES + 1 + TAIL_LINES);
  assert.match(many.text, /^\.\.\. \[89 lines omitted\]$/m);
  const long = commandDisplay(longLine(5000), path.join(blocker, "state"));
  assert.equal(long.file, undefined);
  assert.doesNotMatch(long.text, /full text/);
  assert.match(long.text, /\[4725 characters omitted\]/);
});

test("a short command with one long line and a stateDir: the file is written and the display names it", (t) => {
  const dir = stateDir(t);
  const payload = `git status\n${longLine(400)}\necho done`;
  const r = commandDisplay(payload, dir);
  const shown = r.text.split("\n");
  assert.equal(shown.length, 4);
  assert.equal(shown[0], "git status");
  assert.equal(shown[1], `${payload.split("\n")[1].slice(0, 200)}… [125 characters omitted] …${payload.split("\n")[1].slice(-80)}`);
  assert.equal(shown[2], "echo done");
  assert.equal(shown[3], `... [the full text is in ${r.file}]`);
  assert.equal(fs.readFileSync(r.file!, "utf8"), payload);
});

test("a short command within the limits is shown as it is and writes no file", (t) => {
  const dir = stateDir(t);
  const payload = "git status\necho done";
  const r = commandDisplay(payload, dir);
  assert.equal(r.text, payload);
  assert.equal(r.file, undefined);
  assert.equal(fs.existsSync(dir), false);
});
