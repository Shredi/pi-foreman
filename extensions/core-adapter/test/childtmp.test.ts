// R3b point 8a: a child with a bound scratch dir is denied (not asked) any write below /tmp or the temp dir
// outside that scratch; the reason names FOREMAN_SCRATCH and its path. The foreman's own /tmp rules stay.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmpReal = fs.realpathSync.native(os.tmpdir());
const scratch = path.join(tmpReal, "pi-foreman-scratch", "sess-8a", "L-child");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, path.join(tmpReal, "agent-8a"));
const base = { cwd: PKG, home: tmpReal, platform: process.platform };
const child = (command: string, withScratch = true) => checkToolCall(rules, "bash", { command }, { ...base, role: "child", scratch: withScratch ? scratch : undefined });
const posix = process.platform !== "win32";

test("R3 line 1: `npm test > /tmp/_t1.txt 2>&1; …` is denied with the scratch path in the reason", { skip: !posix }, () => {
  const d = child("npm test > /tmp/_t1.txt 2>&1; echo done");
  assert.equal(d?.kind, "deny");
  assert.match(d!.reason, /\/tmp\/_t1\.txt/);
  assert.ok(d!.reason.includes(`FOREMAN_SCRATCH (${scratch})`), d!.reason);
});

test("R3 line 2: `npm run test:node > /tmp/_t2.txt …; npm run typecheck > /tmp/_t3.txt` is denied", { skip: !posix }, () => {
  const d = child("npm run test:node > /tmp/_t2.txt 2>&1; npm run typecheck > /tmp/_t3.txt 2>&1");
  assert.equal(d?.kind, "deny");
  assert.ok(d!.reason.includes(scratch));
});

test("writes below the resolved temp dir and writer verbs are denied too", () => {
  assert.equal(child(`echo x > ${tmpReal}/other/out.txt`)?.kind, "deny");
  assert.equal(child(`echo x | tee ${tmpReal}/out.txt`)?.kind, "deny");
  assert.equal(child(`cp a.txt ${tmpReal}/out.txt`)?.kind, "deny");
  assert.equal(child(`mkdir -p ${tmpReal}/d`)?.kind, "deny");
  const t = checkToolCall(rules, "write", { path: path.join(tmpReal, "x.txt"), content: "x" }, { ...base, role: "child", scratch });
  assert.equal(t?.kind, "deny");
  assert.ok(t!.reason.includes(scratch));
});

test("the child's scratch dir, its workspace, reads from /tmp and /dev/null stay open", { skip: !posix }, () => {
  assert.notEqual(child(`echo x > ${scratch}/out.txt`)?.kind, "deny");
  assert.notEqual(child("echo x > $FOREMAN_SCRATCH/out.txt")?.kind, "deny");
  assert.notEqual(child("npm test > /dev/null 2>&1")?.kind, "deny");
  assert.notEqual(child("cp /tmp/in.txt ./out.txt")?.kind, "deny");
  assert.notEqual(child("cat /tmp/in.txt")?.kind, "deny");
  assert.notEqual(child("echo x > .workflow/scratch/out.txt")?.kind, "deny");
});

test("no deny without a bound scratch, and never for the foreman", { skip: !posix }, () => {
  assert.notEqual(child("npm test > /tmp/_t1.txt", false)?.reason?.includes("FOREMAN_SCRATCH"), true);
  const main = checkToolCall(rules, "bash", { command: "npm test > /tmp/_t1.txt" }, { ...base, role: "main", scratch });
  assert.notEqual(main?.reason?.includes("FOREMAN_SCRATCH"), true);
});
