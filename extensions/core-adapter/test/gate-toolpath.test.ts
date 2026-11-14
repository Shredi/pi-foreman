// Guard round 1, step 2: the gate reads the path of a write, edit, read, ls, grep or find call the way Pi's tool does (`@`, `~`, `file://`, unicode spaces),
// through pathnorm.ts `toolPath`. Rows: toolPath against Pi's function; the child fence and the main session's verdicts for each spelling; the ruling refusal
// at its call site; deny, ask and allow rules; the shell, which keeps its own reading. Each refused spelling has an allowed one beside it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateResult } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { tmpRoots } from "../pathrules.ts";
import { toolPath, slashForm } from "../pathnorm.ts";
import { parseRule, type ParsedRule, type RuleSets } from "../rules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { resolveToCwd } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";

const platform = process.platform;
const base = fs.realpathSync(mkTestTmp("pf-toolpath-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const HOME = path.join(base, "home");
const handoff = path.join(HOME, "handoffs", "h1");
const outside = path.join(base, "outside");
const agentDir = path.join(HOME, ".pi", "agent");
for (const d of [path.join(wt, "src"), scr, handoff, outside, agentDir]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const NBSP = String.fromCodePoint(0xa0);
const url = (p: string): string => pathToFileURL(p).href;
const tilde = (p: string): string => `~/${path.relative(HOME, p).split(path.sep).join("/")}`;
const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const childRoots: GateRoots = { worktree: wt, scratch: [scr], tmp: [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: true, role: "builder", tmpAccess: false, agentDir };
const mainRoots: GateRoots = { worktree: wt, scratch: [], tmp: tmpRoots(os.tmpdir(), platform, real), owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true, agentDir };
const verdictOf = (r: GateResult): string => (r === undefined ? "none" : "block" in r ? `block:${r.rule}` : "allow" in r ? `allow:${r.rule}` : `ask:${r.rule}`);
const env = (child: boolean) => baseFloorEnv(wt, { child, home: HOME, agentDir, platform });
function gate(tool: string, input: Record<string, unknown>, o: { child?: boolean; sets?: RuleSets } = {}): string {
  const child = o.child ?? false;
  return verdictOf(
    gateEvaluate(tool, input, wt, {
      env: () => env(child),
      roots: () => (child ? childRoots : mainRoots),
      ...(o.sets ? { rules: { sets: o.sets, env: { cwd: wt, home: HOME, platform, checkout: wt } } } : {}),
    }).result,
  );
}
const w = (p: string, o?: { child?: boolean; sets?: RuleSets }): string => gate("write", { path: p, content: "x" }, o);
const rl = (t: string): ParsedRule => {
  const r = parseRule(t);
  assert.ok(r.ok, t);
  return (r as { ok: true; rule: ParsedRule }).rule;
};
const absRule = (p: string): string => `${platform === "win32" ? "//" : "/"}${slashForm(platform, p)}/**`;

// ------------------------------------------------------------------ toolPath against Pi's function

test("toolPath gives what Pi's resolveToCwd gives, and null where Pi's function throws", () => {
  const table = [
    "a/b.txt", "./x", "../x", "x/../y", path.join(outside, "x"), "~", "~/x", "~user/x", "@x", "@/tmp/x", "@~/x", "@@x", "@", "", ".",
    url(path.join(outside, "x")), `@${url(path.join(outside, "x"))}`, `file://${outside}/a%20b`, `a${NBSP}b/c`, `${outside}/a${NBSP}b`, `@${NBSP}x`, `~${NBSP}/x`,
    "file://host/x", "file:///x", "file://", "file:relative", "FILE:///x",
  ];
  for (const raw of table) {
    let pi: string | null;
    try {
      pi = resolveToCwd(raw, wt);
    } catch {
      pi = null;
    }
    // Pi reads `~` through os.homedir(): the same home for both
    const mine = toolPath(raw, wt, os.homedir(), platform);
    assert.equal(mine, pi, JSON.stringify(raw));
  }
});

test("toolPath fails closed: a malformed file:// link is null, a plain path is not", () => {
  const throws = (raw: string): boolean => {
    try {
      resolveToCwd(raw, wt);
      return false;
    } catch {
      return true;
    }
  };
  const bad = ["file://host/x", "file:///x"].find(throws);
  assert.ok(bad, "one of the spellings makes Pi's function throw on this platform");
  assert.equal(toolPath(bad as string, wt, HOME, platform), null);
  assert.notEqual(toolPath("file:///", wt, HOME, platform) === null && !throws("file:///"), true);
  assert.equal(w(bad as string), "block:tool-path-unreadable");
  assert.equal(w(path.join(wt, "src", "a.ts")), "allow:path-write-worktree");
});

test("toolPath steps: unicode spaces first, one @, then ~, then file://; the cwd is read with ~ and file:// only", () => {
  assert.equal(toolPath(`@${tilde(path.join(HOME, "x"))}`, wt, HOME, platform), path.join(HOME, "x"));
  assert.equal(toolPath("@@x", wt, HOME, platform), path.join(wt, "@x"));
  assert.equal(toolPath(`${NBSP}x`, wt, HOME, platform), path.join(wt, " x"));
  assert.equal(toolPath("~user/x", wt, HOME, platform), path.join(wt, "~user", "x"));
  assert.equal(toolPath("x", `file://${url(wt).slice(7)}`, HOME, platform), path.join(wt, "x"));
});

// ------------------------------------------------------------------ the child fence

test("a child's write spelled with @, ~ or file:// that lands outside its worktree is refused", () => {
  const o = path.join(outside, "x");
  assert.equal(w(o, { child: true }), "block:child-write-outside", "plain, the baseline");
  for (const spelled of [`@${o}`, url(o), `@${url(o)}`, "@~/x", `@${tilde(o).replace(/^~\//, "~/../")}`, `${path.join(outside, `a${NBSP}b`)}`]) assert.equal(w(spelled, { child: true }), "block:child-write-outside", spelled);
  // beside it: a path that lands inside stays allowed, in any of the spellings
  for (const spelled of ["@src/a.ts", `@${path.join(wt, "src", "a.ts")}`, url(path.join(wt, "src", "a.ts")), path.join(wt, "src", `a${NBSP}b.ts`)]) assert.equal(w(spelled, { child: true }), "allow:path-write-worktree", spelled);
});

test("a child's write to its own handoff result spelled with ~, @ or file:// is allowed, its ruling in each spelling is refused", () => {
  const res = path.join(handoff, "result.md");
  const rul = path.join(handoff, "ruling.md");
  for (const [spelled, why] of [[tilde(res), "~"], [`@${res}`, "@"], [url(res), "file://"], [`@${tilde(res)}`, "@~"]] as const) assert.equal(w(spelled, { child: true }), "allow:path-write-handoff", why);
  for (const [spelled, why] of [[rul, "plain"], [tilde(rul), "~"], [`@${rul}`, "@"], [url(rul), "file://"], [`@${tilde(rul)}`, "@~"]] as const) assert.equal(w(spelled, { child: true }), "block:child-write-outside", why);
});

// ------------------------------------------------------------------ the main session

test("main: @ and file:// spellings of an outside path get the verdict of that path, not of the worktree", () => {
  const t = path.join(mainRoots.tmp[0], "pf-toolpath-probe", "x");
  const plain = w(t);
  assert.equal(plain, "allow:path-write-tmp", "the tmp class: not the worktree rule the old reading gave");
  for (const spelled of [`@${t}`, url(t), `@${url(t)}`]) assert.equal(w(spelled), plain, spelled);
  const o = path.join(outside, "x");
  for (const spelled of [`@${o}`, url(o)]) assert.equal(w(spelled), w(o), spelled);
  assert.notEqual(w(o), "allow:path-write-worktree");
  // `@~/x` is the home path
  assert.equal(w("@~/x"), w(path.join(HOME, "x")));
  assert.notEqual(w("@~/x"), "allow:path-write-worktree");
  // beside it: inside the worktree stays allowed
  assert.equal(w("@src/a.ts"), w("src/a.ts"));
  assert.equal(w("@src/a.ts"), "allow:path-write-worktree");
});

test("main: @.git and @.pi spellings are the .git and .pi paths", () => {
  const hook = w(".git/hooks/post-checkout");
  assert.equal(w("@.git/hooks/post-checkout"), hook);
  assert.notEqual(hook, "allow:path-write-worktree");
  const settings = w(".pi/settings.json");
  assert.equal(w("@.pi/settings.json"), settings);
  assert.match(settings, /^ask:/);
  // beside it: an ordinary file next to them stays allowed
  assert.equal(w("@src/a.ts"), "allow:path-write-worktree");
});

test("main: the Pi agent files and ~/.ssh in @, ~ and file:// spellings get the verdict of the plain path", () => {
  const auth = path.join(agentDir, "auth.json");
  for (const spelled of [`@${tilde(auth)}`, url(auth), `@${auth}`]) assert.equal(w(spelled), w(auth), spelled);
  const key = path.join(HOME, ".ssh", "id_rsa");
  assert.equal(w(key), "block:floor-secret-path");
  for (const spelled of [tilde(key), `@${tilde(key)}`, url(key), `@${key}`]) assert.equal(w(spelled), "block:floor-secret-path", spelled);
  assert.notEqual(w("@src/a.ts"), "block:floor-secret-path");
});

// ------------------------------------------------------------------ rules

test("a deny rule on an absolute path refuses the @ and file:// spellings, and a deny rule in the raw spelling still refuses", () => {
  const o = path.join(outside, "a");
  const sets: RuleSets = { allow: [], ask: [], deny: [rl(`Write(${absRule(outside)})`)] };
  assert.match(w(o, { sets }), /^block:rule /, "plain");
  for (const spelled of [`@${o}`, url(o)]) assert.match(w(spelled, { sets }), /^block:rule /, spelled);
  assert.doesNotMatch(w("src/a.ts", { sets }), /^block:/, "beside it: another path");
  const raw: RuleSets = { allow: [], ask: [], deny: [rl("Write(@notes/**)")] };
  assert.match(w("@notes/a", { sets: raw }), /^block:rule /, "the raw spelling");
  assert.doesNotMatch(w("notes2/a", { sets: raw }), /^block:/);
  const ask: RuleSets = { allow: [], ask: [rl(`Write(${absRule(outside)})`)], deny: [] };
  assert.match(w(`@${o}`, { sets: ask }), /^ask:rule /, "an ask rule too");
});

test("an allow rule for a worktree path does not allow @/outside; an allow rule for an outside path allows its @ spelling as it allows the plain one", () => {
  const o = path.join(outside, "a");
  const inWt: RuleSets = { allow: [rl(`Write(${absRule(wt)})`)], ask: [], deny: [] };
  // the OS temp dir is a built-in allow for the main session, so the rule's own allow is what is told apart
  assert.match(w("src/a.ts", { sets: inWt }), /^allow:Write\(/, "the rule works for its own path");
  assert.doesNotMatch(w(`@${o}`, { sets: inWt }), /^allow:Write\(/);
  assert.doesNotMatch(w(url(o), { sets: inWt }), /^allow:Write\(/);
  const out: RuleSets = { allow: [rl(`Write(${absRule(outside)})`)], ask: [], deny: [] };
  assert.match(w(o, { sets: out }), /^allow:Write\(/, "plain");
  for (const spelled of [`@${o}`, url(o)]) assert.equal(w(spelled, { sets: out }), w(o, { sets: out }), spelled);
});

// ------------------------------------------------------------------ the shell keeps its own reading

test("shell words are untouched: @ and file:// are literal names there", () => {
  const sh = (command: string, child = false): string => gate("bash", { command }, { child });
  // the verdicts of the base commit: both are plain names under the cwd, judged as the same names without the prefix
  assert.equal(sh("echo x > @f"), sh("echo x > f"));
  assert.equal(sh("echo x > @f", true), sh("echo x > f", true));
  assert.ok(!sh("echo x > @f", true).startsWith("block:"), "a name inside the worktree, not a refusal");
  assert.equal(sh("cat file://x"), sh("cat x"));
  assert.equal(sh("cat file://x", true), "allow:default-read");
  // beside it: a redirect outside the worktree is still not a default allow
  assert.notEqual(sh(`echo x > ${outside}/f`, true), "allow:default-write-in");
});

// ------------------------------------------------------------------ known limits (ruled out for this round)

test("known limit: a .. spelling of the handoff dir resolves lexically, a link to it is judged on its real path, the read tool's extra variants are not read", () => {
  // `..` is resolved by toolPath as Pi resolves it: the same file as the plain spelling
  assert.equal(w(`${handoff}/sub/../result.md`, { child: true }), "allow:path-write-handoff");
  // a link to the handoff dir: the verdicts of today, pinned (the link is not followed by toolPath, the path rules read the real path)
  const link = path.join(base, "handoff-link");
  fs.symlinkSync(handoff, link, "junction");
  assert.equal(w(path.join(link, "ruling.md"), { child: true }), "block:child-write-outside");
  // open: its result.md through the link is refused although it is the allowed file (a false block, not a hole)
  assert.equal(w(path.join(link, "result.md"), { child: true }), "block:child-write-outside");
  // the read tool also tries NFD, curly-quote and AM/PM variants of a missing name; toolPath is the first step only
  assert.equal(toolPath("café.txt", wt, HOME, platform), path.join(wt, "café.txt"));
});

// ------------------------------------------------------------------ the ruling refusal at its call site

test("a parent-ruling path spelled with ~, @ or file:// is refused like the plain one; a non-ruling file in those spellings is not", async (t) => {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // inTmp: the gate (which runs before this refusal) asks for a write outside the worktree under the home directory, where Linux CI keeps the default base
  const c = await r11Rig(t, {}, { inTmp: true });
  // `~` is the rig's temp root for this test, so the spelling reaches the handoff dir
  const rigHome = path.dirname(c.agentDir);
  process.env.HOME = rigHome;
  process.env.USERPROFILE = rigHome;
  t.after(() => {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const dir = c.handoff("h-ruling", "child");
  const rel = (f: string): string => `~/${path.relative(rigHome, path.join(dir, f)).split(path.sep).join("/")}`;
  const refusedBySelfRuling = async (p: string): Promise<boolean> => /parent's ruling/.test(String((await c.call("write", { path: p, content: "x" }))?.reason));
  const ruling = path.join(dir, "ruling.md");
  for (const spelled of [ruling, rel("ruling.md"), `@${ruling}`, url(ruling), `@${rel("ruling.md")}`]) assert.ok(await refusedBySelfRuling(spelled), spelled);
  const other = path.join(dir, "notes.md");
  for (const spelled of [other, rel("notes.md"), `@${other}`, url(other)]) assert.ok(!(await refusedBySelfRuling(spelled)), spelled);
});

test("a secret path is a floor deny in every spelling, and the denial names the path as it was written (the repeat stop counts equal sentences)", () => {
  const deny = (p: string): { block?: boolean; reason?: string } | undefined => gateEvaluate("read", { path: p }, wt, { env: () => env(true), roots: () => childRoots }).result as { block?: boolean; reason?: string } | undefined;
  const key = "~/.ssh/id_rsa";
  assert.ok(deny(key)?.block);
  assert.ok(String(deny(key)?.reason).includes(`'${key}'`), String(deny(key)?.reason));
  for (const spelled of [`@${key}`, url(path.join(HOME, ".ssh", "id_rsa"))]) assert.ok(deny(spelled)?.block, spelled);
  // beside it: a plain file in the same spellings is no floor deny
  for (const spelled of ["~/notes.txt", "@~/notes.txt", url(path.join(HOME, "notes.txt"))]) assert.ok(!deny(spelled)?.block || !/permission floor/.test(String(deny(spelled)?.reason)), spelled);
});
