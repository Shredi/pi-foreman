// `foreman reports migrate` (reports-migrate.ts, reports-cli.ts): dry run by default, selection, keep rule, kind mapping, masked text, count and dates through the fold, idempotence, --archive, damaged blocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, type ReportsDeps } from "../reports-cli.ts";
import { foldRows, readRows, storeFor } from "../reports.ts";
import { parseOldStore } from "../reports-migrate.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "old-backlog");
const NOW = Date.parse("2026-02-10T00:00:00Z");

function rig(t: { after(fn: () => void): void }): { cwd: string; old: string } {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-migrate-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const old = path.join(cwd, "old", "backlog");
  fs.cpSync(FIXTURE, old, { recursive: true });
  return { cwd, old };
}
async function cli(cwd: string, argv: string[], deps: Partial<ReportsDeps> = {}) {
  let out = "";
  let err = "";
  const code = await main(argv, (s) => (out += s), (s) => (err += s), () => ({ cwd, now: () => NOW, expireDays: async () => undefined, ...deps }));
  return { code, out, err };
}
const entries = (cwd: string) => foldRows(readRows(storeFor(cwd).file));

test("the real-format fixture parses: six entries and one damaged block in proj.md", () => {
  const p = parseOldStore(fs.readFileSync(path.join(FIXTURE, "proj.md"), "utf8"), "proj.md", "proj");
  assert.equal(p.entries.length, 6);
  assert.equal(p.damaged, 1);
  assert.deepEqual([p.entries[0].id, p.entries[0].count, p.entries[0].lastSeen], ["a1b2c3d4e5f6", 3, "2026-02-05T09:30:00Z"]);
});

test("a dry run changes nothing; without a selector it only lists", async (t) => {
  const { cwd, old } = rig(t);
  const r = await cli(cwd, ["migrate", "--from", old]);
  assert.equal(r.code, 0);
  assert.match(r.out, /dry run/);
  assert.match(r.out, /no workspace selected: nothing is imported/);
  assert.match(r.out, /1 damaged block skipped/);
  assert.match(r.out, /1 review-model entry left/);
  assert.equal(fs.existsSync(storeFor(cwd).file), false);
  const sel = await cli(cwd, ["migrate", "--from", old, "--all"]);
  assert.match(sel.out, /4 to import/);
  assert.equal(fs.existsSync(storeFor(cwd).file), false, "a selected dry run still writes nothing");
});

