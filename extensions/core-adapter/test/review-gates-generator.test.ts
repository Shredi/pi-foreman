// Exhaustive walk for the review gates (skill: .agents/skills/verifying-review-gates). EVERY order of the events build / builder launch / builder end / PASS / FAIL (per checkout),
// checkout deleted, mark V, tier rise (trivial -> standard), dialog answer and session restart, up to a stated depth over two checkouts (no random sample), drives the real pure entry
// points (gatesRevise, gatesBuilt, gatesVerdict, supersededGone, combined, planLedgerCall, withVItem and, through a temp agent dir, ChildBlocked) and a model written from the events
// alone is the oracle. After every step:
//   A. the finish verdict (combined of the gates that are not dropped) is a PASS iff every kept checkout stands (a PASS with no work since), and one exists;
//      a gone checkout is dropped iff it is open and another existing checkout got a PASS after its last work (a builder launch or end) and last FAIL, and no builder launched there is still running (D165)
//   B. `mark V` is accepted iff a counted PASS exists in a kept checkout and no kept checkout's last review failed (later revisions do not reopen V); the mark event closes the V line when it is accepted
//   D. the ledger holds one V line once the tier rose above trivial and none before (D164: withVItem appends once, also after V was closed), and a closed V stays closed
//   C. (dialog episodes of childblocked.ts) the ended-episode words say "answered" only with an answer at or after the episode start, and a restart wins over any answer (D159); the walk
//      checks them after every answer or restart event, with and without an answer older than the episode, and a second test sweeps every order of up to 3 of them on their own.
// Env: FOREMAN_REVIEW_GEN_DEPTH (default 5): the walk depth; a larger value is the opt-in sweep (about 17x the cases per step).
import assert from "node:assert/strict";
import { test } from "node:test";
import { combined, gatesBuilt, gatesRevise, gatesVerdict, supersededGone, type ReviewGates } from "../reviewgates.ts";
import { planLedgerCall, withVItem } from "../ledgercall.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { writeRegistry } from "../session.ts";

export type Op = "build" | "launch" | "end" | "pass" | "fail" | "delete" | "markV" | "tier" | "answer" | "restart";
export type Ev = { op: Op; k: number };
const KEYS = ["/w/c0", "/w/c1"];
const OPS: Op[] = ["build", "pass", "fail", "delete", "launch", "end", "markV", "tier", "answer", "restart"];
const PER_CHECKOUT = new Set<Op>(["build", "pass", "fail", "delete", "launch", "end"]);
const LEDGER0 = "# LEDGER t\nTier: trivial\n\n- [ ] 1. a\n";

export type Words = "answered" | "restart" | "none";
/** `stale`: the child had given an answer before the episode began; `events`: what happened inside the episode, in order. */
export interface Scenario { stale: boolean; events: readonly ("answer" | "restart")[] }

/** The entry points under test; the self-test hands in broken ones. */
export interface Impl {
  revise: typeof gatesRevise;
  built: typeof gatesBuilt;
  verdict: typeof gatesVerdict;
  drop: typeof supersededGone;
  mark: (gate: ReturnType<typeof combined>) => boolean;
  withV: typeof withVItem;
  words: (s: Scenario) => Words;
}

interface M { last: "pass" | "fail" | null; revised: boolean; hasPass: boolean; builtAt?: number; passAt?: number; failAt?: number }
/** The walk state: the real code's values (gates, ledger text) beside the model's (what the events alone say they must be). */
interface S {
  gates: ReviewGates;
  ledger: string;
  model: ReadonlyMap<string, M>;
  gone: ReadonlySet<string>;
  running: ReadonlyMap<string, number>; // builder runs launched and not ended, per checkout
  now: number;
  tierUp: boolean;
  vClosed: boolean;
  dialog: readonly ("answer" | "restart")[];
}
const START: S = { gates: {}, ledger: LEDGER0, model: new Map(), gone: new Set(), running: new Map(), now: 0, tierUp: false, vClosed: false, dialog: [] };
export interface Seen { dropped: boolean; finish: boolean; accepted: boolean; refused: boolean; vAppended: boolean; vClosed: boolean }

/** The model: the events alone, no gate code. */
const wantWords = (s: Scenario): Words => (s.events.includes("restart") ? "restart" : s.events.includes("answer") ? "answered" : "none");

