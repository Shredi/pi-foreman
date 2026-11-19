// The import of a `reports.jsonl` from a parent-opened session (reportsimport.ts, `foreman reports import`): every row is untrusted and rebuilt;
// only rows of the store's repository count; fields the fold trusts never survive; a second import adds nothing; one trace event carries counts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, USAGE, type ReportsDeps } from "../reports-cli.ts";
import { foldRows, keyOf, readRows, storeFor } from "../reports.ts";
import { HANDOFF_REPORTS, IMPORT_MAX_BYTES, checkRow, importEvent, importFile, importText } from "../reportsimport.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = "acme/app";
const NOW = Date.parse("2026-11-03T12:00:00Z");
const tmp = (t: { after(fn: () => void): void }): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-import-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
let n = 0;
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  row: "report", id: (++n).toString(16).padStart(10, "0"), key: "ignored", kind: "rule", subject: `fault ${n}`, what: "it blocked a read", effect: "blocked", suggest: null, repo: REPO, workspace: "app-1", branch: "main", role: "builder", session: "remote-s1", runId: "r1", version: "1.0.0", ts: "2026-11-03T11:00:00.000Z", ...over,
});
const lines = (...rows: unknown[]): string => rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";

test("valid rows come in rebuilt: key recomputed from the stored subject, only the fold's fields kept", (t) => {
  const store = storeFor(tmp(t));
  const c = importText(store, REPO, lines(row({ subject: "guard a", key: "forged" }), row({ subject: "guard b", suggest: "use x" })), NOW);
  assert.equal(c.added, 2);
  const rows = readRows(store.file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].key, keyOf("rule", "guard a"));
  assert.equal(rows[1].suggest, "use x");
  assert.equal(rows[0].session, "remote-s1", "the row keeps its own session");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["branch", "effect", "id", "key", "kind", "repo", "role", "row", "runId", "session", "subject", "suggest", "ts", "version", "what", "workspace"]);
});

test("count, firstSeen, lastSeen and source are stripped: an imported row counts as one session", (t) => {
  const store = storeFor(tmp(t));
  importText(store, REPO, lines(row({ subject: "inflated", count: 99, firstSeen: "2000-01-01T00:00:00Z", lastSeen: "2030-01-01T00:00:00Z", source: "agent" })), NOW);
  const [r] = readRows(store.file);
  for (const k of ["count", "firstSeen", "lastSeen", "source"]) assert.equal(k in r, false, k);
  const [e] = foldRows(readRows(store.file));
  assert.equal(e.count, 1);
  assert.equal(e.first, "2026-11-03T11:00:00.000Z");
});

test("another repository and a null repo on either side are no match", (t) => {
  const store = storeFor(tmp(t));
  const input = lines(row({ repo: "other/app" }), row({ repo: null }), row({ repo: undefined }), row({ repo: "" }));
  const c = importText(store, REPO, input, NOW);
  assert.equal(c.otherRepo, 4);
  assert.equal(c.added, 0);
  const nul = importText(store, null, lines(row({ repo: null }), row()), NOW);
  assert.equal(nul.otherRepo, 2, "a store without a repo takes nothing");
  assert.equal(fs.existsSync(store.file), false);
});

test("a bad enum, over-cap text, a bad id, session or timestamp are skipped as invalid", (t) => {
  const store = storeFor(tmp(t));
  const c = importText(store, REPO, lines(
    row({ kind: "nope" }), row({ effect: "nope" }), row({ subject: "s".repeat(41) }), row({ what: "w".repeat(301) }), row({ suggest: "g".repeat(201) }), row({ suggest: 5 }),
    row({ id: "xyz" }), row({ id: "ABCDEFABCD" }), row({ session: "" }), row({ session: 7 }), row({ ts: "yesterday" }), row({ ts: "2031-01-01T00:00:00Z" }), row({ subject: "  " }),
    row({ what: 12 }), row({ subject: undefined }),
  ), NOW);
  assert.equal(c.invalid, 15);
  assert.equal(c.added, 0);
  assert.equal(importText(store, REPO, lines(row({ suggest: "   " })), NOW).added, 1, "a blank suggestion is none");
});

test("rows of other types never come in", (t) => {
  const store = storeFor(tmp(t));
  const c = importText(store, REPO, lines({ row: "state", key: "abc", state: "dropped", repo: REPO }, { row: "group", keys: ["a", "b"], repo: REPO }, { row: "lesson", id: "0000000001", text: "x", repo: REPO }, { row: "emitted", id: "0000000002", repo: REPO }, { id: "0000000003", repo: REPO }), NOW);
  assert.equal(c.notReport, 5);
  assert.equal(c.added, 0);
});

