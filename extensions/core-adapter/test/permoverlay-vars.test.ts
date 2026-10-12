import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { MatchCtx, OverlayRules } from "../permoverlay.ts";
import { resolveVars } from "../shellvars.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(PKG)!;

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-vars-")));
const ws = path.join(w, "ws");
const wt = path.join(w, "ws.worktrees", "hf");
const home = path.join(w, "home");
const ag = path.join(home, ".pi", "agent");
const handoffs = path.join(ag, "pi-foreman", "handoffs", "s1");
const scratch = path.join(w, "tmp", "pi-foreman-scratch", "s1", "L1");
for (const d of [ws, wt, handoffs, path.join(scratch, "probe"), path.join(home, ".ssh")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(handoffs, "plan.md"), "{}\n");

const rules: OverlayRules = buildOverlayRules(baseline, {}, {}, ag, ws, undefined, false);
const world = (role: "main" | "child", extra: Partial<MatchCtx> = {}): MatchCtx => ({ cwd: wt, home, platform: process.platform, role, ...extra });
const sh = (c: MatchCtx, command: string): string => checkToolCall(rules, "bash", { command }, c)?.kind ?? "pass";
const foremanDir = path.join(ag, "pi-foreman");
const blocked = "handoffs/s1/ruling.md";
const child = world("child", { scratch });

test("a same-line assignment statement resolves a later $VAR like the literal path", () => {
  assert.equal(sh(child, `D=${scratch}/x; mkdir -p $D`), "pass");
  assert.equal(sh(child, `D=${scratch}/x && mkdir -p "$D"`), "pass");
  assert.equal(sh(child, `mkdir -p ${scratch}/x`), "pass");
  // the resolved path is what the rules see
  assert.equal(sh(child, `cat ${foremanDir}/${blocked}`), "deny");
  assert.equal(sh(child, `cat $H/${blocked}`), "pass", "unknown $H");
  assert.equal(sh(child, `H=${foremanDir}; cat $H/${blocked}`), "deny");
  assert.equal(sh(child, `H=${foremanDir}; cat \${H}/${blocked}`), "deny");
  assert.equal(sh(world("main"), `S=${home}/.ssh; cat $S/id_rsa`), "deny");
});

test("$FOREMAN_SCRATCH resolves anywhere in a word, from the harness env only", () => {
  assert.equal(sh(child, "mkdir -p $FOREMAN_SCRATCH/probe/x"), "pass");
  assert.equal(sh(child, "cat x > $FOREMAN_SCRATCH/probe/out.txt"), "pass");
  // a FOREMAN_* assignment on the line never supplies the value
  assert.equal(sh(child, `FOREMAN_SCRATCH=${foremanDir}; cat $FOREMAN_SCRATCH/${blocked}`), "pass");
});

test("a prefix assignment stays unresolved: the same decision as an unknown $D", () => {
  const unknown = sh(child, `cat $D/${blocked}`);
  assert.equal(sh(child, `D=${foremanDir} cat $D/${blocked}`), unknown);
  assert.notEqual(sh(child, `D=${foremanDir}; cat $D/${blocked}`), unknown);
});

test("the last assignment wins; unsafe or conditional forms stay unresolved", () => {
  const unknown = sh(child, `cat $D/${blocked}`);
  assert.equal(sh(child, `D=${foremanDir}; D=${scratch}; cat $D/${blocked}`), "pass");
  assert.equal(sh(child, `D=${scratch}; D=${foremanDir}; cat $D/${blocked}`), "deny");
  for (const cmd of [
    `true && D=${foremanDir}; cat $D/${blocked}`,
    `(D=${foremanDir}); cat $D/${blocked}`,
    `D=${foremanDir}; for D in a; do cat $D/${blocked}; done`,
    `D=${foremanDir}; export D=x; cat $D/${blocked}`,
    `D=${foremanDir}; read D; cat $D/${blocked}`,
    `D=handoffs; cat ${foremanDir}/$D/s1/ruling.md`,
    `D=$(pwd); cat $D/${blocked}`,
    `D="$X/y"; cat $D/${blocked}`,
  ]) assert.equal(sh(child, cmd), unknown, cmd);
});

test("resolveVars returns changed copies and leaves the parsed words alone", () => {
  const pipes = [[["A=/p/q"]], [["ls", "$A/x", "${A}", "$B"]]];
  const r = resolveVars(pipes, [";", "end"], {});
  assert.deepEqual(r.get(pipes[1][0]), ["ls", "/p/q/x", "/p/q", "$B"]);
  assert.deepEqual(pipes[1][0], ["ls", "$A/x", "${A}", "$B"]);
  assert.equal(r.size, 1);
  assert.equal(resolveVars([[["ls", "$FOREMAN_X"]]], ["end"], {}).size, 0);
  const env = [[["ls", "$FOREMAN_SCRATCH/y"]]];
  assert.deepEqual(resolveVars(env, ["end"], { FOREMAN_SCRATCH: "/e" }).get(env[0][0]), ["ls", "/e/y"]);
  // a relative value depends on a cd the line may hold
  const rel = [[["A=p/q"]], [["ls", "$A"]]];
  assert.equal(resolveVars(rel, [";", "end"], {}).size, 0);
});