/** One event applied to the real code and the model; the new state, or the first rule it breaks, plus what the step reached. */
export function step(s: S, ev: Ev, impl: Impl, words: Map<string, [Words, Words]> = new Map()): { s: S; err: string | null; seen: Seen } {
  const key = KEYS[ev.k];
  const now = s.now + 1;
  let { gates, ledger, tierUp, vClosed, dialog } = s;
  const model = new Map(s.model);
  const gone = new Set(s.gone);
  const running = new Map(s.running);
  let dialogEvent = false;
  if (ev.op === "delete") gone.add(key);
  else if (ev.op === "end") {
    if (running.get(key)) { // an end needs a launch
      running.set(key, running.get(key)! - 1);
      gates = impl.built(gates, [key], now);
      const m = model.get(key);
      if (m) model.set(key, { ...m, builtAt: now }); // a builder ends also in a deleted checkout
    }
  } else if (ev.op === "tier") {
    tierUp = true;
    ledger = impl.withV(ledger) ?? ledger;
  } else if (ev.op === "answer" || ev.op === "restart") {
    dialog = [...dialog, ev.op];
    dialogEvent = true;
  } else if (ev.op === "markV") {
    // handled below, once the kept checkouts are known
  } else if (gone.has(key)) {
    // nothing builds or is reviewed in a deleted checkout
  } else if (ev.op === "build" || ev.op === "launch") {
    if (ev.op === "launch") running.set(key, (running.get(key) ?? 0) + 1);
    gates = impl.revise(gates, key, now);
    const m = model.get(key) ?? { last: null, revised: false, hasPass: false };
    model.set(key, { ...m, revised: m.last !== null || m.revised || !model.has(key) ? true : m.revised, builtAt: now });
  } else {
    gates = impl.verdict(gates, [key], [ev.op], now, `run${now}`);
    const m = model.get(key) ?? { last: null, revised: false, hasPass: false };
    model.set(key, ev.op === "pass" ? { ...m, last: "pass", revised: false, hasPass: true, passAt: now } : { ...m, last: "fail", revised: false, failAt: now });
  }
  // expected: which entries are dropped, and the finish verdict and V over the rest
  const stands = (m: M): boolean => m.last === "pass" && !m.revised;
  const dropped = new Set<string>();
  for (const [k, m] of model) {
    const at = m.builtAt === undefined ? undefined : Math.max(m.builtAt, m.failAt ?? 0);
    if (!gone.has(k) || stands(m) || at === undefined || (running.get(k) ?? 0) > 0) continue;
    if ([...model].some(([o, x]) => o !== k && !gone.has(o) && x.passAt !== undefined && x.passAt > at)) dropped.add(k);
  }
  const kept = [...model].filter(([k]) => !dropped.has(k)).map(([, m]) => m);
  const wantFinish = kept.length > 0 && kept.every(stands);
  const wantV = kept.some((m) => m.hasPass) && !kept.some((m) => m.last === "fail");
  const r = impl.drop(gates, (d) => !gone.has(d), new Set([...running].filter(([, n]) => n > 0).map(([k]) => k)));
  const got = new Set(r.dropped.map((d) => d.dir));
  const c = combined(r.gates);
  const accepted = impl.mark(c);
  const gotFinish = c.last === "pass" && !c.revised;
  const vLine = /^- \[ \] V\./m.test(ledger);
  if (ev.op === "markV" && accepted && vLine) { // the ledger script closes the line; the model closes it when the rule allows
    ledger = ledger.replace("- [ ] V.", "- [x] V.");
    vClosed = true;
  }
  const seen: Seen = { dropped: r.dropped.length > 0, finish: gotFinish, accepted, refused: !accepted, vAppended: tierUp && /V\./.test(ledger), vClosed };
  const next: S = { gates, ledger, model, gone, running, now, tierUp, vClosed, dialog };
  const where = `after ${ev.op}${PER_CHECKOUT.has(ev.op) ? ` c${ev.k}` : ""}`;
  const fail = (msg: string) => ({ s: next, err: `${where}: ${msg}`, seen });
  if (got.size !== dropped.size || [...dropped].some((d) => !got.has(d))) return fail(`dropped [${[...got].join(",")}], want [${[...dropped].join(",")}]`);
  if (gotFinish !== wantFinish) return fail(`finish verdict ${gotFinish ? "pass" : "open"}, want ${wantFinish ? "pass" : "open"}`);
  if (accepted !== wantV) return fail(`mark V ${wantV ? "refused" : "accepted"}, want ${wantV ? "accepted" : "refused"}`);
  const vLines = (ledger.match(/^- \[.\] V\./gm) ?? []).length;
  if (vLines !== (tierUp ? 1 : 0)) return fail(`${vLines} V lines in the ledger, want ${tierUp ? 1 : 0}`);
  if (vClosed !== /^- \[x\] V\./m.test(ledger)) return fail(`V ${vClosed ? "closed" : "open"} by the model, the ledger says otherwise`);
  if (dialogEvent) {
    for (const stale of [false, true]) {
      const sc: Scenario = { stale, events: dialog };
      const id = `${stale}:${dialog.join(",")}`;
      if (!words.has(id)) words.set(id, [impl.words(sc), wantWords(sc)]);
      const [g, w] = words.get(id)!;
      if (g !== w) return fail(`dialog (older answer: ${stale}; ${dialog.join(", ")}): said ${g}, want ${w}`);
    }
  }
  return { s: next, err: null, seen };
}

