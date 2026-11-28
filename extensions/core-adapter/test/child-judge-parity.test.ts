// A child's gate decides like the owner's: a write the gate cannot read goes to the judge and, when the judge does not clear it, is refused with the judge's reason
// (no ask.md) as long as `danger-write-outside` / `danger-unknown-write-target` are the line's only judge-first labels; a protected target is judged for a child that has a
// route to its parent (ask dir in the launch binding, own gate.childAsk "parent") like for the owner's session. Neutral fixtures.
process.env.PI_OFFLINE = "1"; // pi-subagents looks up the npm root on first skill use; offline returns early (no npm spawn)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { gateLogFile } from "../gatelog.ts";
import type { GateRoots } from "../pathrules.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { makeLayout } from "./_gate-gen.ts";
import { mkTestTmp } from "./_tmpbase.ts";

type T = Parameters<typeof r11Rig>[0];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The labels of each line shape (gate level), asserted before any outcome

const layoutBase = fs.realpathSync(mkTestTmp("pf-cjp-"));
after(() => fs.rmSync(layoutBase, { recursive: true, force: true }));
const layout = makeLayout(path.join(layoutBase, "gate"));
const installRoot = path.join(layoutBase, "install");
fs.mkdirSync(installRoot, { recursive: true });
type Who = "builder" | "reviewer" | "main";
const gateRoots = (role: Who, extra: Partial<GateRoots> = {}): GateRoots => ({
  worktree: layout.worktree, scratch: layout.scratch, ...(layout.out ? { out: layout.out } : {}), tmp: [], scratchBase: layout.scratchBase, owned: [], install: [], roundFlow: [], handoffs: [],
  childHandoff: layout.handoff as string, child: role !== "main", role: role === "main" ? "foreman" : role, tmpAccess: false,
  ...(role === "reviewer" ? { roundReadOnly: true } : {}), ...(role === "builder" ? { builder: true } : {}), ...extra,
});
const gateOf = (command: string, role: Who, extra: Partial<GateRoots> = {}) =>
  gateEvaluate("bash", { command }, layout.worktree, {
    env: (c) => baseFloorEnv(c, role === "main" ? { scratch: [layout.scratch[0]] } : { child: true, scratch: layout.scratch, ...(layout.out ? { out: layout.out } : {}), ...(role === "builder" ? { builder: true } : { readOnlyChild: true }) }),
    roots: () => gateRoots(role, extra),
  });
const labelsOf = (command: string, role: Who = "builder"): string[] => {
  const o = gateOf(command, role);
  return (o.dangers ?? (o.danger ? [o.danger.name] : [])).slice().sort();
};
const WO = "danger-write-outside";
const UWT = "danger-unknown-write-target";

const SHAPES: { name: string; command: string; labels: string[]; refuses: boolean }[] = [
  { name: "whole target is a variable", command: "echo x > $F", labels: [WO, UWT].sort(), refuses: true },
  { name: "variable directory", command: "echo x > $D/f", labels: [WO], refuses: true },
  { name: "cd into a variable, then write", command: "cd $X && cat > f", labels: [WO], refuses: true },
  { name: "inline code as well", command: "python3 -c 'print(1)' > $D/f", labels: ["danger-inline-code", WO].sort(), refuses: false },
];

test("the label set of each line shape (a child builder)", () => {
  for (const s of SHAPES) assert.deepEqual(labelsOf(s.command), s.labels, s.name);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Index level: a child with an ask route and a judge that stays unsure

const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 1 } });
const CLEAR = JSON.stringify({ verdict: "clear", reason: "stays in the worktree" });
const UNSURE = JSON.stringify({ verdict: "unsure", reason: "cannot tell where $F points" });
type Judge = "clear" | "unsure" | "invalid" | "timeout" | "error" | "nomodel";

