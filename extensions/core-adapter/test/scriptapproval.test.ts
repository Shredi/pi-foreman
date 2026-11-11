import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { sha256 } from "../checkpoint.ts";
import {
  SCRIPT_EXPIRY_MS,
  SCRIPT_MAX_BYTES,
  beginRun,
  cleanText,
  decideScript,
  fixNotice,
  fixRule,
  newScriptState,
  proposeScript,
  readScript,
  recordRealRun,
  recordRun,
  scriptNoticeLines,
  scriptSelectTitle,
  scriptStatus,
  shortHash,
  validateTexts,
} from "../scriptapproval.ts";
import type { ScriptRefusal, ScriptRunPlan } from "../scriptapproval.ts";

const SCRIPT = Array.from({ length: 20 }, (_, i) => `echo line-${i + 1}`).join("\n") + '\n[ "$1" = "--dry-run" ] && exit 0\n';
const REL = ".workflow/scratch/job.sh";
const TEXTS = { description: "Rotate the logs", risk: "Old logs are gone", undo: "Restore from the backup" };
const T0 = 1_000_000;

function workspace(t: { after: (fn: () => void) => void }) {
  const root = fs.realpathSync(mkTestTmp("pf-script-"));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch", "src"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const file = path.join(ws, REL);
  fs.writeFileSync(file, SCRIPT);
  return { root, ws, file, scratch: path.join(ws, ".workflow/scratch"), opts: { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" } };
}

const code = (r: object): string => ("code" in r ? String((r as ScriptRefusal).code) : "");
const isPlan = (r: ScriptRunPlan | ScriptRefusal): r is ScriptRunPlan => "bytes" in r;

function approved(t: { after: (fn: () => void) => void }) {
  const w = workspace(t);
  const state = newScriptState();
  const p = proposeScript(state, { path: REL, ...TEXTS }, w.opts);
  assert.ok("proposal" in p, JSON.stringify(p));
  const d = decideScript(state, { kind: "approve" }, w.opts, T0);
  assert.ok("proposal" in d, JSON.stringify(d));
  return { ...w, state };
}

/** A dry run with exit 0 of the current bytes. */
function dryOk(a: ReturnType<typeof approved>, now = T0): void {
  const plan = beginRun(a.state, "dry", a.opts, now);
  assert.ok(isPlan(plan), JSON.stringify(plan));
  assert.equal(recordRun(a.state, "dry", plan.hash, 0), "dry_ok");
}

test("script: a valid propose is pending with the plain sha256 of the bytes, the relative path and the line count", (t) => {
  const { opts } = workspace(t);
  const state = newScriptState();
  const r = proposeScript(state, { path: REL, ...TEXTS }, opts);
  assert.ok("proposal" in r, JSON.stringify(r));
  assert.equal(r.proposal.status, "pending");
  assert.equal(r.proposal.hash, sha256(Buffer.from(SCRIPT)));
  assert.equal(r.proposal.rel, REL);
  assert.equal(r.proposal.lines, 21);
  assert.equal(state.proposal, r.proposal);
});

test("script: validation refuses a symlink", (t) => {
  const { scratch, opts } = workspace(t);
  try {
    fs.symlinkSync(path.join(scratch, "job.sh"), path.join(scratch, "link.sh"));
  } catch {
    t.skip("no symlink permission");
    return;
  }
  const r = readScript(".workflow/scratch/link.sh", opts);
  assert.equal(code(r), "script_path");
});

test("script: validation refuses a hard link", (t) => {
  const { scratch, opts } = workspace(t);
  fs.linkSync(path.join(scratch, "job.sh"), path.join(scratch, "hard.sh"));
  const r = readScript(".workflow/scratch/hard.sh", opts);
  assert.equal(code(r), "script_path");
  assert.match((r as ScriptRefusal).error, /more than one hard link/);
});

test("script: validation refuses a path outside the scratch root, outside the workspace, a directory and a disabled scratch root", (t) => {
  const { root, ws, opts } = workspace(t);
  fs.writeFileSync(path.join(ws, "src/job.sh"), SCRIPT);
  assert.match((readScript("src/job.sh", opts) as ScriptRefusal).error, /script_path.*must be below \.workflow\/scratch/);
  fs.writeFileSync(path.join(root, "job.sh"), SCRIPT);
  assert.match((readScript(path.join(root, "job.sh"), opts) as ScriptRefusal).error, /script_path.*outside the workspace/);
  assert.equal(code(readScript(".workflow/scratch", opts)), "script_path");
  assert.equal(code(readScript("", opts)), "script_path");
  assert.equal(code(readScript(".workflow/scratch/none.sh", opts)), "script_path");
  assert.match((readScript(REL, { ...opts, scratchDir: "." }) as ScriptRefusal).error, /script_path.*disabled/);
});

test("script: validation accepts 64 KiB and refuses one byte more", (t) => {
  const { file, opts } = workspace(t);
  const head = "# --dry-run\n";
  fs.writeFileSync(file, head + "#".repeat(SCRIPT_MAX_BYTES - head.length));
  assert.ok("script" in readScript(REL, opts));
  fs.writeFileSync(file, head + "#".repeat(SCRIPT_MAX_BYTES - head.length + 1));
  const r = readScript(REL, opts);
  assert.equal(code(r), "script_path");
  assert.match((r as ScriptRefusal).error, /larger than 64 KiB/);
});

test("script: validation refuses invalid UTF-8", (t) => {
  const { file, opts } = workspace(t);
  fs.writeFileSync(file, Buffer.concat([Buffer.from("# --dry-run\n"), Buffer.from([0xff, 0xfe, 0x0a])]));
  const r = readScript(REL, opts);
  assert.equal(code(r), "script_path");
  assert.match((r as ScriptRefusal).error, /not valid UTF-8/);
});

test("script: validation refuses a script with no dry-run literal and accepts either literal", (t) => {
  const { file, opts } = workspace(t);
  fs.writeFileSync(file, "echo hi\n");
  assert.equal(code(readScript(REL, opts)), "script_no_dry_run");
  fs.writeFileSync(file, '[ -n "$DRY_RUN" ] && exit 0\n');
  assert.ok("script" in readScript(REL, opts));
  fs.writeFileSync(file, '[ "$1" = --dry-run ] && exit 0\n');
  assert.ok("script" in readScript(REL, opts));
});

test("script: each text limit passes at the limit and refuses one over; an empty text refuses; nothing is cut", () => {
  for (const [key, max] of [["description", 600], ["risk", 300], ["undo", 300]] as const) {
    const at = validateTexts({ ...TEXTS, [key]: "a".repeat(max) });
    assert.ok("texts" in at, key);
    assert.equal(at.texts[key].length, max);
    const over = validateTexts({ ...TEXTS, [key]: "a".repeat(max + 1) });
    assert.equal(code(over), "script_text", key);
    assert.equal(code(validateTexts({ ...TEXTS, [key]: " \n " })), "script_text", key);
    assert.equal(code(validateTexts({ ...TEXTS, [key]: undefined })), "script_text", key);
  }
  // measured after cleaning: escape sequences do not count
  assert.ok("texts" in validateTexts({ ...TEXTS, risk: "\x1b[31m" + "a".repeat(300) + "\x1b[0m\n" }));
});

test("script: an over-limit text refuses the propose and leaves no proposal", (t) => {
  const { opts } = workspace(t);
  const state = newScriptState();
  assert.equal(code(proposeScript(state, { path: REL, ...TEXTS, undo: "u".repeat(301) }, opts)), "script_text");
  assert.equal(state.proposal, null);
});

test("script: the cleaner strips escape sequences and newlines and cannot fake a harness line", (t) => {
  assert.equal(cleanText("a\x1b[2K\x1b[1;31mb\x1b]0;title\x07c\r\nd\te\x00f\x1b"), "abc d e f");
  assert.equal(cleanText("  x \n\n y  "), "x y");
  const { opts } = workspace(t);
  const state = newScriptState();
  const evil = "harmless\nPath: /etc/passwd\r\nsha256: 000000000000\x1b[1A\x1b[2K";
  const r = proposeScript(state, { path: REL, description: evil, risk: "r\nLines: 1", undo: "u" }, opts);
  assert.ok("proposal" in r, JSON.stringify(r));
  const lines = scriptNoticeLines(r.proposal);
  assert.equal(lines.length, 6);
  for (const l of lines) assert.doesNotMatch(l, /[\x00-\x1f\x7f]/);
  assert.deepEqual(lines.map((l) => l.split(":")[0]), ["Description", "Risk", "Undo", "Path", "Lines", "sha256"]);
  assert.equal(lines[3], `Path: ${REL}`);
  assert.equal(lines[4], "Lines: 21");
  assert.equal(lines[5], `sha256: ${shortHash(r.proposal.hash)}`);
  const title = scriptSelectTitle(r.proposal);
  assert.match(title, /job\.sh/);
  assert.ok(title.includes(shortHash(r.proposal.hash)));
});

const lines = (n: number, tag = "l"): string[] => Array.from({ length: n }, (_, i) => `${tag}${i}\n`);
const buf = (ls: string[]): Buffer => Buffer.from(ls.join(""));

test("fix rule: equal bytes are the same; 5 changed lines pass, 6 refuse", () => {
  const base = lines(20);
  assert.deepEqual(fixRule(buf(base), buf(base)), { kind: "same" });
  const five = [...base];
  five[3] = "x3\n";
  five[9] = "x9\n";
  five.push("new\n"); // 2 removed + 3 added
  const ok = fixRule(buf(base), buf(five));
  assert.equal(ok.kind, "fix");
  assert.deepEqual(ok.kind === "fix" && [ok.added, ok.removed], [3, 2]);
  const six = [...five, "more\n"];
  assert.equal(fixRule(buf(base), buf(six)).kind, "refused");
  // the limit is a parameter
  assert.equal(fixRule(buf(base), buf(six), 6).kind, "fix");
  assert.equal(fixRule(buf(base), buf(five), 4).kind, "refused");
});

test("fix rule: 400 added bytes pass, 401 refuse", () => {
  const base = lines(5);
  const at = fixRule(buf(base), buf([...base, "a".repeat(399) + "\n"]));
  assert.equal(at.kind, "fix");
  assert.equal(at.kind === "fix" && at.addedBytes, 400);
  const over = fixRule(buf(base), buf([...base, "a".repeat(400) + "\n"]));
  assert.equal(over.kind, "refused");
  assert.match(over.kind === "refused" ? over.why : "", /401 bytes/);
});

test("fix rule: a CRLF change counts as a changed line", () => {
  const base = lines(6);
  const crlf = [...base];
  crlf[2] = "l2\r\n";
  const r = fixRule(buf(base), buf(crlf));
  assert.deepEqual(r.kind === "fix" && [r.added, r.removed], [1, 1]);
  assert.equal(fixRule(buf(base), buf(crlf), 1).kind, "refused");
  // every line ending changed: over the bound
  assert.equal(fixRule(buf(base), Buffer.from(base.join("").replace(/\n/g, "\r\n"))).kind, "refused");
});

test("fix rule: limit 0 refuses any change", () => {
  const base = lines(4);
  assert.equal(fixRule(buf(base), buf([...base, "x\n"]), 0).kind, "refused");
  assert.equal(fixRule(buf(base), buf(base), 0).kind, "same");
});

test("fix notice: the first line has the script name and the old and new short hash; changed lines are cleaned, at most 12", () => {
  const from = sha256(Buffer.from("a"));
  const to = sha256(Buffer.from("b"));
  const edits = Array.from({ length: 14 }, (_, i) => ({ sign: "+" as const, line: `echo ${i}\x1b[2K\n` }));
  const out = fixNotice("job.sh", from, to, edits).split("\n");
  assert.ok(out[0].includes("job.sh") && out[0].includes(shortHash(from)) && out[0].includes(shortHash(to)));
  assert.equal(out[1], "+ echo 0");
  assert.equal(out.length, 1 + 12 + 1);
  assert.match(out[13], /2 more changed lines/);
});

test("script: an allowed fix reruns without a dialog, needs a new dry run and carries the notice", (t) => {
  const a = approved(t);
  dryOk(a);
  const approvedHash = a.state.proposal!.approvedHash!;
  fs.writeFileSync(a.file, SCRIPT + "echo fixed\n");
  const run = beginRun(a.state, "run", a.opts, T0);
  assert.equal(code(run), "script_dry_required");
  const fix = (run as ScriptRefusal).fix;
  assert.ok(fix);
  assert.equal(fix.from, shortHash(approvedHash));
  assert.equal(fix.to, shortHash(sha256(Buffer.from(SCRIPT + "echo fixed\n"))));
  const first = fix.notice.split("\n");
  assert.ok(first[0].includes("job.sh") && first[0].includes(fix.from) && first[0].includes(fix.to));
  assert.equal(first[1], "+ echo fixed");
  assert.equal(a.state.proposal!.status, "approved");
  assert.equal(a.state.proposal!.approvedHash, approvedHash);
  const dry = beginRun(a.state, "dry", a.opts, T0);
  assert.ok(isPlan(dry));
  assert.equal(dry.fix, undefined);
  assert.equal(dry.bytes.toString(), SCRIPT + "echo fixed\n");
  assert.equal(recordRun(a.state, "dry", dry.hash, 0), "dry_ok");
  const real = beginRun(a.state, "run", a.opts, T0);
  assert.ok(isPlan(real));
  assert.equal(real.bytes.toString(), SCRIPT + "echo fixed\n");
});

test("script: two fixes of 3 lines each are measured against the approved bytes and refuse", (t) => {
  const a = approved(t);
  fs.writeFileSync(a.file, SCRIPT + "echo a\necho b\necho c\n");
  const one = beginRun(a.state, "dry", a.opts, T0);
  assert.ok(isPlan(one) && one.fix, JSON.stringify(one));
  fs.writeFileSync(a.file, SCRIPT + "echo a\necho b\necho c\necho d\necho e\necho f\n");
  const two = beginRun(a.state, "dry", a.opts, T0);
  assert.equal(code(two), "script_changed");
  // the bytes to run stay the first fix
  assert.equal(a.state.proposal!.runHash, sha256(Buffer.from(SCRIPT + "echo a\necho b\necho c\n")));
});

test("script: a larger change refuses with script_changed; limit 0 refuses any change", (t) => {
  const a = approved(t);
  fs.writeFileSync(a.file, SCRIPT + "echo a\n");
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0, 0)), "script_changed");
  assert.ok(isPlan(beginRun(a.state, "dry", a.opts, T0, 1)));
  fs.writeFileSync(a.file, '[ "$1" = "--dry-run" ] && exit 0\necho other\n');
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_changed");
});

