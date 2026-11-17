// Guard round 2, step 3b: the label `danger-readonly-run` for a reviewer or explorer (`roots.roundReadOnly`), the role question that may clear it, and the modes.
// Part 1: which segment of a read-only role's line is free and which is labelled (gateEvaluate; a builder and the main session never get the label).
// Part 2: the role question on the classifier (five yes/no/unsure answers; only five no clear; the cache; no model call when the switch is off).
// Part 3: one adapter session of an explorer: the modes, gate.childAsk, a headless session, and an allow sentence that does not clear the label.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inprocSpawner } from "./_read-clear-inproc.ts"; // first: the git answers are in place before the adapter loads
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { Classifier, parseRoleVerdict, roleRequestText, roleSystemPrompt } from "../classifier.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { gateLogFile } from "../gatelog.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const LABEL = "danger-readonly-run";
const fwd = (p: string): string => p.replace(/\\/g, "/");
const base = fs.realpathSync(mkTestTmp("pf-ro3b-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const clone = path.join(scr, "c");
const handoff = path.join(base, "handoffs", "h1");
for (const d of [path.join(wt, "src"), clone, handoff]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
fs.writeFileSync(path.join(wt, "Makefile"), "test:\n\techo t\n");
fs.writeFileSync(path.join(wt, "a.txt"), "x\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));
const W = fwd(wt);
const S = fwd(scr);
const C = fwd(clone);
const H = fwd(handoff);

type Kind = "ro" | "child" | "main";
const roots = (role: string, kind: Kind): GateRoots => ({ worktree: wt, scratch: [scr], tmp: kind === "main" ? [base, "/tmp"] : [], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], childHandoff: handoff, child: kind !== "main", role, tmpAccess: kind === "main", ...(kind === "ro" ? { roundReadOnly: true } : {}) });
const outcome = (line: string, role: string, kind: Kind) => gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, kind === "main" ? {} : { child: true }), roots: () => roots(role, kind) });
const labelled = (line: string, role: string, kind: Kind): boolean => (outcome(line, role, kind).dangers ?? []).includes(LABEL);
const ROLES = ["reviewer", "explorer"];

/** Every line gets the label for both read-only roles and never for a builder or the main session. */
function mustLabel(lines: string[]): void {
  for (const line of lines) {
    for (const role of ROLES) assert.ok(labelled(line, role, "ro"), `${role}: ${line} -> ${JSON.stringify(outcome(line, role, "ro"))}`);
    assert.ok(!labelled(line, "builder", "child"), `builder: ${line}`);
    assert.ok(!labelled(line, "foreman", "main"), `main: ${line}`);
  }
}
/** Every line stays free of the label for both read-only roles. */
function mustFree(lines: string[]): void {
  for (const line of lines) for (const role of ROLES) assert.ok(!labelled(line, role, "ro"), `${role}: ${line} -> ${JSON.stringify(outcome(line, role, "ro"))}`);
}

test("rule 1: a read, a declared test run, a fetch and a git read stay free", () => {
  mustFree(["ls", "cat a.txt | head -5", "grep -rn foo src", "npm test", "make test", "git status", "git log --oneline -5", "git diff HEAD~1", `git -C ${W} log`, "git --no-pager log", "git fetch origin", "git stash list", "git tag -l", "git config --get user.name", "ls 2>/dev/null | head", `ls > ${S}/ls.txt`]);
});

test("rule 2: a write whose every target is named and inside scratch or the handoff dir stays free; a git segment in a scratch repository is free whatever the subcommand", () => {
  mustFree([`echo x > ${S}/f`, `echo x >> ${S}/f`, `echo x > $FOREMAN_SCRATCH/f`, `echo x > ${H}/result.md`, `touch ${S}/f`, `cp a.txt ${S}/b`]);
  mustFree([`git -C ${C} commit -m x`, `git -C ${C} grep foo`, `git -C ${C} cat-file -p HEAD`, `git -C ${C} checkout -b x`, `git -C ${C} symbolic-ref HEAD`, `cd ${C} && git status`, `cd ${C} && git commit -m x`]);
});