test("--apply imports the kept entries with key, count, old dates, source and masked text; review-model stays", async (t) => {
  const { cwd, old } = rig(t);
  const r = await cli(cwd, ["migrate", "--from", old, "--all", "--apply"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /imported 4/);
  const got = entries(cwd);
  assert.deepEqual(got.map((e) => e.key).sort(), ["1a1a1a1a1a1a", "2b2b2b2b2b2b", "a1b2c3d4e5f6", "d3d3d3d3d3d3"]);
  const a1 = got.find((e) => e.key === "a1b2c3d4e5f6")!;
  assert.equal(a1.count, 3, "the old count stands, no session behind it");
  assert.equal(a1.first, "2026-01-20T10:00:00Z");
  assert.equal(a1.last, new Date(NOW).toISOString(), "expiry starts at the move: the entry's last time is the migration time");
  assert.equal(a1.kind, "permission");
  assert.equal(got.find((e) => e.key === "d3d3d3d3d3d3")!.kind, "permission", "flagged-ask becomes permission");
  const text = JSON.stringify(got);
  assert.doesNotMatch(text, /\/home\/dev|abcdef123456/);
  const rows = readRows(storeFor(cwd).file);
  assert.equal(rows.find((x) => x.key === "a1b2c3d4e5f6")!.lastSeen, "2026-02-05T09:30:00Z", "the old last date stays on the row");
  assert.ok(rows.every((x) => x.source === "migrated" && x.ts === new Date(NOW).toISOString()));
  assert.ok(!got.some((e) => /review model/.test(e.subject)));
});

test("keep rule: count >= --min-count or harness-bug, open or planned, inside --within-days", async (t) => {
  const { cwd, old } = rig(t);
  assert.match((await cli(cwd, ["migrate", "--from", old, "--all", "--min-count", "3"])).out, /2 to import/, "a1 (3) and the harness-bug");
  assert.match((await cli(cwd, ["migrate", "--from", old, "--all", "--min-count", "1"])).out, /5 to import/, "the single rule entry counts at 1; the done entry never does");
  assert.match((await cli(cwd, ["migrate", "--from", old, "--all", "--within-days", "200"])).out, /5 to import/, "the November entry is inside 200 days");
  assert.equal((await cli(cwd, ["migrate", "--from", old, "--all", "--min-count", "0"])).code, 2);
});

test("--workspace and --exclude pick old workspaces by glob", async (t) => {
  const { cwd, old } = rig(t);
  const a = await cli(cwd, ["migrate", "--from", old, "--workspace", "tools/*"]);
  assert.match(a.out, /1 to import/);
  const b = await cli(cwd, ["migrate", "--from", old, "--all", "--exclude", "proj", "--exclude", "global"]);
  assert.match(b.out, /1 to import/);
  await cli(cwd, ["migrate", "--from", old, "--workspace", "proj", "--apply"]);
  assert.deepEqual(entries(cwd).map((e) => e.key).sort(), ["a1b2c3d4e5f6", "d3d3d3d3d3d3"]);
});

test("a second --apply imports nothing", async (t) => {
  const { cwd, old } = rig(t);
  await cli(cwd, ["migrate", "--from", old, "--all", "--apply"]);
  const before = fs.readFileSync(storeFor(cwd).file, "utf8");
  const again = await cli(cwd, ["migrate", "--from", old, "--all", "--apply"]);
  assert.match(again.out, /imported 0/);
  assert.match(again.out, /4 already imported/);
  assert.equal(fs.readFileSync(storeFor(cwd).file, "utf8"), before);
});

test("--archive renames the old directory only with --apply and a selection", async (t) => {
  const { cwd, old } = rig(t);
  await cli(cwd, ["migrate", "--from", old, "--all", "--archive"]);
  assert.ok(fs.existsSync(old), "a dry run renames nothing");
  await cli(cwd, ["migrate", "--from", old, "--apply", "--archive"]);
  assert.ok(fs.existsSync(old), "no selector: nothing renamed");
  const r = await cli(cwd, ["migrate", "--from", old, "--all", "--apply", "--archive"]);
  assert.match(r.out, /archived/);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(path.dirname(old), "backlog-archive-2026-02-10", "proj.md")));
});

test("the default --from is the old central store of the deps; a missing store is reported, not an error", async (t) => {
  const { cwd } = rig(t);
  const r = await cli(cwd, ["migrate"], { oldStore: () => path.join(cwd, "nowhere") });
  assert.equal(r.code, 0);
  assert.match(r.out, /\(not found\)/);
  assert.equal((await cli(cwd, ["migrate"])).code, 2, "without --from and without a default store: usage");
});

test("this repository's .workflow/retro-backlog.md is read, named in the output and left in place", async (t) => {
  const { cwd } = rig(t);
  const empty = path.join(cwd, "old", "empty");
  fs.mkdirSync(empty, { recursive: true });
  const repoFile = path.join(cwd, ".workflow", "retro-backlog.md");
  fs.mkdirSync(path.dirname(repoFile), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, "proj.md"), repoFile);
  const before = fs.readFileSync(repoFile, "utf8");
  const r = await cli(cwd, ["migrate", "--from", empty, "--all", "--apply"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /imported 2/);
  assert.match(r.out, /retro-backlog\.md/);
  assert.equal(fs.readFileSync(repoFile, "utf8"), before, "the file is left as it was");
  assert.ok(entries(cwd).some((e) => e.key === "a1b2c3d4e5f6"));
});