test("script: the reread before a run repeats the propose checks", (t) => {
  const a = approved(t);
  fs.writeFileSync(a.file, SCRIPT.replace("--dry-run", "--dryrun"));
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_no_dry_run");
  fs.writeFileSync(a.file, SCRIPT);
  fs.linkSync(a.file, path.join(a.scratch, "second.sh"));
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_path");
  fs.rmSync(path.join(a.scratch, "second.sh"));
  fs.rmSync(a.file);
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_path");
  fs.writeFileSync(a.file, SCRIPT);
  assert.ok(isPlan(beginRun(a.state, "dry", a.opts, T0)));
});

test("script state: nothing runs before approval, after a reject or after a revise", (t) => {
  const { opts } = workspace(t);
  const state = newScriptState();
  assert.equal(code(beginRun(state, "dry", opts, T0)), "script_pending");
  proposeScript(state, { path: REL, ...TEXTS }, opts);
  assert.equal(code(beginRun(state, "dry", opts, T0)), "script_pending");
  decideScript(state, { kind: "reject" }, opts, T0);
  assert.equal(state.proposal!.status, "rejected");
  assert.equal(code(beginRun(state, "dry", opts, T0)), "script_pending");
  assert.equal(code(decideScript(state, { kind: "approve" }, opts, T0)), "script_pending");
  proposeScript(state, { path: REL, ...TEXTS }, opts);
  decideScript(state, { kind: "revise", note: "use\nrsync" }, opts, T0);
  assert.equal(scriptStatus(state, T0)!.status, "revise");
  assert.equal(scriptStatus(state, T0)!.note, "use rsync");
  assert.equal(code(beginRun(state, "run", opts, T0)), "script_pending");
});

