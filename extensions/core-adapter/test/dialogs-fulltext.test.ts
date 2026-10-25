// R41 item 15: dialog records, overlay ask records and `/foreman dialogs` keep the complete command (never cut at 400), redacted by the secrets grammar.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rmTestTmp } from "./_tmpbase.ts";
import { dialogsJson } from "../dialogs.ts";
import { openTrace, sanitizeTrace } from "../trace.ts";

const SECRET = "ghp_abcdefghijklmnop123456";
const LONG = `make build ${"--flag-value=x ".repeat(80)}GITHUB_TOKEN=${SECRET} tail-marker-end`;

function open(t: { after(fn: () => void): void }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dlft-")));
  t.after(() => rmTestTmp(dir));
  return openTrace({ enabled: true, dir: undefined, stateDir: dir, sessionId: "s1" })!;
}

test("sanitizeTrace: a dialog and an overlay ask keep a command over 400 chars, redacted", () => {
  assert.ok(LONG.length > 1000);
  for (const rec of [{ event: "dialog", surface: "permission", command: LONG }, { event: "overlay", decision: "ask-approved", command: LONG }]) {
    const c = String(sanitizeTrace(rec).command);
    assert.ok(c.includes("tail-marker-end"), "not cut");
    assert.ok(c.length > 1000);
    assert.ok(!c.includes(SECRET));
  }
  assert.equal(sanitizeTrace({ event: "overlay", decision: "allow", command: "ls" }).command, undefined, "a plain allow still has no command");
});

test("/foreman dialogs: the lines carry the full redacted command", (t) => {
  const tr = open(t);
  tr.emit({ event: "dialog", surface: "permission", command: LONG });
  tr.emit({ event: "overlay", toolFamily: "bash", decision: "ask-approved", command: LONG });
  const raw = fs.readFileSync(tr.file, "utf8");
  assert.ok(!raw.includes(SECRET));
  const rep = JSON.parse(dialogsJson(tr));
  const lines = Object.values(rep as Record<string, { lines?: string[] }>).flatMap((v) => v?.lines ?? []);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.includes("tail-marker-end") && l.length > 1000 && !l.includes(SECRET)), lines.map((l) => l.length).join(","));
});