test("rule 4: every other segment gets the label (an unknown program, a script, inline code, an unknown git form, a build run no rule accepts, code from a writable folder)", () => {
  mustLabel(["echo hello", "pwd", "sort a.txt", "chmod +x a.txt", "bsdtar -xf a.tar", "gfind . -name x", "foo --bar", "bash x.sh", "./x.sh", "python3 x.py", "bash -c 'ls'", "python3 -c 'print(1)'", "node -e 'console.log(1)'", "env ls", "FOO=1 ls", "FOO=1 npm test", "make", "make foo", "npm run foo", "cargo build", "pnpm test", "node src/a.ts"]);
  mustLabel(["git grep foo", "git cat-file -p HEAD", "git shortlog -sn", "git symbolic-ref HEAD", "git replace -l", "git archive HEAD", "git bundle list-heads x", "git -c k=v log", "GIT_TRACE=1 git log", "git ls-files -o", "git grep -o foo", "git log -o"]);
  // `git format-patch -1` writes patch files into the worktree cwd: refused for the read-only roles (r2-readonly-git-output.test.ts), never labelled for a builder or main
  for (const role of ROLES) assert.equal((outcome("git format-patch -1", role, "ro").result as { rule?: string } | undefined)?.rule, "child-readonly-write", role);
  assert.ok(!labelled("git format-patch -1", "builder", "child"));
  assert.ok(!labelled("git format-patch -1", "foreman", "main"));
  mustLabel([`node ${S}/probe.mts`, `node --test ${S}/x.test.mjs`, `bash ${S}/x.sh`, `${S}/x.sh`, `python3 ${S}/x.py > ${S}/out`, `cd ${S} && ./x.sh`, `make -C ${S} test`, `cd ${S} && npm test`]);
  mustLabel([`git -C ${C} -c k=v log`, `git -C ${C} log -o`, `git -C ${C} archive -o x.tar HEAD`, `git -C ${C} grep -o foo`, `GIT_DIR=x git -C ${C} log`, `git --git-dir=${W}/.git status`]);
  // one labelled segment labels the line
  mustLabel(["ls && echo hello", "git status; git grep foo", `echo x > ${S}/f; sort a.txt`]);
});

test("a write into the worktree is still the step 3a refusal, not this label", () => {
  for (const line of ["touch f", "echo x > f", "git commit -m x", "cp a.txt b.txt"]) for (const role of ROLES) {
    const v = outcome(line, role, "ro").result as { block?: boolean; rule?: string } | undefined;
    assert.equal(v?.rule, "child-readonly-write", `${role}: ${line}`);
  }
});

// ---------------------------------------------------------------- the role question

const NO = { changesProject: "no", writesOutside: "no", installsOrPublishes: "no", networkWrite: "no", readsSecretOrOutside: "no" };
const ans = (o: Record<string, string> = {}): string => JSON.stringify({ ...NO, ...o });

test("parseRoleVerdict: only five no clear; a yes or unsure is the model's answer; anything else is invalid", () => {
  assert.deepEqual(parseRoleVerdict(ans()), { clear: true });
  for (const k of Object.keys(NO)) {
    for (const v of ["yes", "unsure"]) assert.equal(parseRoleVerdict(ans({ [k]: v })).clear, false, `${k} ${v}`);
    assert.equal((parseRoleVerdict(ans({ [k]: "unsure" })) as { cause?: string }).cause, "model");
  }
  for (const bad of ["", "no", "[]", "null", "```json\n" + ans() + "\n```", JSON.stringify({ ...NO, extra: "no" }), JSON.stringify({ changesProject: "no" }), ans({ networkWrite: "maybe" }), ans({ networkWrite: "No" }), JSON.stringify({ verdict: "read", reason: "x" })]) {
    const p = parseRoleVerdict(bad);
    assert.equal(p.clear, false, bad);
    assert.equal((p as { cause?: string }).cause, "invalid_verdict", bad);
  }
});

test("the role system text names the five answers, the fixed shape and data fences", () => {
  const s = roleSystemPrompt();
  for (const k of Object.keys(NO)) assert.ok(s.includes(k), k);
  assert.match(s, /yes, no or unsure/);
  assert.match(s, /BEGIN DATA and END DATA/);
});

