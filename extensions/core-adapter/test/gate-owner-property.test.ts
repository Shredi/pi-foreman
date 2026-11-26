// Property O of the permission gate (plan gate-verify D1, D3), at handler level where the session kind and the judge routing live (index.ts): an owner dialog (in the main
// session), a parent ask (a child) or the headless `no-ui` deny opens only from a fixed ask floor, a self-modification ask, an install-root ask, a protected-target ask or a
// judge `owner` verdict that names one of the six classes. A judge that answers refuse, unsure, nothing in time, an unreadable verdict twice, or has no model gives a refusal
// with its reason for every sampled line and never a dialog; a judge clear runs the line. Lines are the generator's (seeded), classed by its fast oracle.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { mkTestTmp } from "./_tmpbase.ts";
import { r11Rig } from "./_r11rig.ts";
import { posixOnly } from "./_platform.ts";
import { REPEAT_REFUSAL_ERROR } from "../launchwait.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { DANGEROUS, WRAPS, CONSTRUCTS, buildCommand, gateOracle, mainOracle, sampleChains, type Cls, type Layout } from "./_gate-gen.ts";

process.env.PI_OFFLINE = "1";
const SEED = Number(process.env.FOREMAN_GATE_GEN_SEED ?? 1) || 1;
const base = fs.realpathSync(mkTestTmp("pf-owner-prop-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));

type Kind = "main" | "child" | "headless";
type Answer = "clear" | "refuse" | "unsure" | "timeout" | "invalid" | "no-model" | "provider-error" | "owner";
const CLASS_OWNER = JSON.stringify({ verdict: "owner", class: "data-loss", reason: "deletes what git cannot restore" });

async function setup(t: Parameters<typeof r11Rig>[0], kind: Kind) {
  const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
  t.after(() => {
    if (saved.b === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = saved.b;
    if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT;
    else process.env.FOREMAN_CHECKOUT = saved.c;
  });
  if (kind === "child") process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode: "auto", childDeny: true } } });
  delete process.env.FOREMAN_CHECKOUT;
  const state = { answer: "clear" as Answer, judged: 0, selected: 0 };
  const modelRegistry = {
    find: () => (state.answer === "no-model" ? undefined : { id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async () => {
      state.judged++;
      if (state.answer === "timeout") return new Promise<never>(() => undefined);
      if (state.answer === "provider-error") throw new Error("boom");
      const text = state.answer === "invalid" ? "not json" : state.answer === "owner" ? CLASS_OWNER : JSON.stringify({ verdict: state.answer === "clear" ? "clear" : state.answer, reason: "stub reason" });
      return { content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => (state.selected++, undefined), input: async () => "", setStatus: () => undefined, setWidget: () => undefined };
  const config = { presence: { enabled: false }, gate: { reviewTimeoutMs: 100 }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };
  const rig = await r11Rig(t, {}, { ctx: { modelRegistry, ui, ...(kind === "headless" ? { hasUI: false, mode: "print" } : {}) }, config, child: kind === "child" });
  const layout: Layout = { worktree: rig.project, scratch: kind === "child" ? [] : [path.join(base, `scratch-${kind}`)], scratchBase: path.join(base, `rig-scratch-${kind}`) };
  const classOf = (command: string): Cls => (kind === "child" ? gateOracle(layout)(command, "builder") : mainOracle(layout)(command));
  const dialogs = (): number => rig.events("dialog").filter((e) => e.guard === "gate").length;
  return { rig, state, classOf, dialogs };
}

/** Seeded lines of the generator: dangerous payloads in constructs, classed by the fast oracle; `judge` and `ask` lines, a few of each. */
function sample(classOf: (c: string) => Cls): { judge: string[]; ask: string[] } {
  const pool: string[] = [];
  const dangerous = (chain: ReturnType<typeof sampleChains>[number], i: number) => buildCommand(chain, chain[chain.length - 1].kind === "fixed" ? "" : DANGEROUS[i % DANGEROUS.length].text);
  [...sampleChains(SEED, 1, 30, WRAPS, WRAPS), ...sampleChains(SEED, 2, 60, WRAPS, CONSTRUCTS), ...sampleChains(SEED, 3, 30, WRAPS, CONSTRUCTS)].forEach((c, i) => pool.push(dangerous(c, i)));
  const out = { judge: [] as string[], ask: [] as string[] };
  const seen = new Set<string>();
  for (const line of pool) {
    if (seen.has(line)) continue;
    seen.add(line);
    const cls = classOf(line);
    if (cls === "judge" && out.judge.length < 20) out.judge.push(line);
    else if (cls === "ask" && out.ask.length < 3) out.ask.push(line);
  }
  return out;
}

// the refusal of an unreadable child write (danger-write-outside) has its own text
const REFUSED = /^pi-foreman: (refused: |denied \(danger-write-outside\))/;

for (const kind of ["main", "child", "headless"] as const) {
  test(`property O (${kind}): no judge answer but owner+class opens a dialog; refusals carry their reason; clear runs`, { skip: posixOnly }, async (t) => {
    const { rig, state, classOf, dialogs } = await setup(t, kind);
    const all = sample(classOf);
    // a cleared line is remembered by the judge, so the owner phase gets lines of its own
    const lines = { judge: all.judge.slice(0, 16), ask: all.ask };
    const ownerLines = all.judge.slice(16);
    assert.ok(lines.judge.length >= 10, `the sample reaches the judge: ${lines.judge.length}`);
    // every failing or refusing judge answer: a refusal with a reason, never a dialog (a timeout is slow: a few lines)
    for (const answer of ["refuse", "unsure", "invalid", "no-model", "provider-error", "timeout"] as const) {
      state.answer = answer;
      // a child that gets the same refuse or unsure refusal twice is stopped (repeatedDeny): the two answers get their own lines
      const mine = answer === "refuse" ? lines.judge.slice(0, 8) : answer === "unsure" ? lines.judge.slice(8) : answer === "timeout" ? lines.judge.slice(0, 3) : lines.judge;
      for (const line of mine) {
        const d0 = dialogs();
        const s0 = state.selected;
        const j0 = state.judged;
        const res = await rig.call("bash", { command: line });
        const what = `${answer} (${kind}): ${line.replaceAll("\n", "\\n")}\n${JSON.stringify(res)}`;
        assert.ok(res?.block, what);
        assert.equal(dialogs(), d0, `a dialog opened: ${what}`);
        assert.equal(state.selected, s0, `the owner was asked: ${what}`);
        if (state.judged > j0 || answer === "no-model") assert.match(String(res.reason), REFUSED, what);
      }
    }
    // a clear runs what reached the judge
    state.answer = "clear";
    let ran = 0;
    for (const line of lines.judge) {
      const j0 = state.judged;
      const d0 = dialogs();
      const res = await rig.call("bash", { command: line });
      if (state.judged > j0) {
        assert.ok(!res?.block, `clear did not run: ${line}`);
        ran++;
      }
      assert.equal(dialogs(), d0, `a dialog opened on a clear: ${line}`);
    }
    assert.ok(ran >= 3, `clear ran ${ran} lines`);
    // an owner verdict with its class is the judge's only way to a dialog
    state.answer = "owner";
    let opened = 0;
    for (const line of ownerLines) {
      const d0 = dialogs();
      const j0 = state.judged;
      await rig.call("bash", { command: line });
      if (state.judged > j0) {
        assert.equal(dialogs(), d0 + 1, `owner+class opened no dialog: ${line}`);
        opened++;
      }
    }
    assert.ok(opened >= 1, `owner opened ${opened} dialogs`);
    // a fixed ask floor is a dialog (or its child / headless form) whatever the judge would say, and never reaches the judge
    state.answer = "clear";
    for (const line of lines.ask) {
      const d0 = dialogs();
      const j0 = state.judged;
      await rig.call("bash", { command: line });
      assert.equal(state.judged, j0, `an ask floor reached the judge: ${line}`);
      assert.equal(dialogs(), d0 + 1, `an ask floor opened no dialog: ${line}`);
    }
  });
}

// repeatedDeny is keyed on the refusal kind and the input hash: the same judge refusal of the same call twice stops a child run; a refusal of another call, or a failure of the
// judge (timeout, unreadable verdict, no model, provider error), never counts
test("child: the same judge refusal of the same call twice stops the run; other calls and judge failures never count", { skip: posixOnly }, async (t) => {
  const savedExit = process.exitCode;
  t.after(() => void (process.exitCode = savedExit)); // the child's stop marks its process failed
  const { rig, state, classOf } = await setup(t, "child");
  const lines = sample(classOf).judge;
  assert.ok(lines.length >= 4);
  const stopped = (res: { reason?: string } | undefined): boolean => new RegExp(REPEAT_REFUSAL_ERROR).test(String(res?.reason));
  for (const answer of ["timeout", "invalid", "provider-error", "no-model"] as const) {
    state.answer = answer;
    for (let i = 0; i < 3; i++) assert.equal(stopped(await rig.call("bash", { command: lines[0] })), false, `${answer} ${i}`);
  }
  state.answer = "refuse";
  assert.equal(stopped(await rig.call("bash", { command: lines[1] })), false);
  assert.equal(stopped(await rig.call("bash", { command: lines[2] })), false, "another call is another key");
  assert.equal(stopped(await rig.call("bash", { command: lines[1] })), true, "the same call refused twice stops the run");
});
