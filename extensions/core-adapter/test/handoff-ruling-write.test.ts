// R75: the parent may write ruling*.md / brief*.md into the handoff dir of a session it opened (the dir's `parent` file names its id).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openedHandoffDirs } from "../owned.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ruling-")));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, "handoffs");
const mk = (name: string, files: Record<string, string>): string => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(d, f), t);
  return d;
};
const opened = mk("a-opened", { parent: "me\n", child: "fm-a-111111\n" });
const mine = mk("b-mine", { parent: "boss\n", child: "me\n" });
const foreign = mk("c-foreign", { parent: "someone\n", child: "fm-c-222222\n" });

const wt = path.join(tmp, "wt");
fs.mkdirSync(wt, { recursive: true });
const roots = (o: Partial<GateRoots> = {}): GateRoots => ({
  worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [opened, mine, foreign], openedHandoffs: [opened],
  child: false, role: "foreman", tmpAccess: false, ...o,
});
const rule = (name: string, dir = opened, o: Partial<GateRoots> = {}): string | undefined => pathDecide("write", { path: path.join(dir, name) }, wt, roots(o))?.rule;

test("openedHandoffDirs: only dirs whose parent file names the id", () => {
  assert.deepEqual(openedHandoffDirs(root, "me"), [opened]);
  assert.deepEqual(openedHandoffDirs(root, "boss"), [mine]);
  assert.deepEqual(openedHandoffDirs(root, "fm-a-111111"), [], "a dir where the id is only the child never counts");
  assert.deepEqual(openedHandoffDirs(undefined, "me"), []);
});

test("the parent may write ruling.md and brief-2.md in an opened handoff dir", () => {
  assert.equal(rule("ruling.md"), "path-write-handoff-ruling");
  assert.equal(rule("ruling-3.md"), "path-write-handoff-ruling");
  assert.equal(rule("brief-2.md"), "path-write-handoff-ruling");
});

test("other names, other dirs and a child are no default", () => {
  for (const n of ["notes.md", "ruling.txt", "ruling/x.md", "../ruling.md", "ask.md"]) assert.equal(rule(n), undefined, n);
  assert.equal(rule("ruling.md", mine), undefined, "a dir whose parent file names another id");
  assert.equal(rule("ruling.md", foreign), undefined);
  assert.equal(rule("ruling.md", opened, { child: true }), undefined, "never as a child");
  assert.equal(rule("ruling.md", opened, { openedHandoffs: [] }), undefined);
});
