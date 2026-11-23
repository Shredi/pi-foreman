// Generator test for the review gates (skill: .agents/skills/verifying-review-gates). Seeded random sequences of build / PASS / FAIL / delete in up to three
// checkouts drive the real pure entry points (gatesRevise, gatesVerdict, supersededGone, combined, planLedgerCall) and a model written from the events alone
// is the oracle. After every step:
//   A. the finish verdict (combined of the gates that are not dropped) is a PASS iff every kept checkout stands (a PASS with no work since), and one exists;
//      a gone checkout is dropped iff it is open and another existing checkout got a PASS after its last work and last FAIL (D165)
//   B. `mark V` is accepted iff a counted PASS exists in a kept checkout and no kept checkout's last review failed (later revisions do not reopen V)
//   C. (dialog episodes of childblocked.ts: every order of a checkpoint answer and a session restart in one episode, with and without an answer older than
//      the episode) the ended-episode words say "answered" only with an answer at or after the episode start, and a restart wins over any answer (D159). Env: FOREMAN_REVIEW_GEN_SEED (default 1), FOREMAN_REVIEW_GEN_SEEDS (a sweep of N seeds).
import assert from "node:assert/strict";
import { test } from "node:test";
import { combined, gatesRevise, gatesVerdict, supersededGone, type ReviewGates } from "../reviewgates.ts";
import { planLedgerCall } from "../ledgercall.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChildBlocked } from "../childblocked.ts";
import { liveDir } from "../livestate.ts";
import { writeRegistry } from "../session.ts";

export type Ev = { op: "build" | "pass" | "fail" | "delete"; k: number };
const KEYS = ["/w/c0", "/w/c1", "/w/c2"];

/** The entry points under test; the self-test hands in broken ones. */
export interface Impl {
  revise: typeof gatesRevise;
  verdict: typeof gatesVerdict;
  drop: typeof supersededGone;
  mark: (gate: ReturnType<typeof combined>) => boolean;
}
export const REAL: Impl = {
  revise: gatesRevise,
  verdict: gatesVerdict,
  drop: supersededGone,
  mark: (gate) => !("error" in planLedgerCall({ action: "mark", items: ["V"] }, { gate })),
};