test("script state: an approve of bytes that changed while the dialog was open stays pending", (t) => {
  const { file, opts } = workspace(t);
  const state = newScriptState();
  proposeScript(state, { path: REL, ...TEXTS }, opts);
  fs.writeFileSync(file, SCRIPT + "echo late\n");
  assert.equal(code(decideScript(state, { kind: "approve" }, opts, T0)), "script_pending");
  assert.equal(state.proposal!.status, "pending");
  assert.equal(state.proposal!.approvedBytes, null);
});

test("script state: a real run before a dry run refuses", (t) => {
  const a = approved(t);
  assert.equal(code(beginRun(a.state, "run", a.opts, T0)), "script_dry_required");
  assert.equal(a.state.proposal!.attempts, 0);
});

test("script state: a failing dry run keeps approved; a real run still refuses", (t) => {
  const a = approved(t);
  const dry = beginRun(a.state, "dry", a.opts, T0);
  assert.ok(isPlan(dry));
  assert.equal(recordRun(a.state, "dry", dry.hash, 2), "approved");
  assert.equal(code(beginRun(a.state, "run", a.opts, T0)), "script_dry_required");
  const again = beginRun(a.state, "dry", a.opts, T0);
  assert.ok(isPlan(again));
  assert.equal(recordRun(a.state, "dry", again.hash, null), "approved");
});