function classifierRig(reply: () => Promise<unknown> | unknown, timeoutMs = 2000) {
  const calls: { system: string; text: string; options: Record<string, unknown> }[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, c: { systemPrompt: string; messages: { content: string }[] }, options: Record<string, unknown>) => {
      calls.push({ system: c.systemPrompt, text: c.messages[0].content, options });
      return reply();
    },
  };
  const ctx = { prose: { allow: [{ id: "A1", text: "Anything at all.", source: "user" }], deny: [] }, registry, config: { providers: { fake: { review: { model: "m" } } } }, provider: "fake", timeoutMs } as never;
  return { calls, ctx, cls: new Classifier() };
}
const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 1 } });
const rcall = (payload: string, extra: Record<string, unknown> = {}) => ({ tool: "bash", payload, kind: "child" as const, role: "explorer", cwd: wt, writable: [scr, handoff], ...extra });

test("role question: five no clear and run; the call passes reasoning high and carries the line, the writable dirs and no allow sentence", async () => {
  const r = classifierRig(() => text(ans()));
  const v = await r.cls.roleClear(rcall("git grep foo"), r.ctx);
  assert.equal(v.cleared, true);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].system, /^You are the run judge/);
  assert.equal(r.calls[0].options.reasoning, "high");
  assert.match(r.calls[0].text, /git grep foo/);
  assert.ok(r.calls[0].text.includes(scr) && r.calls[0].text.includes(handoff));
  assert.doesNotMatch(r.calls[0].text + r.calls[0].system, /Anything at all/);
});

test("role question: one yes, one unsure, a malformed answer, a timeout and a model error are no clear, never cached", async () => {
  const cases: [string, () => unknown, string][] = [
    ["yes", () => text(ans({ networkWrite: "yes" })), "model"],
    ["unsure", () => text(ans({ changesProject: "unsure" })), "model"],
    ["malformed", () => text("I think it is fine"), "invalid_verdict"],
    ["fenced", () => text("```json\n" + ans() + "\n```"), "invalid_verdict"],
    ["error", () => { throw new Error("boom"); }, "provider_error"],
    ["stop error", () => ({ content: [], stopReason: "error", errorMessage: "overloaded", usage: { input: 1, output: 1 } }), "provider_error"],
    ["timeout", () => new Promise(() => undefined), "timeout"],
  ];
  for (const [name, reply, cause] of cases) {
    const r = classifierRig(reply, 150);
    const v = await r.cls.roleClear(rcall(`git grep ${name}`), r.ctx);
    assert.equal(v.cleared, false, name);
    assert.equal((v as { cause?: string }).cause, cause, name);
    // not cached: the same line asks again
    await r.cls.roleClear(rcall(`git grep ${name}`), r.ctx);
    assert.equal(r.calls.length, 2, name);
  }
});

test("role question: a clear is cached (no model call the second time); another line, role, cwd or kind is no hit; clearCache empties it", async () => {
  const r = classifierRig(() => text(ans()));
  assert.equal((await r.cls.roleClear(rcall("git grep foo"), r.ctx)).cleared, true);
  const again = await r.cls.roleClear(rcall("git grep foo"), r.ctx);
  assert.deepEqual([again.cleared, (again as { cached?: boolean }).cached], [true, true]);
  assert.equal(r.calls.length, 1);
  for (const o of [{ role: "reviewer" }, { cwd: base }, { kind: "owner" }]) await r.cls.roleClear(rcall("git grep foo", o), r.ctx);
  await r.cls.roleClear(rcall("git grep bar"), r.ctx);
  assert.equal(r.calls.length, 5);
  r.cls.clearCache();
  await r.cls.roleClear(rcall("git grep foo"), r.ctx);
  assert.equal(r.calls.length, 6);
});

test("role question: its cache is not the read question's (own key space)", async () => {
  const r = classifierRig(() => text(ans()));
  await r.cls.roleClear(rcall("git grep foo"), r.ctx);
  const read = await r.cls.readClear({ tool: "bash", payload: "git grep foo", kind: "child", role: "explorer", cwd: wt, inside: [wt], notes: [] }, r.ctx);
  assert.equal(read.cleared, false, "an answer of the role shape is no read clear");
  assert.equal(r.calls.length, 2);
});