test("secrets and paths are masked and cut to names again; long fields are cut", (t) => {
  const store = storeFor(tmp(t));
  importText(store, REPO, lines(row({ subject: "/opt/tools/run.sh", what: "password=hunter2hunter2 failed in /var/log/app/out.txt", suggest: "see ~/conf/x.json", role: "builder token=abcdef1234567890", branch: `b${"x".repeat(300)}` })), NOW);
  const [r] = readRows(store.file);
  assert.equal(r.subject, "run.sh");
  assert.ok(!String(r.what).includes("hunter2") && String(r.what).includes("out.txt") && !String(r.what).includes("/var/log"), String(r.what));
  assert.equal(r.suggest, "see x.json");
  assert.ok(!String(r.role).includes("abcdef1234567890"), String(r.role));
  assert.equal((r.branch as string).length, 200);
});

test("malformed lines, non-objects, a long line, CRLF and a BOM: skipped or accepted without an error", (t) => {
  const store = storeFor(tmp(t));
  const text = `﻿${JSON.stringify(row({ subject: "first" }))}\r\n{not json\r\n[1,2]\r\n\r\n"text"\r\n${JSON.stringify(row({ subject: "second", what: "w".repeat(5000) }))}\r\n${JSON.stringify(row({ subject: "third" }))}\r\n`;
  const c = importText(store, REPO, text, NOW);
  assert.equal(c.added, 2);
  assert.equal(c.malformed, 3);
  assert.equal(c.invalid, 1, "a line over the line cap");
  assert.deepEqual(readRows(store.file).map((r) => r.subject), ["first", "third"]);
});

test("an empty file, a missing file and an oversized file import nothing and do not throw", (t) => {
  const dir = tmp(t);
  const store = storeFor(dir);
  assert.equal(importText(store, REPO, "", NOW).added, 0);
  assert.equal(importFile(store, REPO, path.join(dir, "absent.jsonl"), NOW).lines, 0);
  const big = path.join(dir, "big.jsonl");
  fs.writeFileSync(big, `${JSON.stringify(row())}\n${" ".repeat(IMPORT_MAX_BYTES)}`);
  assert.equal(importFile(store, REPO, big, NOW).oversized, true);
  assert.equal(importText(store, REPO, `${JSON.stringify(row())}\n${" ".repeat(IMPORT_MAX_BYTES)}`, NOW).oversized, true);
  assert.equal(fs.existsSync(store.file), false);
});

test("a second import of the same file adds nothing, also when the first rows are in the archive", (t) => {
  const store = storeFor(tmp(t));
  const input = lines(row({ subject: "one" }), row({ subject: "two" }));
  assert.equal(importText(store, REPO, input, NOW).added, 2);
  const again = importText(store, REPO, input, NOW);
  assert.equal(again.added, 0);
  assert.equal(again.known, 2);
  assert.equal(readRows(store.file).length, 2);
  fs.renameSync(store.file, store.archive);
  assert.equal(importText(store, REPO, input, NOW).added, 0);
  const dup = row({ subject: "dup" });
  assert.equal(importText(storeFor(tmp(t)), REPO, lines(dup, dup), NOW).added, 1, "a repeated id inside one file");
});

test("checkRow rebuilds a row and names the reason for a skip", () => {
  assert.equal("row" in checkRow(row(), REPO, NOW), true);
  assert.deepEqual(checkRow({ ...row(), row: "state" }, REPO, NOW), { skip: "notReport" });
  assert.deepEqual(checkRow(row({ repo: "x/y" }), REPO, NOW), { skip: "otherRepo" });
  assert.deepEqual(checkRow(row({ kind: "x" }), REPO, NOW), { skip: "invalid" });
});

test("the trace event of an import carries counts and no text", (t) => {
  const store = storeFor(tmp(t));
  const c = importText(store, REPO, lines(row({ subject: "secret subject text" }), row({ repo: "o/p" }), "{bad"), NOW);
  const ev = importEvent(c, "remote");
  assert.deepEqual(ev, { event: "reports_import", from: "remote", lines: 3, added: 1, known: 0, malformed: 1, notReport: 0, otherRepo: 1, invalid: 0, oversized: false });
  assert.ok(!JSON.stringify(ev).includes("secret subject"));
});

