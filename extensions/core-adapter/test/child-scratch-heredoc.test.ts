// ceremony-fixes-2 item 4: a child's cat/tee heredoc write is allowed when every target lies strictly inside its own scratch dir.
// The case table is tests/fixtures/child-scratch-heredoc-cases.json, shared with tests/test_git_guard_child_scratch_heredoc.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const table = JSON.parse(fs.readFileSync(path.join(pkgRoot, "tests", "fixtures", "child-scratch-heredoc-cases.json"), "utf8")) as {
  shell: { name: string; line: string; overlay: "allow" | "deny" | null; win32?: boolean; other?: boolean }[];
};
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const WHY = "never heredoc or stdin-script file writes";
const r = buildOverlayRules(baseline, {}, {}, "/nonexistent/agent", pkgRoot, undefined, false);

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-ov-sh-")));
const scratch = path.join(base, "pi-foreman-scratch", "sess", "launch");
const ws = path.join(base, "ws");
fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(ws, { recursive: true });
const child = (command: string, platform: string = process.platform) =>
  checkToolCall(r, "bash", { command }, { cwd: ws, home: "/nonexistent", platform, role: "child", scratch });
const sub = (s: string): string => s.replaceAll("{scratch}", scratch).replaceAll("{ws}", ws);

test("the shared case table", { skip: !posix }, () => {
  for (const c of table.shell) {
    if (c.overlay === null || c.win32) continue;
    const d = child(sub(c.line));
    if (c.overlay === "deny") {
      assert.equal(d?.kind, "deny", c.name);
      assert.ok(c.other || d!.reason.includes(WHY), `${c.name}: ${d?.reason}`);
    } else assert.equal(d, null, `${c.name}: ${d?.reason}`);
  }
});

test("windows rows: a workspace or dotdot target is denied", () => {
  for (const c of table.shell.filter((x) => x.win32)) {
    const d = child(sub(c.line), "win32");
    assert.equal(d?.kind, "deny", c.name);
  }
});

test("a link already in scratch that points at the workspace is followed", { skip: !posix }, () => {
  const link = path.join(scratch, "link");
  fs.symlinkSync(path.join(ws, "f"), link);
  try {
    const d = child("cat > $FOREMAN_SCRATCH/link <<EOF\nhi\nEOF");
    assert.equal(d?.kind, "deny");
    assert.ok(d!.reason.includes(WHY), d!.reason);
  } finally {
    fs.rmSync(link);
  }
});

test("without a scratch dir the exception does not apply", { skip: !posix }, () => {
  const d = checkToolCall(r, "bash", { command: `cat > ${scratch}/n <<EOF\nhi\nEOF` }, { cwd: ws, home: "/nonexistent", platform: process.platform, role: "child" });
  assert.equal(d?.kind, "deny");
});