interface Opts {
  role?: "builder" | "reviewer";
  /** The ask dir of the binding; "none" = a group or chain child (no ask dir). */
  askDir?: "made" | "none";
  /** "none" = a child with no launch binding at all. */
  binding?: "none";
  judge?: Judge;
  gate?: Record<string, unknown>;
  perms?: Record<string, unknown>;
  hasUI?: boolean;
  child?: boolean;
  reply?: string;
}
async function rig(t: T, o: Opts = {}) {
  const calls: string[] = [];
  const judge = o.judge ?? "unsure";
  const registry = {
    find: () => (judge === "nomodel" ? undefined : { id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, c: { systemPrompt?: string; messages: { content: string }[] }) => {
      // remote-asks plan D10(b): a protected allow on an ssh line goes on to the main judge; this stub clears it for the protected-target tests (`reply` is the protected check's), `calls` holds the other calls only
      if (o.perms && o.reply && c.systemPrompt?.includes("judge of pi-foreman's tool gate")) return text(CLEAR);
      calls.push(c.messages[0].content);
      if (judge === "error") throw new Error("provider down");
      if (judge === "timeout") return new Promise<never>(() => undefined);
      return text(o.reply ?? (judge === "clear" ? CLEAR : judge === "invalid" ? "not json" : UNSURE));
    },
  };
  const isChild = o.child !== false;
  const askDir = o.askDir === "none" || !isChild ? null : fs.mkdtempSync(path.join(os.tmpdir(), "pf-cjp-ask-"));
  const prev = process.env[BINDINGS_ENV];
  if (isChild && o.binding === "none") delete process.env[BINDINGS_ENV];
  else if (isChild) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: o.role ?? "builder", launchId: "L9", kind: "first", model: null, ...(askDir ? { askDir } : {}) } });
  else delete process.env[BINDINGS_ENV];
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
    if (askDir) fs.rmSync(askDir, { recursive: true, force: true });
  });
  const roles = ["explorer", "builder", "reviewer"];
  const config = { providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false }, gate: { ...(judge === "timeout" ? { reviewTimeoutMs: 60 } : {}), ...o.gate } };
  const perms = o.perms ? { [RIG_PERMISSIONS]: o.perms } : {};
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ...(o.hasUI !== undefined ? { hasUI: o.hasUI } : {}), ...perms }, config, child: isChild });
  const log = (): Record<string, unknown>[] => {
    const f = gateLogFile(r.agentDir);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
  };
  const asked = (): boolean => !!askDir && fs.existsSync(path.join(askDir, "ask.md"));
  return { ...r, calls, log, asked, askDir };
}
const until = async <X>(f: () => X | undefined | false, ms = 4000): Promise<X> => {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("timed out");
};

test("a judge that clears a child's unreadable write lets it run (no ask, one judge call)", async (t) => {
  for (const s of SHAPES.filter((x) => x.refuses)) {
    const r = await rig(t, { judge: "clear" });
    assert.deepEqual(labelsOf(s.command), s.labels, s.name);
    assert.equal(await r.call("bash", { command: s.command }), undefined, s.name);
    assert.equal(r.calls.length, 1, s.name);
    assert.equal(r.asked(), false, s.name);
  }
});

test("an unsure judge refuses a child's write whose only labels are write-outside and unknown-write-target: the judge's reason in the text, no ask.md, one rule record", async (t) => {
  for (const s of SHAPES.filter((x) => x.refuses)) {
    const r = await rig(t, { judge: "unsure" });
    assert.deepEqual(labelsOf(s.command), s.labels, s.name);
    const res = await r.call("bash", { command: s.command });
    assert.equal(res?.block, true, s.name);
    const reason = String(res?.reason);
    assert.match(reason, /danger-write-outside/, s.name);
    assert.match(reason, /cannot tell where \$F points/, `${s.name}: the judge's reason`);
    // this rig binds no scratch or output dir: the text names no variable it does not have (D196a)
    assert.doesNotMatch(reason, /\$FOREMAN_(SCRATCH|OUT)/, s.name);
    assert.match(reason, /your worktree/, `${s.name}: a builder may write its worktree`);
    assert.doesNotMatch(reason, /no pane/, s.name);
    assert.equal(r.asked(), false, `${s.name}: no ask.md`);
    const recs = r.log().filter((x) => x.layer === "rule" && x.rule === WO);
    assert.equal(recs.length, 1, `${s.name}: one rule record`);
    assert.equal(recs[0].verdict, "deny", s.name);
    assert.equal(r.log().some((x) => x.layer === "dialog"), false, `${s.name}: no dialog record`);
    assert.equal(r.events("dialog").length, 0, `${s.name}: no dialog trace`);
  }
});

