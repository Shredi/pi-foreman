// The send-back marker `rework-<k>` (rework.ts, session.ts writeRework): the in-Pi parser, the local and remote paths of `/foreman session brief`,
// the marker's own number sequence, the scanner, and the ceremony entry's sentBack and watermark. In-process, no child processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionArgs, sessionBrief, writeRegistry, writeRework } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { highestRework } from "../rework.ts";
import { buildCeremonyState, latestCeremonyState, CEREMONY_ENTRY } from "../planstate.ts";
import { rmTestTmp } from "./_tmpbase.ts";

function tmp(t: { after(fn: () => void): void }): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rework-")));
  t.after(() => rmTestTmp(d));
  return d;
}

function deps(dir: string, over: Partial<SessionDeps> = {}): SessionDeps & { sent: [string, string][]; spawned: string[][] } {
  const sent: [string, string][] = [];
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: { PI_INTERCOM_STABLE_ID: "opener" },
    agentDir: dir,
    cwd: dir,
    piSessionId: "sess",
    pkgRoot: "/pkg",
    python: "py",
    spawner: async (_cmd: string, args: string[]) => (spawned.push(args), { code: 0, stdout: "delivered", stderr: "", timedOut: false }),
    send: async (to, text) => (sent.push([to, text]), "sent"),
    ...over,
    sent,
    spawned,
  } as never;
}

test("parse: --rework counts only directly after the target, before the body", () => {
  assert.deepEqual(parseSessionArgs("brief demo --rework fix the tests"), { sub: "brief", target: "demo", body: "fix the tests", rework: true });
  assert.deepEqual(parseSessionArgs("brief demo fix the tests"), { sub: "brief", target: "demo", body: "fix the tests" });
  assert.deepEqual(parseSessionArgs("brief demo fix --rework the tests"), { sub: "brief", target: "demo", body: "fix --rework the tests" });
  assert.deepEqual(parseSessionArgs("brief demo --rework"), { sub: "brief", target: "demo", body: "--rework" }, "no body after it: the word is the text");
  assert.deepEqual(parseSessionArgs("brief demo --reworked x"), { sub: "brief", target: "demo", body: "--reworked x" });
});

test("local path: the flag writes the marker beside the brief; no flag, or the word inside the body, writes none", async (t) => {
  const dir = tmp(t);
  const handoff = path.join(dir, "h");
  fs.mkdirSync(handoff);
  fs.writeFileSync(path.join(handoff, "child"), "kid\n");
  writeRegistry(dir, { version: 1, sessions: [{ label: "demo", child: "kid", status: "open", handoff }] });
  const d = deps(dir);
  const run = (line: string) => {
    const c = parseSessionArgs(line);
    assert.ok("sub" in c && c.sub === "brief");
    return sessionBrief(d, c.target, c.body, c.rework === true);
  };
  assert.equal((await run("brief demo plain brief")).ok, true);
  assert.equal((await run("brief demo go --rework now")).ok, true);
  assert.deepEqual(fs.readdirSync(handoff).filter((n) => n.startsWith("rework")), [], "no flag: no marker");
  assert.equal((await run("brief demo --rework send it back")).ok, true);
  assert.equal(fs.readFileSync(path.join(handoff, "brief-3.md"), "utf8"), "send it back\n", "the body is without the flag");
  assert.deepEqual(fs.readdirSync(handoff).filter((n) => n.startsWith("rework")), ["rework-1"]);
  assert.equal(fs.statSync(path.join(handoff, "rework-1")).size, 0);
});

test("remote path: the flag is passed on to the script, only when given", async (t) => {
  const dir = tmp(t);
  writeRegistry(dir, { version: 1, sessions: [{ label: "far", child: "kid", status: "open", machine: "alpha" }] });
  const d = deps(dir);
  await sessionBrief(d, "far", "hello there");
  await sessionBrief(d, "far", "hello again", true);
  const [plain, flagged] = d.spawned;
  assert.ok(!plain.includes("--rework"));
  assert.deepEqual(flagged.slice(flagged.indexOf("brief")), ["brief", "--rework", "far", "hello again"]);
  assert.equal(d.sent.length, 0, "the script delivers, not this side");
});