function rng(seed: number): () => number { // mulberry32
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface M { last: "pass" | "fail" | null; revised: boolean; hasPass: boolean; builtAt?: number; passAt?: number; failAt?: number }

/** The model: the events alone, no gate code. Returns what the code must answer after the events, or the first step that differs. */
export function replay(events: readonly Ev[], impl: Impl): string | null {
  let gates: ReviewGates = {};
  const model = new Map<string, M>();
  const gone = new Set<string>();
  let now = 0;
  for (const [i, ev] of events.entries()) {
    const key = KEYS[ev.k];
    now += 1;
    if (ev.op === "delete") gone.add(key);
    else if (gone.has(key)) continue; // nothing builds or is reviewed in a deleted checkout
    else if (ev.op === "build") {
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
      if (!gone.has(k) || stands(m) || at === undefined) continue;
      if ([...model].some(([o, x]) => o !== k && !gone.has(o) && x.passAt !== undefined && x.passAt > at)) dropped.add(k);
    }
    const kept = [...model].filter(([k]) => !dropped.has(k)).map(([, m]) => m);
    const wantFinish = kept.length > 0 && kept.every(stands);
    const wantV = kept.some((m) => m.hasPass) && !kept.some((m) => m.last === "fail");
    const r = impl.drop(gates, (d) => !gone.has(d));
    const got = new Set(r.dropped.map((d) => d.dir));
    const where = `after step ${i + 1} (${ev.op} c${ev.k})`;
    if (got.size !== dropped.size || [...dropped].some((d) => !got.has(d))) return `${where}: dropped [${[...got]}], want [${[...dropped]}]`;
    const c = combined(r.gates);
    const gotFinish = c.last === "pass" && !c.revised;
    if (gotFinish !== wantFinish) return `${where}: finish verdict ${gotFinish ? "pass" : "open"}, want ${wantFinish ? "pass" : "open"}`;
    if (impl.mark(c) !== wantV) return `${where}: mark V ${wantV ? "refused" : "accepted"}, want ${wantV ? "accepted" : "refused"}`;
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

const OPS: Ev["op"][] = ["build", "pass", "fail", "delete"];
const show = (evs: readonly Ev[]): string => evs.map((e) => `${e.op} c${e.k}`).join("; ");

/** Every sequence up to `depth` events over `checkouts` checkouts, then `samples` seeded sequences up to `len` events over three. */
export function cases(seed: number, depth: number, checkouts: number, samples: number, len: number): Ev[][] {
  const out: Ev[][] = [];
  const alphabet: Ev[] = OPS.flatMap((op) => Array.from({ length: checkouts }, (_, k): Ev => ({ op, k })));
  let layer: Ev[][] = [[]];
  for (let d = 0; d < depth; d++) {
    layer = layer.flatMap((s) => alphabet.map((e) => [...s, e]));
    out.push(...layer);
  }
  const next = rng(seed);
  for (let i = 0; i < samples; i++) {
    const n = 2 + Math.floor(next() * (len - 1));
    out.push(Array.from({ length: n }, (): Ev => ({ op: OPS[Math.floor(next() * OPS.length)], k: Math.floor(next() * 3) })));
  }
  return out;
}

export function failures(impl: Impl, seed: number, depth = 4, checkouts = 2, samples = 3000, len = 12): string[] {
  const out: string[] = [];
  for (const [i, evs] of cases(seed, depth, checkouts, samples, len).entries()) {
    if (replay(evs, impl) === null) continue;
    const small = shrink(evs, impl);
    out.push(`seed ${seed} case ${i}: ${show(small)}: ${replay(small, impl)}\nrerun: FOREMAN_REVIEW_GEN_SEED=${seed} node scripts/foreman_test_run.mjs --targeted extensions/core-adapter/test/review-gates-generator.test.ts`);
    if (out.length >= 3) break;
  }
  return out;
}

const SEED = Number(process.env.FOREMAN_REVIEW_GEN_SEED ?? "1");
const SEEDS = Number(process.env.FOREMAN_REVIEW_GEN_SEEDS ?? "1");

test("A and B: the finish verdict and `mark V` follow the model after every step, over every sequence of up to 4 events in 2 checkouts and seeded longer ones in 3", () => {
  for (let s = SEED; s < SEED + SEEDS; s++) assert.deepEqual(failures(REAL, s), []);
});

test("self-check: the sequences reach each outcome (a dropped checkout, a finish pass, V accepted and refused)", () => {
  let dropped = 0;
  let finish = 0;
  let accepted = 0;
  let refused = 0;
  for (const evs of cases(SEED, 4, 2, 500, 12)) {
    let gates: ReviewGates = {};
    const gone = new Set<string>();
    let now = 0;
    for (const ev of evs) {
      now += 1;
      const key = KEYS[ev.k];
      if (ev.op === "delete") gone.add(key);
      else if (gone.has(key)) continue;
      else gates = ev.op === "build" ? gatesRevise(gates, key, now) : gatesVerdict(gates, [key], [ev.op], now, `run${now}`);
      const r = supersededGone(gates, (d) => !gone.has(d));
      const c = combined(r.gates);
      dropped += r.dropped.length > 0 ? 1 : 0;
      finish += c.last === "pass" && !c.revised ? 1 : 0;
      if (REAL.mark(c)) accepted += 1;
      else refused += 1;
    }
  }
  assert.ok(dropped > 0 && finish > 0 && accepted > 0 && refused > 0, JSON.stringify({ dropped, finish, accepted, refused }));
});

test("self-test: a drop rule that ignores the PASS time, one that never drops and a V rule that reads only the last verdict are each reported with a shrunk case", () => {
  const ignoresTime: Impl = { ...REAL, drop: (g, exists) => supersededGone(Object.fromEntries(Object.entries(g).map(([k, e]) => [k, { ...e, passAt: Number.MAX_SAFE_INTEGER }])), exists) };
  const neverDrops: Impl = { ...REAL, drop: (g) => ({ gates: g, dropped: [] }) };
  const lastOnly: Impl = { ...REAL, mark: (gate) => gate.last === "pass" };
  for (const broken of [ignoresTime, neverDrops, lastOnly]) {
    const found = failures(broken, 1, 4, 2, 200);
    assert.ok(found.length > 0 && /rerun: FOREMAN_REVIEW_GEN_SEED=1 /.test(found[0]));
    assert.ok(found[0].split("\n")[0].split("; ").length <= 5, found[0]);
  }
});

// ---- C: the words of an ended dialog episode (childblocked.ts) ----
const MIN = 60_000;
const T0 = Date.parse("2026-11-20T08:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
export type Words = "answered" | "restart" | "none";
/** `stale`: the child had given an answer before the episode began; `events`: what happened inside the episode, in order. */
export interface Scenario { stale: boolean; events: readonly ("answer" | "restart")[] }
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

/** The model: events alone. A restart ends the dialog; else only an answer inside the episode answers it. */
const wantWords = (s: Scenario): Words => (s.events.includes("restart") ? "restart" : s.events.includes("answer") ? "answered" : "none");

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
  assert.ok(found.length > 0 && found.some((f) => /stale answer: true; episode: restart: said answered, want restart/.test(f)), found.join("\n"));
});