const none: Seen = { dropped: false, finish: false, accepted: false, refused: false, vAppended: false, vClosed: false };

/** A sequence of events from the start: the first broken rule, or null. */
export function replay(events: readonly Ev[], impl: Impl): string | null {
  let s = START;
  const words = new Map<string, [Words, Words]>();
  for (const [i, ev] of events.entries()) {
    const r = step(s, ev, impl, words);
    if (r.err !== null) return `step ${i + 1} ${r.err}`;
    s = r.s;
  }
  return null;
}

/** The shortest failing sequence: drop one event at a time while it still fails, to a fixed point. */
export function shrink(events: readonly Ev[], impl: Impl): Ev[] {
  for (let i = 0; i < events.length; i++) {
    const shorter = events.filter((_, j) => j !== i);
    if (shorter.length > 0 && replay(shorter, impl) !== null) return shrink(shorter, impl);
  }
  return [...events];
}

const ALPHABET: Ev[] = OPS.flatMap((op) => (PER_CHECKOUT.has(op) ? KEYS.map((_, k): Ev => ({ op, k })) : [{ op, k: 0 }]));
const show = (evs: readonly Ev[]): string => evs.map((e) => (PER_CHECKOUT.has(e.op) ? `${e.op} c${e.k}` : e.op)).join("; ");

/** Every sequence of 1 to `depth` events, depth first, each prefix checked once (a failing prefix is not extended). `onStep` sees every step. */
export function walk(impl: Impl, depth: number, onStep: (seen: Seen) => void = () => {}): { cases: number; failures: string[] } {
  const failures: string[] = [];
  let cases = 0;
  const words = new Map<string, [Words, Words]>(); // the real ChildBlocked, once per distinct dialog
  const go = (s: S, path: Ev[]): void => {
    if (path.length === depth || failures.length >= 3) return;
    for (const ev of ALPHABET) {
      const r = step(s, ev, impl, words);
      cases += 1;
      onStep(r.seen);
      const here = [...path, ev];
      if (r.err !== null) {
        const small = shrink(here, impl);
        failures.push(`${show(small)}: ${replay(small, impl)}\nrerun: node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts`);
        if (failures.length >= 3) return;
        continue;
      }
      go(r.s, here);
    }
  };
  go(START, []);
  return { cases, failures };
}

/** The entry points as the product has them. */
export const REAL: Impl = {
  revise: gatesRevise,
  built: gatesBuilt,
  verdict: gatesVerdict,
  drop: supersededGone,
  mark: (gate) => !("error" in planLedgerCall({ action: "mark", items: ["V"] }, { gate })),
  withV: withVItem,
  words: (s) => realWords(s),
};

const DEPTH = Number(process.env.FOREMAN_REVIEW_GEN_DEPTH ?? "5");

test(`A, B, C, D: the finish verdict, \`mark V\`, the ledger V line and the dialog words follow the model after every step, over every order of up to ${DEPTH} events in 2 checkouts`, () => {
  const t0 = Date.now();
  const r = walk(REAL, DEPTH);
  console.log(`review gates walk: depth ${DEPTH}, ${r.cases} steps checked, ${Date.now() - t0} ms`);
  assert.deepEqual(r.failures, []);
});

test("self-check: the walk reaches each outcome (a dropped checkout, a finish pass, V accepted and refused, V appended by the tier rise, V closed)", () => {
  const total = { ...none };
  walk(REAL, 4, (s) => {
    for (const k of Object.keys(total) as (keyof Seen)[]) total[k] ||= s[k];
  });
  assert.ok(Object.values(total).every(Boolean), JSON.stringify(total));
});

test("self-test: broken rules are each reported with a shrunk case: a drop that ignores the PASS time, one that never drops, a V rule that reads only the last verdict, a build time not stamped at the builder end, a drop that ignores a running builder, a V line appended on every tier rise, the old dialog words", () => {
  const ignoresTime: Impl = { ...REAL, drop: (g, exists, running) => supersededGone(Object.fromEntries(Object.entries(g).map(([k, e]) => [k, { ...e, passAt: Number.MAX_SAFE_INTEGER }])), exists, running) };
  const neverDrops: Impl = { ...REAL, drop: (g) => ({ gates: g, dropped: [] }) };
  const lastOnly: Impl = { ...REAL, mark: (gate) => gate.last === "pass" };
  const noEndStamp: Impl = { ...REAL, built: (g) => g }; // the unfixed code: the build time is only the launch time
  const noRunning: Impl = { ...REAL, drop: (g, exists) => supersededGone(g, exists) }; // a running builder shields nothing
  const vTwice: Impl = { ...REAL, withV: (file) => `${file}- [ ] V. fresh-eyes verification passed\n` }; // no check for an existing V line
  const oldWords: Impl = { ...REAL, words: (sc) => (sc.stale || sc.events.includes("answer") ? "answered" : sc.events.includes("restart") ? "restart" : "none") };
  for (const broken of [ignoresTime, neverDrops, lastOnly, noEndStamp, noRunning, vTwice, oldWords]) {
    const found = walk(broken, 4).failures;
    assert.ok(found.length > 0 && /rerun: node scripts\/foreman_test_run/.test(found[0]));
    assert.ok(found[0].split("\n")[0].split(": ")[0].split("; ").length <= 5, found[0]);
  }
});