const worker = (dir: string, body: string): string => {
  const script = path.join(dir, `worker-${crypto.randomBytes(3).toString("hex")}.ts`);
  fs.writeFileSync(script, `import * as r from ${JSON.stringify(pathToFileURL(path.resolve(HERE, "..", "reports.ts")).href)};\nimport * as im from ${JSON.stringify(pathToFileURL(path.resolve(HERE, "..", "reportsimport.ts")).href)};\n${body}\n`);
  return script;
};
const run = (script: string, cwd: string, ...args: string[]) => spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
const done = (p: ReturnType<typeof run>): Promise<{ code: number | null; err: string }> => new Promise((res) => { let err = ""; p.stderr!.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, err })); });

test("imports and local report writes at the same time lose no row", async (t) => {
  const dir = tmp(t);
  const store = storeFor(dir);
  const N = 30;
  const file = path.join(dir, "in.jsonl");
  fs.writeFileSync(file, lines(...Array.from({ length: N }, (_, i) => row({ subject: `remote ${i}` }))));
  const importer = worker(dir, `for (let i = 0; i < 3; i++) im.importFile(r.storeFor(process.cwd()), ${JSON.stringify(REPO)}, ${JSON.stringify(file)});`);
  const writer = worker(dir, `for (let i = 0; i < ${N}; i++) r.recordReport({ cwd: process.cwd(), role: "foreman", session: "local-" + i, runId: null, source: "agent", repo: ${JSON.stringify(REPO)}, workspace: null, branch: null }, { kind: "rule", subject: "local " + i, what: "w", effect: "note" });`);
  const results = await Promise.all([run(importer, dir), run(importer, dir), run(writer, dir)].map(done));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const reports = readRows(store.file).filter((r) => r.row === "report");
  assert.equal(reports.filter((r) => String(r.session).startsWith("local-")).length, N);
  assert.equal(reports.filter((r) => r.session === "remote-s1").length, N, "each imported id once, whatever the interleaving");
  assert.equal(new Set(reports.map((r) => r.id)).size, 2 * N);
});

async function cli(cwd: string, argv: string[], repo: string | null = REPO) {
  let out = "";
  let err = "";
  const deps = (): ReportsDeps => ({ cwd, now: () => NOW, expireDays: async () => undefined, repo: async () => repo });
  const code = await main(argv, (s) => (out += s), (s) => (err += s), deps);
  return { code, out, err };
}

test("foreman reports import FILE: happy path, second run, skipped rows in the summary", async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, HANDOFF_REPORTS);
  fs.writeFileSync(file, lines(row({ subject: "one" }), row({ repo: "o/p" }), { row: "state" }, "{bad"));
  const a = await cli(dir, ["import", HANDOFF_REPORTS]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^imported 1, already known 0, skipped 3 \(malformed 1, not a report 1, other repository 1, invalid 0\)/);
  const b = await cli(dir, ["import", file]);
  assert.match(b.out, /^imported 0, already known 1/);
  assert.equal(readRows(storeFor(dir).file).length, 1);
});

test("foreman reports import: a missing file or a directory exits 1, an oversized file exits 1, bad arguments print the usage and exit 2", async (t) => {
  const dir = tmp(t);
  const missing = await cli(dir, ["import", "nope.jsonl"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read nope\.jsonl/);
  assert.equal((await cli(dir, ["import", dir])).code, 1);
  fs.writeFileSync(path.join(dir, "big.jsonl"), "x".repeat(IMPORT_MAX_BYTES + 1));
  const big = await cli(dir, ["import", "big.jsonl"]);
  assert.equal(big.code, 1);
  assert.match(big.err, /larger than/);
  for (const argv of [["import"], ["import", "a", "b"], ["import", "--all"]]) {
    const r = await cli(dir, argv);
    assert.equal(r.code, 2);
    assert.equal(r.err, `${USAGE}\n`);
  }
  assert.match(USAGE, /foreman reports import FILE/);
  assert.equal(fs.existsSync(storeFor(dir).file), false);
});

test("foreman reports import without a repository for this folder takes no row", async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "in.jsonl"), lines(row(), row({ repo: null })));
  const r = await cli(dir, ["import", "in.jsonl"], null);
  assert.equal(r.code, 0);
  assert.match(r.out, /^imported 0, already known 0, skipped 2 \(.*other repository 2/);
});
