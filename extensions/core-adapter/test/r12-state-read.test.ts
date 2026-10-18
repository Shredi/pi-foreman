// R12 P1 item 2: the foreman's own state/usage and own state/live/<session>.json are read with read-only verbs without the protected-config
// dialog, also in the spellings R11 hit (tilde, trailing slash, a `;`/pipe chain whose other segments are read-only, the variable-bound
// `f=<own path>; … $f` form) and through the narrow `node -e` read form; writes into state/ and another session's live file stay protected.
// Each case runs through the overlay (checkToolCall) as the foreman.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline, usageNodeRead } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { ownUsageReadable } from "../roundsurface.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike } from "../review.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;
const posix = process.platform !== "win32";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r12-state-")));
after(() => fs.rmSync(w, { recursive: true, force: true }));
const ws = path.join(w, "ws");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const state = path.join(ag, "pi-foreman", "state");
const usage = path.join(state, "usage");
const live = path.join(state, "live");
const SID = "01a14b65-own";
const OTHER = "01a14b99-other";
for (const d of [ws, usage, live]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(usage, `${SID}.jsonl`), "{}\n");
fs.writeFileSync(path.join(live, `${SID}.json`), "{}\n");
fs.writeFileSync(path.join(live, `${OTHER}.json`), "{}\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const ownReads = ownUsageReadable(ag, process.platform, SID);
const ctx: MatchCtx = { cwd: ws, home, platform: process.platform, role: "main", ownReads };
const sh = (command: string): string => checkToolCall(rules, "bash", { command }, ctx)?.kind ?? "pass";

test("state_usage_ls_grep_chain_r11_literal", { skip: !posix }, () => {
  // the R11 literal: tilde, trailing slash, a pipe into grep, a `;` chain with node --version
  assert.equal(sh(`ls ~/.pi/agent/pi-foreman/state/usage/ | grep 01a14b65; node --version`), "pass");
  assert.equal(sh(`ls $HOME/.pi/agent/pi-foreman/state/usage/ | grep 01a14b65`), "pass");
  assert.equal(sh(`ls ${usage}/ | wc -l`), "pass");
});

test("state_live_var_bound_python_r11_literal", { skip: !posix }, () => {
  // the R11 literal form: the own presence file bound to f, then a python3 -c read through $f
  assert.equal(sh(`f=~/.pi/agent/pi-foreman/state/live/${SID}.json; python3 -c "import json,sys; print(json.load(open(sys.argv[1])))" $f`), "pass");
  assert.equal(sh(`f=~/.pi/agent/pi-foreman/state/live/${SID}.json; python3 -c "print(open('$f').read())"`), "pass");
});

test("state_live_var_bound_python_open_argv_r12_live_literal", { skip: !posix }, () => {
  // the R12 live literal: a subscript after json.load (`["state"]`, escaped inside the double-quoted code), the path as the last argv
  const F = `~/.pi/agent/pi-foreman/state/live/${SID}.json`;
  const body = (open: string) => `"import json,sys; print(json.load(${open})[\\"state\\"])"`;
  assert.equal(sh(`f=${F}; python3 -c ${body("open(sys.argv[1])")} $f`), "pass");
  assert.equal(sh(`f=${F}; python3 -c ${body(`open(sys.argv[1], 'r')`)} $f`), "pass");
  assert.equal(sh(`f=${F}; python3 -c ${body(`open(sys.argv[1], 'rb')`)} $f`), "pass");
  assert.equal(sh(`f=${F}; python3 -c "import json,sys; print(open(sys.argv[2]).read())" $f $f`), "pass");
  // a write mode, a write call, another session's file, a foreign argv or a child stay protected
  for (const cmd of [
    `f=${F}; python3 -c ${body(`open(sys.argv[1], 'w')`)} $f`,
    `f=${F}; python3 -c ${body(`open(sys.argv[1], \\"a\\")`)} $f`,
    `f=${F}; python3 -c ${body(`open(sys.argv[1], 'r+')`)} $f`,
    `f=${F}; python3 -c "import json,sys; print(json.load(open(sys.argv[1])))" $f ~/.pi/agent/pi-foreman/state/rounds.json`,
    `f=${F}; python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\\"state\\"]); open(sys.argv[1],'w')" $f`,
    `f=~/.pi/agent/pi-foreman/state/live/${OTHER}.json; python3 -c ${body("open(sys.argv[1])")} $f`,
  ]) assert.notEqual(sh(cmd), "pass", cmd);
  const child: MatchCtx = { cwd: ws, home, platform: process.platform, role: "child", ownReads };
  assert.notEqual(checkToolCall(rules, "bash", { command: `f=${F}; python3 -c ${body("open(sys.argv[1])")} $f` }, child)?.kind ?? "pass", "pass");
});

test("state_live_var_bound_ls", { skip: !posix }, () => {
  assert.equal(sh(`f=~/.pi/agent/pi-foreman/state/live/${SID}.json; ls $f`), "pass");
  assert.equal(sh(`f=~/.pi/agent/pi-foreman/state/live/${SID}.json; ls -la "\${f}"; cat $f | head -n 3`), "pass");
});

test("state_usage_node_e_read", { skip: !posix }, () => {
  const F = path.join(usage, `${SID}.jsonl`);
  assert.equal(sh(`node -e "console.log(require('fs').readFileSync('${F}','utf8'))"`), "pass");
  assert.equal(sh(`node -e "process.stdout.write(require('fs').readFileSync('${F}', 'utf8'))"`), "pass");
  assert.equal(usageNodeRead(`node -e "console.log(require('fs').readFileSync('${F}','utf8'))"`, ownReads, ctx), true);
  // any write or other module stays out of the form
  assert.equal(usageNodeRead(`node -e "require('fs').writeFileSync('${F}','x')"`, ownReads, ctx), false);
  assert.equal(usageNodeRead(`node -e "require('child_process').execSync('ls ${usage}')"`, ownReads, ctx), false);
  assert.equal(usageNodeRead(`node -e "console.log(require('fs').readFileSync('${path.join(state, "rounds.json")}','utf8'))"`, ownReads, ctx), false);
  assert.notEqual(sh(`node -e "require('fs').writeFileSync('${F}','x')"`), "pass");
});

test("state_usage_node_e_read: the permission link allows the node read form without the model, not a node write", { skip: !posix }, async () => {
  const F = path.join(usage, `${SID}.jsonl`);
  const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
  const r = new ForemanReview();
  r.upsert("s", { isChild: false, cwd: ws, provider: "a", config: () => ({}), registry: reg, intent: "", ownReads: () => ownReads });
  const link = async (value: string) => (await r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash" })).kind;
  assert.equal(await link(`node -e "console.log(require('fs').readFileSync('${F}','utf8'))"`), "allow");
  assert.notEqual(await link(`node -e "require('fs').writeFileSync('${F}','x')"`), "allow");
});

test("state_write_redirect_still_protected", { skip: !posix }, () => {
  for (const cmd of [
    `ls ~/.pi/agent/pi-foreman/state/usage/ > ~/.pi/agent/pi-foreman/state/usage/x`,
    `ls ~/.pi/agent/pi-foreman/state/usage/ | tee ~/.pi/agent/pi-foreman/state/x`,
    `cat ~/.pi/agent/pi-foreman/state/usage/${SID}.jsonl; touch ~/.pi/agent/pi-foreman/state/x`,
    `f=~/.pi/agent/pi-foreman/state/live/${SID}.json; echo x > $f`,
    `f=~/.pi/agent/pi-foreman/state/live/${SID}.json; ls $f; rm $f`,
    `ls ~/.pi/agent/pi-foreman/state/usage/ | grep x; node -e "1"`,
    `ls ~/.pi/agent/pi-foreman/state/usage/ | sh`,
    `ls ~/.pi/agent/pi-foreman/state/usage/ | xargs rm; node --version`,
    `ls ~/.pi/agent/pi-foreman/state/usage/ | grep x || touch ~/.pi/agent/pi-foreman/state/x`,
    `cat ~/.pi/agent/pi-foreman/state/rounds.json | grep x; node --version`,
    `false && f=~/.pi/agent/pi-foreman/state/live/${SID}.json; ls $f; node --version`,
    `f=~/.pi/agent/pi-foreman/state/live/${SID}.json; g=$f; ls $g; node --version`,
  ]) assert.notEqual(sh(cmd), "pass", cmd);
});

test("state_other_session_live_still_protected", { skip: !posix }, () => {
  for (const cmd of [
    `cat ~/.pi/agent/pi-foreman/state/live/${OTHER}.json; node --version`,
    `f=~/.pi/agent/pi-foreman/state/live/${OTHER}.json; ls $f`,
    `f=~/.pi/agent/pi-foreman/state/live/${OTHER}.json; python3 -c "print(open('$f').read())"`,
    `f=~/.pi/agent/pi-foreman/state/live/${OTHER}.json; python3 -c "import json,sys; print(json.load(open(sys.argv[1])))" $f`,
    `ls ~/.pi/agent/pi-foreman/state/live/ | grep x; node --version`,
    `node -e "console.log(require('fs').readFileSync('${path.join(live, `${OTHER}.json`)}','utf8'))"`,
  ]) assert.notEqual(sh(cmd), "pass", cmd);
  // a child never gets the foreman's own state files
  const child: MatchCtx = { cwd: ws, home, platform: process.platform, role: "child" };
  assert.notEqual(checkToolCall(rules, "bash", { command: `cat ~/.pi/agent/pi-foreman/state/live/${SID}.json` }, child)?.kind ?? "pass", "pass");
});