// ---------------------------------------------------------------- the gate: modes, child asks, headless

const LINE = "git grep foo";

async function rig(t: Parameters<typeof r11Rig>[0], o: { mode?: string; gate?: Record<string, unknown>; headless?: boolean; sentences?: string[]; reply?: () => unknown; noAskDir?: boolean; scratch?: string } = {}) {
  const prev = process.env[BINDINGS_ENV];
  const askDir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-ask-"));
  const binding = { foremanSession: "parent-s", workspace: "", role: "explorer", launchId: "L1", kind: "first", model: null, ...(o.scratch ? { scratch: o.scratch } : {}), ...(o.noAskDir ? {} : { askDir }) };
  if (o.headless) delete process.env[BINDINGS_ENV];
  else process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: binding });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
    fs.rmSync(askDir, { recursive: true, force: true });
  });
  const prompts: string[] = [];
  const registry = {
    find: () => ({ id: "small" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: unknown, c: { systemPrompt: string }) => {
      prompts.push(c.systemPrompt);
      if (/^You are the run judge/.test(c.systemPrompt)) return o.reply ? o.reply() : text(ans());
      return text(JSON.stringify({ verdict: "allow", entry: "A1", reason: "covered" }));
    },
  };
  const perms = { ...(o.mode ? { mode: o.mode } : {}), classifier: { allow: o.sentences ?? ["Anything at all."] } };
  const r = await r11Rig(t, {}, {
    child: !o.headless,
    deps: { spawner: inprocSpawner },
    ctx: { hasUI: false, mode: "json", modelRegistry: registry, [RIG_PERMISSIONS]: perms },
    config: { gate: { reviewTimeoutMs: 300, ...(o.gate ?? {}) }, providers: { fake: { review: { model: "small" }, roles: { explorer: { model: "fake/explorer" } } } } },
  });
  if (!o.headless) {
    // the explorer reads its round worktree and has no write root on it (roundsurface.ts childSurface)
    const dir = path.join(r.agentDir, "pi-foreman", "state", "sessions", "parent-s");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ entries: [{ path: r.project, kind: "worktree" }] }));
    await r.restart();
  }
  return { ...r, prompts, askDir };
}
/** The call, with the parent's ruling given when an ask.md shows up: `asked` says whether the parent was asked. */
async function viaParent(r: Awaited<ReturnType<typeof rig>>, line: string): Promise<{ asked: boolean; res: { block?: boolean; reason?: string } | undefined }> {
  const p = r.call("bash", { command: line });
  let asked = false;
  const ask = path.join(r.askDir, "ask.md");
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(ask)) {
      asked = true;
      fs.writeFileSync(path.join(r.askDir, "ruling-1.md"), "DENY\nno\n");
      break;
    }
    const settled = await Promise.race([p.then(() => true), new Promise<boolean>((res) => setTimeout(() => res(false), 10))]);
    if (settled) break;
  }
  return { asked, res: (await p) as { block?: boolean; reason?: string } | undefined };
}
const roleCalls = (r: { prompts: string[] }): number => r.prompts.filter((p) => /^You are the run judge/.test(p)).length;