test("marker numbers are their own sequence: the one after the highest on disk, never shared, independent of brief and ruling numbers", (t) => {
  const dir = tmp(t);
  for (const n of ["brief-7.md", "ruling-2.md", "ruling.md"]) fs.writeFileSync(path.join(dir, n), "x");
  assert.equal(path.basename(writeRework(dir)), "rework-1", "a high brief number does not start the markers high");
  assert.equal(path.basename(writeRework(dir)), "rework-2");
  fs.rmSync(path.join(dir, "rework-1"));
  assert.equal(path.basename(writeRework(dir)), "rework-3", "no reuse of a free low number below the highest");
  assert.equal(path.basename(writeRework(dir)), "rework-4");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("rework")).sort(), ["rework-2", "rework-3", "rework-4"]);
});

test("markers 1 and 3 present: the next is 4", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "rework-1"), "");
  fs.writeFileSync(path.join(dir, "rework-3"), "");
  assert.equal(path.basename(writeRework(dir)), "rework-4");
});

test("marker 2 handled and removed: the next send-back is above the child's watermark and is seen", (t) => {
  const dir = tmp(t);
  for (const n of ["rework-1", "rework-2", "rework-3"]) fs.writeFileSync(path.join(dir, n), "");
  const watermark = highestRework(dir);
  assert.equal(watermark, 3);
  fs.rmSync(path.join(dir, "rework-2"));
  const next = path.basename(writeRework(dir));
  assert.equal(next, "rework-4");
  assert.ok(highestRework(dir) > watermark, "the scanner sees the new send-back");
});

test("a stray high marker: the next send-back still goes above the watermark and is seen", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "rework-900"), "");
  const watermark = highestRework(dir);
  assert.equal(watermark, 900);
  assert.equal(path.basename(writeRework(dir)), "rework-901");
  assert.ok(highestRework(dir) > watermark, "the scanner sees the new send-back");
});

test("two deliveries never share a marker", (t) => {
  const dir = tmp(t);
  const first = writeRework(dir);
  const second = writeRework(dir);
  assert.notEqual(first, second);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("rework")).length, 2);
});

test("rework-999 is the highest the scanner reads: no marker past it is written, and none is overwritten", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "rework-999"), "");
  assert.throws(() => writeRework(dir), /rework-999 is the highest/);
  assert.deepEqual(fs.readdirSync(dir), ["rework-999"]);
  assert.equal(highestRework(dir), 999);
});

test("scanner: only regular rework-<k> files count; the highest k wins", (t) => {
  const dir = tmp(t);
  assert.equal(highestRework(dir), 0);
  assert.equal(highestRework(path.join(dir, "nope")), 0);
  for (const n of ["rework-0", "rework-1.md", "rework", "rework-01", "xrework-9", "rework-1000"]) fs.writeFileSync(path.join(dir, n), "");
  fs.mkdirSync(path.join(dir, "rework-8"));
  assert.equal(highestRework(dir), 0);
  fs.writeFileSync(path.join(dir, "rework-2"), "");
  fs.writeFileSync(path.join(dir, "rework-10"), "");
  fs.writeFileSync(path.join(dir, "rework-3"), "");
  assert.equal(highestRework(dir), 10);
});

test("ceremony entry: sentBack and the watermark are written only when set and read back; bad values are dropped", () => {
  const base = { plan: null, lineages: [], planPhase: false };
  const none = buildCeremonyState(base);
  assert.ok(!("sentBack" in none) && !("reworkSeen" in none), "no marker = nothing recorded");
  const set = buildCeremonyState({ ...base, sentBack: true, reworkSeen: 4 });
  const read = latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data: set }]);
  assert.equal(read?.sentBack, true);
  assert.equal(read?.reworkSeen, 4);
  const bad = latestCeremonyState([{ type: "custom", customType: CEREMONY_ENTRY, data: { ...set, sentBack: "yes", reworkSeen: -1 } }]);
  assert.equal(bad?.sentBack, undefined);
  assert.equal(bad?.reworkSeen, undefined);
});
