// R31c R1: the foreman reads its own state records with `grep` (option allowlist, own usage file and own trace file only) and the digit / `--`
// operand hardening of cat/head/tail. Every case runs through the overlay (checkToolCall) and the one own-read decision (ownStateRead).
// The base behaviour (bada3ba) of each positive is "ask": the old USAGE_VERBS had no grep and skipped digit words as options.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, ownStateRead, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownUsageReadable } from "../roundsurface.ts";
import { dropBase, loadBase } from "./_r31c-base.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r31c-grep-")));
after(async () => {
  await waitQuiet(path.join(w, "home", ".pi", "agent", "pi-foreman", "state"));
  rmTestTmp(w);
});
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const SID = "01a1500b-own";
const OTHER = "01a1599c-other";
const FSESS = "01a1500b-fsess"; // the foreman session name of the usage file (usage.ts usageFile), not necessarily the session id
for (const d of [ws, path.join(state, "usage"), path.join(state, "live")]) fs.mkdirSync(d, { recursive: true });
for (const id of [SID, OTHER, FSESS]) {
  fs.writeFileSync(path.join(state, `trace-${id}.jsonl`), "{}\n");
  fs.writeFileSync(path.join(state, "usage", `${id}.jsonl`), "{}\n");
}
fs.writeFileSync(path.join(state, "live", `${SID}.json`), "{}\n");
fs.writeFileSync(path.join(ws, "secret.txt"), "x\n");
fs.symlinkSync(path.join(ws, "secret.txt"), path.join(state, "usage", "link.jsonl"));

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownReads = ownUsageReadable(ag, process.platform, SID, { dir: undefined, stateDir: state }, FSESS);
const main: MatchCtx = { cwd: ws, home, platform: process.platform, role: "main", ownReads };
const sh = (command: string, ctx: MatchCtx = main): string => checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";
const T = `~/.pi/agent/pi-foreman/state/trace-${SID}.jsonl`;
const TO = `~/.pi/agent/pi-foreman/state/trace-${OTHER}.jsonl`;
const U = `~/.pi/agent/pi-foreman/state/usage/${FSESS}.jsonl`;
const UO = `~/.pi/agent/pi-foreman/state/usage/${OTHER}.jsonl`;

test("R1.1 grep over the own trace and the own usage file passes", { skip: !posix }, () => {
  for (const cmd of [
    `grep -c x ${T}`,
    `grep -n x ${U}`,
    `grep -nH -m 5 x ${T}`,
    `grep -A3 -B 2 x ${T}`,
    `grep --color=never -iv x ${T}`,
    `grep -E 'a|b' -- ${T}`,
    `grep '2026-10-23T10' ${T} | grep -E 'a\\|b' | cut -c1-700 | head`,
    `grep x ${T} 2>&1 | head -5`,
    `tail -n +5 ${T}`,
    `head -n 5 ${T}`,
    `tail -n5 ${T}`,
  ]) {
    assert.equal(sh(cmd), "pass", cmd);
    assert.equal(ownStateRead(cmd, main), true, cmd);
  }
});

test("R1.3 grep and cat shapes outside the allowlist still ask", { skip: !posix }, () => {
  for (const cmd of [
    `grep x ${TO}`,
    `grep x ${UO}`,
    `grep x ${T} ${TO}`,
    `grep -R x ${T}`,
    `grep -r x ${T}`,
    `grep -nr x ${T}`,
    `grep --recursive x ${T}`,
    `grep --directories=recurse x ${T}`,
    `grep -d recurse x ${T}`,
    `grep -f ${T} ${T}`,
    `grep --file=${T} ${T}`,
    `grep -e x ${T}`,
    `grep --regexp=x ${T}`,
    `grep --exclude-from=${T} x ${T}`,
    `grep x ${T} -- -y`,
    `grep x ${T} 5`,
    `grep -m x ${T}`,
    `grep x ~/.pi/agent/pi-foreman/state/usage/link.jsonl`,
    `grep x ~/.pi/agent/pi-foreman/state/usage`,
    `grep x ~/.pi/agent/pi-foreman/state/usage/*`,
    `grep x ~/.pi/agent/pi-foreman/state/usage/../trace-${OTHER}.jsonl`,
    `cat ${T} 5`,
    `cat 5 ${T}`,
    `cat -- -x`,
    `cat ${T} -- ${TO}`,
    `tail -n +5 ${TO}`,
    `tail 5 ${TO}`,
    `grep x ${T} | xargs cat`,
    `grep x ${T} > ~/.pi/agent/pi-foreman/state/x`,
    `X=1 grep x ${T}`,
    `env grep x ${T}`,
    `grep "$HOME" ${T}`,
    `grep x $(echo ${T})`,
    `grep x ${T} \`echo\``,
  ]) {
    // a plain read of a state file passes the overlay's protect rule on the base too (it guards writes); the own-read decision is what
    // lifts that rule for a pipeline with a non-reader unit (`| cut`), so it must stay false and the pipeline must not pass
    assert.equal(ownStateRead(cmd, main), false, cmd);
    if ((cmd.includes(OTHER) || cmd.includes("usage")) && !cmd.includes(">")) assert.notEqual(sh(`${cmd} | cut -c1-9`), "pass", cmd);
  }
});