test("gate, mode auto: five no clear and run; the allow-sentence classifier is never asked", async (t) => {
  const r = await rig(t);
  const v = await viaParent(r, LINE);
  assert.deepEqual([v.asked, v.res], [false, undefined]);
  assert.equal(r.prompts.length, 1);
  assert.equal(roleCalls(r), 1);
  const rows = fs.readFileSync(gateLogFile(r.agentDir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(rows.some((x) => x.rule === "readonly-run" && x.verdict === "allow"), JSON.stringify(rows));
});

test("gate, mode auto: an owner sentence \"Anything at all.\" does not clear the label: a non-clear asks the parent, the sentence judge is not called", async (t) => {
  const r = await rig(t, { reply: () => text(ans({ writesOutside: "unsure" })) });
  const v = await viaParent(r, LINE);
  assert.equal(v.asked, true);
  assert.equal(v.res?.block, true);
  assert.match(v.res?.reason ?? "", /denied by the parent/);
  assert.equal(roleCalls(r), 1);
  assert.equal(r.prompts.length, 1, "no allow-sentence classifier call");
});

test("gate, mode auto: one yes, one unsure, a malformed answer, a model error and a timeout each ask the parent; none denies by the judge", async (t) => {
  const cases: [string, () => unknown][] = [
    ["yes", () => text(ans({ installsOrPublishes: "yes" }))],
    ["unsure", () => text(ans({ networkWrite: "unsure" }))],
    ["malformed", () => text("fine")],
    ["error", () => { throw new Error("boom"); }],
    ["timeout", () => new Promise(() => undefined)],
  ];
  for (const [name, reply] of cases) {
    const r = await rig(t, { reply, gate: { reviewTimeoutMs: 150 } });
    const v = await viaParent(r, LINE);
    assert.equal(v.asked, true, name);
    assert.match(v.res?.reason ?? "", /denied by the parent/, name);
  }
});

test("gate: a clear is cached, so the same line the second time asks no model", async (t) => {
  const r = await rig(t);
  assert.equal((await viaParent(r, LINE)).res, undefined);
  assert.equal((await viaParent(r, LINE)).res, undefined);
  assert.equal(roleCalls(r), 1);
});

test("gate: gate.readonlyClear false asks the parent with no model call (the string \"false\" counts as off)", async (t) => {
  for (const off of [false, "false"]) {
    const r = await rig(t, { gate: { readonlyClear: off } });
    const v = await viaParent(r, LINE);
    assert.equal(v.asked, true, String(off));
    assert.equal(r.prompts.length, 0, String(off));
  }
});

test("gate, mode ask: the parent is asked with no model call; mode deny refuses without a model call", async (t) => {
  const a = await rig(t, { mode: "ask" });
  const va = await viaParent(a, LINE);
  assert.equal(va.asked, true);
  assert.equal(a.prompts.length, 0);
  const d = await rig(t, { mode: "deny" });
  const vd = await viaParent(d, LINE);
  assert.equal(vd.asked, false);
  assert.equal(vd.res?.block, true);
  assert.match(vd.res?.reason ?? "", /permissions mode is deny/);
  assert.equal(d.prompts.length, 0);
});

test("gate, mode allow: the label is still judged: five no run, a non-clear asks the parent; no sentence judge", async (t) => {
  const ok = await rig(t, { mode: "allow" });
  assert.equal((await viaParent(ok, LINE)).res, undefined);
  assert.equal(roleCalls(ok), 1);
  assert.equal(ok.prompts.length, 1);
  const no = await rig(t, { mode: "allow", reply: () => text(ans({ changesProject: "yes" })) });
  const v = await viaParent(no, LINE);
  assert.equal(v.asked, true);
  assert.equal(no.prompts.length, 1);
});

test("gate: gate.childAsk deny and a headless session deny what the role question does not clear; a clear still runs", async (t) => {
  const off = await rig(t, { gate: { childAsk: "deny" }, reply: () => text(ans({ changesProject: "unsure" })) });
  const r1 = (await off.call("bash", { command: LINE })) as { block?: boolean; reason?: string } | undefined;
  assert.equal(r1?.block, true);
  assert.match(r1?.reason ?? "", /child asks are off/);
  assert.equal(fs.existsSync(path.join(off.askDir, "ask.md")), false);
  // a read-only role is always a child; "headless" is a child with nobody at its parent's pane (no ask dir)
  const head = await rig(t, { noAskDir: true, reply: () => text(ans({ changesProject: "unsure" })) });
  const r2 = (await head.call("bash", { command: LINE })) as { block?: boolean; reason?: string } | undefined;
  assert.equal(r2?.block, true);
  assert.match(r2?.reason ?? "", /nobody is at this session/);
});

// ---------------------------------------------------------------- revision: other labels, rule 2, unparsable lines, duplicate keys

test("rule 2 is free only for a known writer or a plain reader whose redirect writes: a redirect into scratch frees no script, inline code, unknown program or wrapper", () => {
  mustLabel([
    `bash ${S}/x.sh > ${S}/o`, `${S}/x.sh > ${S}/o`, `sh x.sh > ${S}/o`, `chmod +x a.txt > ${S}/o`, `env bash -c 'x' > ${S}/o`, `timeout 5 bash -c 'x' > ${S}/o`,
    `node -e 'x' > ${S}/o`, `python3 -c 'x' > ${S}/o`, `ruby x.rb > ${S}/o`, `foo --bar > ${S}/o`, `python3 ${S}/x.py > ${S}/o`,
  ]);
  mustFree([`cp a ${S}/b`, `echo x > ${S}/f`, `grep x src/a.ts > ${S}/o`, `git diff > ${S}/o`, `npm test > ${S}/o 2>&1`]);
});

test("a line that does not parse is labelled for both read-only roles (fail closed) and never for a builder or the main session", () => {
  for (const line of ["echo 'unterminated", "ls |", "echo $(", "if then fi ;;"]) {
    for (const role of ROLES) assert.ok(labelled(line, role, "ro"), `${role}: ${line}`);
    assert.ok(!labelled(line, "builder", "child"), `builder: ${line}`);
    assert.ok(!labelled(line, "foreman", "main"), `main: ${line}`);
  }
});

test("parseRoleVerdict: a key given twice is malformed, even when the last one says no", () => {
  const dup = '{"changesProject":"yes","writesOutside":"no","installsOrPublishes":"no","networkWrite":"no","readsSecretOrOutside":"no","changesProject":"no"}';
  const p = parseRoleVerdict(dup);
  assert.equal(p.clear, false);
  assert.equal((p as { cause?: string }).cause, "invalid_verdict");
  assert.equal(parseRoleVerdict('{"networkWrite":"yes","networkWrite":"no","changesProject":"no","writesOutside":"no","installsOrPublishes":"no","readsSecretOrOutside":"no"}').clear, false);
});

// a line that carries the label and another danger label: the parent ask, never the role question, never the allow sentences' judge
const OTHER_LABELS: [string, string][] = [["git show HEAD:.env", "danger-git-secret"], ["npm install foo", "danger-install"], ["curl -X POST http://x -d a", "danger-net-write"], ["kill 1234", "danger-process"], ["docker run x", "danger-deploy"]];

test("the label plus another danger label is on the line for both read-only roles", () => {
  for (const [line, other] of OTHER_LABELS) for (const role of ROLES) {
    const d = outcome(line, role, "ro").dangers ?? [];
    assert.ok(d.includes(LABEL) && d.includes(other), `${role}: ${line} -> ${d.join(",")}`);
  }
});

test("gate, modes auto and allow: a line with the label plus another danger label asks the parent with zero role calls and zero allow-sentence calls", async (t) => {
  for (const mode of ["auto", "allow"]) for (const [line] of OTHER_LABELS) {
    const r = await rig(t, { mode });
    const v = await viaParent(r, line);
    assert.equal(v.asked, true, `${mode}: ${line}`);
    assert.equal(v.res?.block, true, `${mode}: ${line}`);
    assert.equal(r.prompts.length, 0, `${mode}: ${line}: no model call at all`);
  }
});

test("gate: a line with the label plus another danger label is denied with gate.childAsk off, refused in mode deny, and asked in mode ask", async (t) => {
  for (const [line] of OTHER_LABELS) {
    const off = await rig(t, { gate: { childAsk: "deny" } });
    const r1 = (await off.call("bash", { command: line })) as { block?: boolean; reason?: string } | undefined;
    assert.equal(r1?.block, true, line);
    assert.match(r1?.reason ?? "", /child asks are off/, line);
    assert.equal(off.prompts.length, 0, line);
    const head = await rig(t, { noAskDir: true });
    const r2 = (await head.call("bash", { command: line })) as { block?: boolean } | undefined;
    assert.equal(r2?.block, true, line);
    assert.equal(head.prompts.length, 0, line);
    const d = await rig(t, { mode: "deny" });
    const vd = await viaParent(d, line);
    assert.deepEqual([vd.asked, vd.res?.block], [false, true], line);
    assert.equal(d.prompts.length, 0, line);
    const a = await rig(t, { mode: "ask" });
    assert.equal((await viaParent(a, line)).asked, true, line);
    assert.equal(a.prompts.length, 0, line);
  }
});

test("gate, mode auto: the label plus danger-opaque is asked the role question (five no run)", async (t) => {
  const r = await rig(t);
  const v = await viaParent(r, "cat a.txt | sh");
  assert.deepEqual([v.asked, v.res], [false, undefined]);
  assert.equal(roleCalls(r), 1);
  assert.equal(r.prompts.length, 1);
});

// ---------------------------------------------------------------- second revision: the secret read behind the opaque label, rule 2 options, escaped duplicate keys

const SECRET_LINES = ["F=~/.ssh/id_rsa; cat $F", "for f in ~/.ssh/*; do cat $f; done"];

test("gate, modes auto and allow: a secret read behind a variable or glob is refused by the entry check: the parent is asked with zero model calls, whatever the judge would say", async (t) => {
  for (const mode of ["auto", "allow"]) for (const line of SECRET_LINES) {
    const r = await rig(t, { mode });
    const v = await viaParent(r, line);
    assert.equal(v.asked, true, `${mode}: ${line}`);
    assert.equal(v.res?.block, true, `${mode}: ${line}`);
    assert.equal(r.prompts.length, 0, `${mode}: ${line}: no model call`);
  }
});

test("gate, mode auto: `cat a.txt | sh` does not clear when the judge answers truthfully (readsSecretOrOutside or another answer unsure): the parent is asked", async (t) => {
  for (const reply of [text(ans({ readsSecretOrOutside: "unsure" })), text(ans({ readsSecretOrOutside: "yes" })), text(ans({ changesProject: "unsure" }))]) {
    const r = await rig(t, { reply: () => reply });
    const v = await viaParent(r, "cat a.txt | sh");
    assert.equal(v.asked, true);
    assert.equal(roleCalls(r), 1);
  }
});

test("gate, mode auto: an outside read behind the opaque label (a fake judge answering readsSecretOrOutside yes or unsure) asks the parent; five no clear", async (t) => {
  for (const v of ["yes", "unsure"]) {
    const r = await rig(t, { reply: () => text(ans({ readsSecretOrOutside: v })) });
    assert.equal((await viaParent(r, LINE)).asked, true, v);
  }
  const ok = await rig(t);
  assert.equal((await viaParent(ok, LINE)).res, undefined);
});

test("parseRoleVerdict: four of the five answers without readsSecretOrOutside is malformed, readsSecretOrOutside unsure or yes is the model's answer, and the fifth key is in the system text and the request lists the inside folders", () => {
  const { readsSecretOrOutside: _drop, ...four } = NO;
  const p = parseRoleVerdict(JSON.stringify(four));
  assert.equal(p.clear, false);
  assert.equal((p as { cause?: string }).cause, "invalid_verdict");
  for (const v of ["unsure", "yes"]) assert.equal((parseRoleVerdict(ans({ readsSecretOrOutside: v })) as { cause?: string }).cause, "model");
  assert.match(roleSystemPrompt(), /readsSecretOrOutside/);
  assert.match(roleRequestText({ tool: "bash", payload: "ls", kind: "child", role: "explorer", cwd: wt, writable: [scr], inside: [wt, "/some/inside/dir"] }), /some\/inside\/dir/);
});

test("parseRoleVerdict: a duplicate key spelled with an escape is the same key and is malformed", () => {
  const esc = '{"changesProject":"yes","writesOutside":"no","installsOrPublishes":"no","networkWrite":"no","readsSecretOrOutside":"no","changes\\u0050roject":"no"}';
  const p = parseRoleVerdict(esc);
  assert.equal(p.clear, false);
  assert.equal((p as { cause?: string }).cause, "invalid_verdict");
  // a value that contains key-like text and braces does not confuse the scan
  assert.deepEqual(parseRoleVerdict('{"changesProject":"no","writesOutside":"no","installsOrPublishes":"no","networkWrite":"no","readsSecretOrOutside":"no"}'), { clear: true });
});

test("rule 2: a reader whose option runs code stays labelled once a scratch redirect or -o is added; a plain reader with no option word and a rule-1 form with usual options stay free", () => {
  mustLabel([`rg --pre ./x foo > ${S}/o`, `sort --compress-program=${S}/x -o ${S}/o a.txt`, `sort -u a.txt > ${S}/o`, `jq -r .a a.txt > ${S}/o`, `sort -o ${S}/s.txt a.txt`]);
  mustFree([
    `echo x > ${S}/f`, `printf '%s' x > ${S}/f`, `cat > ${S}/n.md <<'EOF'\nhello\nEOF`, `grep -n x a.txt > ${S}/o`, `grep -rn x src > ${S}/o`, `sort a.txt > ${S}/o`, `jq . a.txt > ${S}/o`,
    `wc -l a.txt > ${S}/o`, `head -5 a.txt > ${S}/o`, `diff -u a.txt b > ${S}/o`, `git diff --stat > ${S}/o`, `npm test > ${S}/o 2>&1`, `ls -la > ${S}/o`, `find . -name x > ${S}/o`,
    `sed -n 1,5p a.txt > ${S}/o`, `cut -d: -f1 a.txt > ${S}/o`, `tr a b < a.txt > ${S}/o`,
  ]);
});

// ---------------------------------------------------------------- third revision: a redirect into the scratch dir reaches the role question

const gateScratch = (): string => {
  const d = path.join(fs.realpathSync(os.tmpdir()), `ro-scr-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test("gate, modes auto and allow: a labelled line with a redirect into the scratch dir (or 2>&1, | head, > /dev/null) reaches the role question and runs on five no", async (t) => {
  const sd = gateScratch();
  t.after(() => fs.rmSync(sd, { recursive: true, force: true }));
  const s = fwd(sd);
  const lines = [`node ${s}/probe.mts > ${s}/out.txt 2>&1`, `python3 ${s}/x.py > ${s}/o`, `npm run typecheck > ${s}/o 2>&1`, `git grep foo > ${s}/o`, `cat a > ${s}/o; ${s}/o`, `node ${s}/x.mjs 2>&1 | head`, `node ${s}/x.mjs > /dev/null`];
  for (const mode of ["auto", "allow"]) for (const line of lines) {
    const r = await rig(t, { mode, scratch: sd });
    const v = await viaParent(r, line);
    assert.deepEqual([v.asked, v.res], [false, undefined], `${mode}: ${line}`);
    assert.equal(roleCalls(r), 1, `${mode}: ${line}`);
  }
});

test("gate, mode auto: a redirect the gate cannot resolve or that lands elsewhere, and a secret-path word with a scratch redirect, still ask the parent with zero model calls", async (t) => {
  const sd = gateScratch();
  t.after(() => fs.rmSync(sd, { recursive: true, force: true }));
  const s = fwd(sd);
  for (const line of [`F=~/.ssh/id_rsa; cat $F > ${s}/o`, `cat ~/.ssh/id_rsa > ${s}/o`, `node ${s}/x.mjs > $UNKNOWN/o`, `node ${s}/x.mjs > /tmp/elsewhere-ro/o`]) {
    const r = await rig(t, { mode: "auto", scratch: sd });
    const v = await viaParent(r, line);
    assert.equal(v.res?.block, true, line);
    assert.equal(r.prompts.length, 0, `${line}: no model call`);
  }
});

test("gate, mode auto: an opaque labelled line whose redirect lands outside the scratch dir is decided by the entry check alone: the parent is asked with zero model calls; the same pipeline into the scratch dir reaches the role question", async (t) => {
  const sd = gateScratch();
  t.after(() => fs.rmSync(sd, { recursive: true, force: true }));
  const s = fwd(sd);
  const other = fwd(path.join(base, "handoffs", "h2"));
  for (const line of ["cat a.txt | sh > /tmp/x", "F=1; echo $F > /tmp/x", `cat a.txt | sh > ${other}/x`]) {
    const r = await rig(t, { mode: "auto", scratch: sd });
    const v = await viaParent(r, line);
    assert.equal(v.asked, true, line);
    assert.equal(v.res?.block, true, line);
    assert.equal(r.prompts.length, 0, `${line}: no model call`);
  }
  const r = await rig(t, { mode: "auto", scratch: sd });
  const v = await viaParent(r, `cat a.txt | sh > ${s}/o`);
  assert.deepEqual([v.asked, v.res], [false, undefined]);
  assert.equal(roleCalls(r), 1);
});