// ---- C: the words of an ended dialog episode (childblocked.ts) ----
const MIN = 60_000;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
export interface EndedImpl { words: (s: Scenario) => Words }

/** The real ChildBlocked: an episode starting at T0 is announced, the live file then shows the scenario's last answer and last start, and the next tick ends it. */
function realWords(s: Scenario): Words {
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gen-c-")));
  try {
    let now = T0 - 30 * MIN; // the watcher started before the stale answer, so that answer is not seeded away
    const sent: string[] = [];
    const cb = new ChildBlocked({ agentDir, sessionId: "parent-sess", opener: () => "fm-parent", seconds: () => 600, send: (text) => sent.push(text), now: () => now });
    const handoff = path.join(agentDir, "pi-foreman", "handoffs", "20261120-080000-job");
    fs.mkdirSync(handoff, { recursive: true });
    fs.writeFileSync(path.join(handoff, "live.json"), JSON.stringify({ intercomId: "fm-job-1", piSessionId: "child-sess" }));
    writeRegistry(agentDir, { version: 1, sessions: [{ label: "job", child: "fm-job-1", parent: "fm-parent", handoff, status: "open" }] });
    const live = (f: Record<string, unknown>): void => {
      fs.mkdirSync(liveDir(agentDir), { recursive: true });
      fs.writeFileSync(path.join(liveDir(agentDir), "child-sess.json"), JSON.stringify({ heartbeatAt: iso(now), startedAt: iso(T0 - MIN), ...f }));
    };
    now = T0 + 11 * MIN;
    live({ blockedOn: "owner", blockedKind: "approval", ownerBlockedSince: iso(T0) });
    cb.tick();
    now += MIN;
    const at = (i: number): number => T0 + (i + 1) * MIN;
    const answers = s.events.flatMap((e, i) => (e === "answer" ? [at(i)] : []));
    const restarts = s.events.flatMap((e, i) => (e === "restart" ? [at(i)] : []));
    const lastAnswer = answers.at(-1) ?? (s.stale ? T0 - 5 * MIN : undefined);
    live({ ...(lastAnswer !== undefined ? { lastCheckpoint: { decision: "approve", at: iso(lastAnswer) } } : {}), ...(restarts.length ? { startedAt: iso(restarts.at(-1)!) } : {}) });
    cb.tick();
    const text = sent[1] ?? "";
    return /was answered/.test(text) ? "answered" : /restart/.test(text) ? "restart" : "none";
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}
const REAL_C: EndedImpl = { words: realWords };

export function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  let layer: ("answer" | "restart")[][] = [[]];
  for (let d = 0; d <= 3; d++) {
    for (const events of layer) for (const stale of [false, true]) out.push({ stale, events });
    layer = layer.flatMap((e) => (["answer", "restart"] as const).map((x) => [...e, x]));
  }
  return out;
}

export function failuresC(impl: EndedImpl): string[] {
  return scenarios().flatMap((sc) => {
    const got = impl.words(sc);
    return got === wantWords(sc) ? [] : [`stale answer: ${sc.stale}; episode: ${sc.events.join(", ") || "nothing"}: said ${got}, want ${wantWords(sc)}`];
  });
}

test("C: the ended-episode words follow the model for every order of answers and restarts, with and without an older answer", () => {
  assert.deepEqual(failuresC(REAL_C), []);
});

test("C self-check: the scenarios reach each wording", () => {
  const seen = new Set(scenarios().map(wantWords));
  assert.deepEqual([...seen].sort(), ["answered", "none", "restart"]);
});

test("C self-test: the old order (any stored answer says answered, a restart only without one) is reported", () => {
  const legacy: EndedImpl = { words: (sc) => (sc.stale || sc.events.includes("answer") ? "answered" : sc.events.includes("restart") ? "restart" : "none") };
  const found = failuresC(legacy);
  assert.ok(found.some((f) => /stale answer: true; episode: restart: said answered, want restart/.test(f)), found.join("\n"));
});