test("a judge timeout, an invalid verdict, a provider error and no model refuse the same way, with no ask.md", async (t) => {
  const line = "echo x > $F";
  assert.deepEqual(labelsOf(line), [WO, UWT].sort());
  for (const judge of ["timeout", "invalid", "error", "nomodel"] as const) {
    const r = await rig(t, { judge });
    const res = await r.call("bash", { command: line });
    assert.equal(res?.block, true, judge);
    assert.match(String(res?.reason), /danger-write-outside/, judge);
    assert.match(String(res?.reason), /Nobody is asked/, judge);
    assert.equal(r.asked(), false, `${judge}: no ask.md`);
    assert.equal(r.log().filter((x) => x.layer === "rule" && x.rule === WO).length, 1, judge);
  }
});

test("a cached clear runs again without a second judge call", async (t) => {
  const r = await rig(t, { judge: "clear" });
  const line = "echo x > $D/f";
  assert.equal(await r.call("bash", { command: line }), undefined);
  assert.equal(await r.call("bash", { command: line }), undefined);
  assert.equal(r.calls.length, 1);
  assert.equal(r.log().some((x) => x.layer === "cache" && x.verdict === "allow"), true);
});

test("a line with another judge-first label keeps its question: ask.md is written, not the new refusal", async (t) => {
  const line = SHAPES[3].command;
  const r = await rig(t, { judge: "unsure", reply: JSON.stringify({ verdict: "owner", class: "outside-write", reason: "cannot tell where $F points" }) });
  assert.deepEqual(labelsOf(line), SHAPES[3].labels);
  const p = r.call("bash", { command: line });
  const ask = await until(() => (r.asked() ? fs.readFileSync(path.join(r.askDir as string, "ask.md"), "utf8") : false));
  assert.match(ask, /cause: /);
  fs.writeFileSync(path.join(r.askDir as string, "ruling-1.md"), "DENY\nnot this one\n");
  const res = await p;
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /denied by the parent/);
  assert.equal(r.log().some((x) => x.layer === "rule" && x.rule === WO), false);
});

test("a group or chain child (no ask dir) gets the new refusal, not the no-pane text", async (t) => {
  const r = await rig(t, { judge: "unsure", askDir: "none" });
  const res = await r.call("bash", { command: "echo x > $F" });
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /danger-write-outside/);
  assert.match(String(res?.reason), /cannot tell where \$F points/);
  assert.doesNotMatch(String(res?.reason), /no pane/);
  assert.equal(r.log().filter((x) => x.layer === "rule" && x.rule === WO).length, 1);
});

test("a child with gate.childAsk deny gets the new refusal for this line shape too", async (t) => {
  const r = await rig(t, { judge: "unsure", gate: { childAsk: "deny" } });
  const res = await r.call("bash", { command: "echo x > $F" });
  assert.match(String(res?.reason), /danger-write-outside/);
  assert.doesNotMatch(String(res?.reason), /childAsk/);
  assert.equal(r.asked(), false);
});

test("a reviewer's refusal names no folder the rig does not bind, and not the worktree (a reviewer that is not in a round: the gate leaves its write to the judge)", async (t) => {
  const r = await rig(t, { role: "reviewer", judge: "unsure" });
  const res = await r.call("bash", { command: "echo x > $F" });
  assert.equal(res?.block, true);
  const reason = String(res?.reason);
  assert.match(reason, /danger-write-outside/);
  // this rig binds no scratch or output dir: the text names no variable it does not have (D196a)
  assert.doesNotMatch(reason, /\$FOREMAN_(SCRATCH|OUT)/);
  assert.match(reason, /No writable folder outside the worktree is bound/);
  assert.doesNotMatch(reason, /your worktree/);
});