test("script state: the approval is consumed at the first real exit 0", (t) => {
  const a = approved(t);
  dryOk(a);
  const run = beginRun(a.state, "run", a.opts, T0);
  assert.ok(isPlan(run));
  assert.equal(run.bytes.toString(), SCRIPT);
  assert.equal(recordRun(a.state, "run", run.hash, 0), "consumed");
  assert.equal(code(beginRun(a.state, "run", a.opts, T0)), "script_consumed");
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_consumed");
});

test("script state: three failed real attempts consume the approval", (t) => {
  const a = approved(t);
  dryOk(a);
  for (let i = 1; i <= 3; i++) {
    const run = beginRun(a.state, "run", a.opts, T0);
    assert.ok(isPlan(run), `attempt ${i}`);
    assert.equal(recordRun(a.state, "run", run.hash, 1), i < 3 ? "dry_ok" : "consumed");
    assert.equal(scriptStatus(a.state, T0)!.attemptsLeft, 3 - i);
  }
  assert.equal(code(beginRun(a.state, "run", a.opts, T0)), "script_consumed");
  assert.equal(scriptStatus(a.state, T0)!.logs.length, 4);
});

test("script state: the approval expires 60 minutes after it was given", (t) => {
  const a = approved(t);
  dryOk(a, T0 + SCRIPT_EXPIRY_MS - 1);
  assert.equal(scriptStatus(a.state, T0)!.expiresAt, T0 + SCRIPT_EXPIRY_MS);
  assert.equal(code(beginRun(a.state, "run", a.opts, T0 + SCRIPT_EXPIRY_MS)), "script_expired");
  assert.equal(scriptStatus(a.state, T0 + SCRIPT_EXPIRY_MS)!.status, "expired");
  assert.equal(code(beginRun(a.state, "dry", a.opts, T0)), "script_expired");
});