test("R1.3 a child or a missing own-read set never passes", { skip: !posix }, () => {
  assert.equal(ownStateRead(`grep x ${T}`, { ...main, role: "child" }), false);
  assert.equal(ownStateRead(`grep x ${T}`, { ...main, ownReads: [] }), false);
  assert.notEqual(sh(`grep x ${T} | cut -c1-9`, { ...main, ownReads: undefined }), "pass");
  assert.equal(sh(`grep x ${T} | cut -c1-9`), "pass");
});

test("R1.2 the base asks: the base ownStateRead refuses the grep reads that pass now", { skip: !posix }, async (t) => {
  const base = loadBase();
  if (!base) return t.skip("base commit not in this clone");
  try {
    const old = (await base.load("permoverlay")) as { ownStateRead: (c: string, x: MatchCtx) => boolean };
    for (const cmd of [`grep -c x ${T}`, `grep -n x ${U}`, `grep -nH -m 5 x ${T}`, `grep --color=never -iv x ${T}`, `grep x ${T} 2>&1 | head -5`]) {
      assert.equal(old.ownStateRead(cmd, main), false, `base: ${cmd}`);
      assert.equal(ownStateRead(cmd, main), true, cmd);
    }
  } finally {
    dropBase(base);
  }
});

test("R1.4 a chain naming another session's state file ends the allow (grep, cat, wc; ; && | )", { skip: !posix }, () => {
  for (const verb of ["grep x", "cat", "wc -l", "head -3"]) {
    const own = `${verb} ${T}`;
    // the whole usage dir is an own record of cat/head/wc (base design); grep alone is narrowed to the exact own usage file
    for (const other of [`${verb} ${TO}`, ...(verb.startsWith("grep") ? [`${verb} ${UO}`] : []), `${verb} ~/.pi/agent/pi-foreman/state/live/${OTHER}.json`, `${verb} ${T} ${TO}`]) {
      for (const sep of [";", "&&", "||", "|"]) {
        const cmd = `${own} ${sep} ${other}`;
        assert.equal(ownStateRead(cmd, main), false, cmd);
        assert.equal(ownStateRead(`${other} ${sep} ${own}`, main), false, `${other} ${sep} ${own}`);
        assert.notEqual(sh(`${cmd} | cut -c1-9`), "pass", cmd);
      }
    }
  }
  // an own-only chain still passes
  assert.equal(ownStateRead(`grep x ${T}; grep y ${U}`, main), true);
  assert.equal(ownStateRead(`cat ${T} && wc -l ${T}`, main), true);
});

test("R1.5 quoting: $'..', a double quote with $, backtick or backslash end the grep allow; single quotes and plain double quotes pass", { skip: !posix }, () => {
  for (const cmd of [`grep $'x' ${T}`, `grep $'a\\x41' ${T}`, `grep "a\\b" ${T}`, `grep "$X" ${T}`, `grep "a\`b" ${T}`, `grep a\\b ${T}`, `grep $"x" ${T}`, `grep "$(echo x)" ${T}`]) {
    assert.equal(ownStateRead(cmd, main), false, cmd);
    assert.notEqual(sh(`${cmd} | cut -c1-9`), "pass", cmd);
  }
  for (const cmd of [`grep 'a|b' ${T}`, `grep "ab" ${T}`, `grep 'a\\b' ${T}`, `grep -E "a|b" "$HOME/.pi/agent/pi-foreman/state/trace-${SID}.jsonl"`]) {
    assert.equal(ownStateRead(cmd, main), true, cmd);
  }
});