test("the main session's `echo x > $F` is still refused by the foreman's shell-write guard before any judge", async (t) => {
  const r = await rig(t, { child: false, judge: "unsure" });
  const res = await r.call("bash", { command: "echo x > $F" });
  assert.equal(res?.block, true);
  assert.doesNotMatch(String(res?.reason), /danger-write-outside/);
  assert.equal(r.calls.length, 0, "no judge call");
  assert.equal(r.log().some((x) => x.layer === "rule" && x.rule === WO), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Unchanged boundaries (gate level)

test("a floor still decides first for a child: a secret-path write and a force push to a protected branch", () => {
  const secret = gateOf("echo x > ~/.ssh/id_x", "builder").result as { block?: boolean; rule?: string } | undefined;
  assert.equal(secret?.block, true);
  const push = gateOf("git push --force origin main", "builder").result as { block?: boolean; rule?: string } | undefined;
  assert.equal(push?.block, true);
});

test("a resolved write outside is child-write-outside, a delete of an unknown target keeps its label, a write into an install root is refused", () => {
  const out = gateOf("echo x > /elsewhere/f", "builder").result as { block?: boolean; rule?: string } | undefined;
  assert.equal(out?.rule, "child-write-outside");
  assert.ok(labelsOf("rm -rf $X").includes("danger-delete-unknown-target"));
  const inst = gateOf(`echo x > ${installRoot}/f`, "builder", { install: [installRoot] }).result as { block?: boolean } | undefined;
  assert.equal(inst?.block, true);
});

test("a read-only round child's `echo x > $D/f` is child-readonly-write; the main session's has no label", () => {
  const ro = gateOf("echo x > $D/f", "reviewer").result as { block?: boolean; rule?: string } | undefined;
  assert.equal(ro?.rule, "child-readonly-write");
  assert.deepEqual(labelsOf("echo x > $D/f", "main"), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Protected targets: a child with a route to its parent is not away

const HOST = "prod-1.example.net";
const PERMS = { protected: [{ host: "prod-*.example.net" }] };
const SSH = { command: `ssh ${HOST} uptime` };
const WRITE_ALLOW = JSON.stringify({ verdict: "allow", effect: "write", confidence: "high", entry: null, reason: "restarts the service" });
const READ_ALLOW = JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "only reads" });

test("protected: a child with an ask dir and gate.childAsk parent is not away: a confident write allow runs", async (t) => {
  const r = await rig(t, { perms: PERMS, reply: WRITE_ALLOW });
  assert.equal(await r.call("bash", SSH), undefined);
  const pc = r.events("protected_check");
  assert.equal(pc.length, 1);
  assert.deepEqual([pc[0].away, pc[0].accepted], [false, "allow"]);
});

test("protected: a child with no ask dir (group or chain) is away: the write allow becomes an ask", async (t) => {
  const r = await rig(t, { perms: PERMS, reply: WRITE_ALLOW, askDir: "none" });
  const res = await r.call("bash", SSH);
  const pc = r.events("protected_check");
  assert.deepEqual([pc[0].away, pc[0].accepted], [true, "ask"]);
  assert.equal(res?.block, true);
});

test("protected: a child with no launch binding at all is away: the write allow becomes an ask", async (t) => {
  const r = await rig(t, { perms: PERMS, reply: WRITE_ALLOW, binding: "none" });
  const res = await r.call("bash", SSH);
  const pc = r.events("protected_check");
  assert.deepEqual([pc[0].away, pc[0].accepted], [true, "ask"]);
  assert.equal(res?.block, true);
});

test("protected: a child with an ask dir but its own gate.childAsk deny is away", async (t) => {
  const r = await rig(t, { perms: PERMS, reply: WRITE_ALLOW, gate: { childAsk: "deny" } });
  const res = await r.call("bash", SSH);
  assert.deepEqual([r.events("protected_check")[0].away, r.events("protected_check")[0].accepted], [true, "ask"]);
  assert.equal(res?.block, true);
});

test("protected: a headless non-child is away", async (t) => {
  const r = await rig(t, { child: false, hasUI: false, perms: PERMS, reply: WRITE_ALLOW });
  const res = await r.call("bash", SSH);
  assert.deepEqual([r.events("protected_check")[0].away, r.events("protected_check")[0].accepted], [true, "ask"]);
  assert.equal(res?.block, true);
});

test("protected: only a read verdict is cached; a child's repeated read allow is a cache hit, a write allow is judged again", async (t) => {
  const reads = await rig(t, { perms: PERMS, reply: READ_ALLOW });
  assert.equal(await reads.call("bash", SSH), undefined);
  assert.equal(await reads.call("bash", SSH), undefined);
  assert.equal(reads.calls.length, 1, "the second read verdict came from the cache");
  const writes = await rig(t, { perms: PERMS, reply: WRITE_ALLOW });
  assert.equal(await writes.call("bash", SSH), undefined);
  assert.equal(await writes.call("bash", SSH), undefined);
  assert.equal(writes.calls.length, 2, "a write verdict is never cached");
});
