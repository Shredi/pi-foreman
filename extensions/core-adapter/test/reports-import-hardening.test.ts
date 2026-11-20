// Import and trace hardening (reportsimport.ts, trace.ts, reports.ts cleanText, reports-cli.ts show): the written trace record carries the counts,
// an odd role shape or an ancient ts is skipped as invalid, bidi controls never reach the store, `show` prints no `undefined`.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { main, type ReportsDeps } from "../reports-cli.ts";
import { cleanText, keyOf, readRows, recordReport, storeFor } from "../reports.ts";
import { checkRow, importEvent, importText } from "../reportsimport.ts";
import { sanitizeTrace } from "../trace.ts";
import { realPath } from "../workspacekey.ts";

const REPO = "acme/app";
const NOW = Date.parse("2026-11-03T12:00:00Z");
const tmp = (t: { after(fn: () => void): void }): string => {
  const dir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), "pf-import-h-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
let n = 100;
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ row: "report", id: (++n).toString(16).padStart(10, "0"), kind: "rule", subject: `fault ${n}`, what: "it blocked a read", effect: "blocked", repo: REPO, role: "builder", session: "s1", ts: "2026-11-03T11:00:00.000Z", ...over });
const lines = (...rows: unknown[]): string => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

test("the trace record written for an import (after sanitizeTrace) has every count; a failed import has the flag", (t) => {
  const store = storeFor(tmp(t));
  const text = lines(row(), row(), "{bad", { row: "state" }, row({ repo: "o/p" }), row({ kind: "x" }));
  const c = importText(store, REPO, text, NOW);
  assert.deepEqual(sanitizeTrace(importEvent(c, "remote")), { event: "reports_import", from: "remote", lines: 6, added: 2, known: 0, malformed: 1, notReport: 1, otherRepo: 1, invalid: 1, oversized: false });
  const again = importText(store, REPO, lines(JSON.parse(text.split("\n")[0])), NOW);
  assert.equal((sanitizeTrace(importEvent(again, "remote")) as Record<string, unknown>).known, 1);
  assert.equal((sanitizeTrace(importEvent(importText(store, REPO, "x".repeat(600 * 1024), NOW), "remote")) as Record<string, unknown>).oversized, true);
  assert.deepEqual(sanitizeTrace({ event: "reports_import", from: "remote", failed: true }), { event: "reports_import", from: "remote", failed: true });
});

test("the import checks the role's shape: plain ids (overlay roles too) and a missing role come in, odd shapes are skipped as invalid", () => {
  for (const role of ["builder", "planner", "Builder", "my.role_2-x", "a".repeat(40), null]) assert.equal("row" in checkRow(row({ role }), REPO, NOW), true, String(role));
  assert.equal((checkRow(row({ role: "planner" }), REPO, NOW) as { row: { role: string } }).row.role, "planner");
  for (const role of ["builder\nx", "builder token=abc", "", "a".repeat(41), "‮builder", "bui lder", 7]) assert.deepEqual(checkRow(row({ role }), REPO, NOW), { skip: "invalid" }, JSON.stringify(role));
});

test("the tool path records a role outside the four built-in ids", (t) => {
  const dir = tmp(t);
  const r = recordReport({ cwd: dir, role: "planner", session: "s", runId: null, source: "agent", repo: REPO, workspace: null, branch: null }, { kind: "rule", subject: "a", what: "b", effect: "note" });
  assert.equal(r.status, "recorded");
  assert.equal(readRows(storeFor(dir).file)[0].role, "planner");
});

test("a ts older than the archive age (90 days) is skipped as invalid and counted; 89 days is kept", (t) => {
  const store = storeFor(tmp(t));
  const day = 86_400_000;
  const c = importText(store, REPO, lines(row({ ts: new Date(NOW - 91 * day).toISOString() }), row({ ts: "0001-01-01T00:00:00Z" }), row({ ts: new Date(NOW - 89 * day).toISOString() })), NOW);
  assert.equal(c.invalid, 2);
  assert.equal(c.added, 1);
});

test("Unicode format characters (U+202E and the like) are stripped from stored text, local and imported", (t) => {
  assert.equal(cleanText("a‮b⁦c\u{E0041}d\u061Ce\u200Ff", 40), "abcdef");
  const dir = tmp(t);
  const w = { cwd: dir, role: "builder", session: "s", runId: null, source: "agent", repo: REPO, workspace: null, branch: null };
  recordReport(w, { kind: "rule", subject: "gu‮ard", what: "wh‮at", effect: "note", suggest: "su‮g" });
  importText(storeFor(dir), REPO, lines(row({ subject: "imp‮orted", what: "w‮hat", session: "s‮2", branch: "b‮x" })), NOW);
  assert.ok(!/‮/.test(fs.readFileSync(storeFor(dir).file, "utf8")), "no U+202E in the store file");
  assert.equal(readRows(storeFor(dir).file).length, 2);
});

test("only bidi controls and tag characters are stripped: ZWJ emoji and soft hyphen stay, a plain subject keeps its key", () => {
  assert.equal(cleanText("👨‍👩‍👧 co\u00ADop a\u200Bb", 40), "👨‍👩‍👧 co\u00ADop a\u200Bb");
  assert.equal(keyOf("rule", cleanText("The guard blocked a read", 80)), "3de027156d92", "sha1 of the old key input, computed on d9cac4a0");
});

test("show prints no undefined for an imported row and quotes the role", async (t) => {
  const dir = tmp(t);
  importText(storeFor(dir), REPO, lines(row({ subject: "shown" })), NOW);
  const key = String(readRows(storeFor(dir).file)[0].key);
  let out = "";
  const deps = (): ReportsDeps => ({ cwd: dir, now: () => NOW, expireDays: async () => undefined, repo: async () => REPO });
  assert.equal(await main(["show", key], (s) => (out += s), () => undefined, deps), 0);
  assert.ok(!out.includes("undefined"), out);
  assert.match(out, /\n- 2026-11-03T11:00:00\.000Z [0-9a-f]{10} "builder" session/);
});