test("script state: a new propose drops the approval, also when it is refused", (t) => {
  const a = approved(t);
  dryOk(a);
  const again = proposeScript(a.state, { path: REL, ...TEXTS }, a.opts);
  assert.ok("proposal" in again);
  assert.equal(again.proposal.status, "pending");
  assert.equal(again.proposal.approvedBytes, null);
  assert.equal(code(beginRun(a.state, "run", a.opts, T0)), "script_pending");
  const b = approved(t);
  assert.equal(code(proposeScript(b.state, { path: "src/none.sh", ...TEXTS }, b.opts)), "script_path");
  assert.equal(b.state.proposal, null);
  assert.equal(code(beginRun(b.state, "dry", b.opts, T0)), "script_pending");
});

test("script state: each run gets its own log below the scratch root", (t) => {
  const a = approved(t);
  const dry = beginRun(a.state, "dry", a.opts, T0);
  assert.ok(isPlan(dry));
  assert.equal(path.dirname(dry.logPath), a.scratch);
  assert.match(path.basename(dry.logPath), new RegExp(`^script-job\\.sh-${dry.hash.slice(0, 8)}-dry-1\\.log$`));
  recordRun(a.state, "dry", dry.hash, 0);
  const run = beginRun(a.state, "run", a.opts, T0);
  assert.ok(isPlan(run));
  assert.match(path.basename(run.logPath), /-run-1\.log$/);
});

test("script state: recordRealRun keeps the bytes, hash and time of the run; recordRun alone keeps none", (t) => {
  const a = approved(t);
  dryOk(a);
  const run = beginRun(a.state, "run", a.opts, T0);
  assert.ok(isPlan(run));
  recordRealRun(a.state, "other", T0 + 5);
  assert.equal(a.state.proposal?.ranAt, null, "a foreign hash records nothing");
  recordRun(a.state, "run", run.hash, 1);
  assert.equal(a.state.proposal?.ranAt, null, "recordRun alone records no run for undo");
  recordRealRun(a.state, run.hash, T0 + 5);
  assert.deepEqual([a.state.proposal?.ranHash, a.state.proposal?.ranAt, a.state.proposal?.ranBytes?.toString()], [run.hash, T0 + 5, SCRIPT]);
});
