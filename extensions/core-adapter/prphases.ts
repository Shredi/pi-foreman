// Two-phase CI (docs/tools.md#phases): `tools.prPhases` is a list of rules per repository that sort the checks of a PR into phase 1 (every check no rule names: it decides
// ready), the gate (phase 2: shown, reported, never holds back ready) and not-counted checks (never counted, never reported). A rule also names the repository's merge label.
// Rules add up: the gate and not-counted lists are the union over every rule whose `repos` match (ignore wins over gate), the last merge label wins. Pure; the tracker (prs-cli.ts),
// the search feed (openprs.ts), pr_checks (gitpack.ts) and the watch (prwatch.ts) share it. A malformed rule is dropped with a message, never widened.
import { globMatch, parseGlobs } from "./prwake.ts";
import type { Bucket, Run } from "./prwatch.ts";

export const MAX_PHASE_RULES = 32;
const MAX_NAMES = 64;
const MAX_LABEL = 50;
/** The `tools.prReadyLabel` shape: 1 to 50 characters, no control character, no comma, no leading `-`. */
const LABEL = /^[^\u0000-\u001f\u007f,-][^\u0000-\u001f\u007f,]{0,49}$/;

export interface PhaseRule {
  /** Globs over the lowercased `owner/name`; null: every repository. */
  repos: string[] | null;
  /** Check-name globs of the gate (phase 2). */
  gate: string[];
  /** Check-name globs of the checks that do not count. */
  ignore: string[];
  /** The repository's merge label; "" when the rule sets none. */
  mergeLabel: string;
}
export type Phase = 1 | 2 | "ignore";
/** The state of the gate of one head: `waiting` (no gate run yet, names still to come), `running`, `failed`, `passed`. */
export interface GateInfo {
  state: "waiting" | "running" | "failed" | "passed";
  /** Literal required names that match a gate glob and have no run. */
  waiting?: string[];
}
/** The effective rules of one repository. */
export interface PhaseView {
  gate: string[];
  ignore: string[];
  mergeLabel: string;
  /** A matching rule names gate checks or a merge label. */
  gated: boolean;
  /** Any rule matches. */
  ruled: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const KNOWN = new Set(["repos", "gate", "ignore", "mergeLabel"]);

function nameGlobs(v: unknown, what: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_NAMES) return `${what} must be a list of at most ${MAX_NAMES} globs`;
  if (v.length === 0) return [];
  return parseGlobs(v, what, MAX_NAMES);
}

function parseRule(raw: unknown): PhaseRule | string {
  if (!isObj(raw)) return "not an object";
  for (const k of Object.keys(raw)) if (!KNOWN.has(k)) return `unknown key ${JSON.stringify(k.slice(0, 40))}`;
  let repos: string[] | null = null;
  if (raw.repos !== undefined) {
    const g = parseGlobs(raw.repos, "repos");
    if (typeof g === "string") return g;
    repos = g.map((x) => x.toLowerCase());
  }
  const gate = nameGlobs(raw.gate, "gate");
  if (typeof gate === "string") return gate;
  const ignore = nameGlobs(raw.ignore, "ignore");
  if (typeof ignore === "string") return ignore;
  let mergeLabel = "";
  if (raw.mergeLabel !== undefined) {
    if (typeof raw.mergeLabel !== "string" || (raw.mergeLabel !== "" && (raw.mergeLabel.length > MAX_LABEL || !LABEL.test(raw.mergeLabel)))) return "mergeLabel must be 1 to 50 characters, no control character, no comma, no leading -";
    mergeLabel = raw.mergeLabel;
  }
  return { repos, gate, ignore, mergeLabel };
}

/** The valid rules of `tools.prPhases` (at most 32) and one message per dropped rule. */
export function parsePhases(raw: unknown): { rules: PhaseRule[]; errors: string[] } {
  const rules: PhaseRule[] = [];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { rules, errors };
  if (!Array.isArray(raw)) return { rules, errors: ["tools.prPhases must be a list"] };
  raw.forEach((r, i) => {
    if (i >= MAX_PHASE_RULES) {
      if (i === MAX_PHASE_RULES) errors.push(`tools.prPhases: only the first ${MAX_PHASE_RULES} rules are used`);
      return;
    }
    const p = parseRule(r);
    if (typeof p === "string") errors.push(`tools.prPhases[${i}]: ${p}`);
    else rules.push(p);
  });
  return { rules, errors };
}

/** The union of the rules whose `repos` match `repo` (`owner/name`, any case). */
export function viewOf(rules: readonly PhaseRule[], repo: string): PhaseView {
  const r = repo.toLowerCase();
  const hit = rules.filter((x) => x.repos === null || x.repos.some((g) => globMatch(g, r)));
  const gate = [...new Set(hit.flatMap((x) => x.gate))];
  const mergeLabel = hit.reduce((acc, x) => x.mergeLabel || acc, "");
  return { gate, ignore: [...new Set(hit.flatMap((x) => x.ignore))], mergeLabel, gated: gate.length > 0 || mergeLabel !== "", ruled: hit.length > 0 };
}

/** The repository has a gate or a merge label: `blocked` counts as ready there and a head with no phase-1 check is never ready. */
export const gatedRepo = (rules: readonly PhaseRule[], repo: string): boolean => viewOf(rules, repo).gated;
/** Any rule matches the repository. */
export const ruledRepo = (rules: readonly PhaseRule[], repo: string): boolean => viewOf(rules, repo).ruled;
/** The repository's merge label, "" when none. */
export const mergeLabelOf = (rules: readonly PhaseRule[], repo: string): string => viewOf(rules, repo).mergeLabel;

/** A source check's name without its `<source>/` prefix. */
const rawOf = (c: { name: string; source?: string }): string => (c.source && c.name.startsWith(`${c.source}/`) ? c.name.slice(c.source.length + 1) : c.name);

const hits = (globs: readonly string[], c: { name: string; source?: string }): boolean => globs.some((g) => globMatch(g, c.name) || globMatch(g, rawOf(c)));

/** The phase of a check under the view of its repository: not counted wins over the gate, every other check is phase 1. */
export function phaseIn(v: PhaseView, c: { name: string; source?: string }): Phase {
  if (hits(v.ignore, c)) return "ignore";
  return hits(v.gate, c) ? 2 : 1;
}

/** The phase of a check of `repo`. */
export const phaseOf = (rules: readonly PhaseRule[], repo: string, c: { name: string; source?: string }): Phase => phaseIn(viewOf(rules, repo), c);

/** The gate state of one head from its gate runs (`phase` 2); undefined: no gate run and nothing waiting. A failure beats waiting names. */
export function gateOf(runs: readonly { bucket: Bucket; phase?: 2 | "ignore" }[], waiting: readonly string[] = []): GateInfo | undefined {
  const g = runs.filter((r) => r.phase === 2);
  const names = waiting.length > 0 ? { waiting: [...waiting] } : {};
  if (g.some((r) => r.bucket === "pending")) return { state: "running", ...names };
  if (g.some((r) => r.bucket === "failed" || r.bucket === "missing")) return { state: "failed", ...names };
  if (waiting.length > 0) return { state: "waiting", ...names };
  return g.length > 0 ? { state: "passed" } : undefined;
}

export interface PhasedSnap {
  runs: Run[];
  /** The required list without the gate and not-counted names; undefined and null stay as they were. */
  required?: string[] | null;
  gate?: GateInfo;
  gated?: true;
  ruled?: true;
}

/**
 * The runs of one head sorted by the rules of `repo`: a gate run gets `gates: false, phase: 2`, a not-counted one `gates: false, phase: "ignore"`, a phase-1 run is left alone.
 * `required` (the raw list of the host) loses the gate and not-counted names, so they never veto a pass; the literal gate names with no run are the gate's `waiting` list.
 * A repository no rule matches gets its input back unchanged. Safe to call again on its own output with the same raw `required`.
 */
export function phasesStep(rules: readonly PhaseRule[], repo: string, runs: Run[], required?: string[] | null): PhasedSnap {
  const v = viewOf(rules, repo);
  if (!v.ruled) return { runs, ...(required !== undefined ? { required } : {}) };
  const tagged = runs.map((r): Run => {
    const p = phaseIn(v, r);
    return p === 1 ? r : { ...r, gates: false, phase: p };
  });
  const isRun = (n: string): boolean => runs.some((r) => r.name === n || rawOf(r) === n);
  let kept = required;
  let waiting: string[] = [];
  if (Array.isArray(required)) {
    const phases = required.map((n) => phaseIn(v, { name: n }));
    kept = required.filter((_, i) => phases[i] === 1);
    waiting = required.filter((n, i) => phases[i] === 2 && !isRun(n));
  }
  const gate = gateOf(tagged, waiting);
  return { runs: tagged, ...(kept !== undefined ? { required: kept } : {}), ...(gate ? { gate } : {}), ...(v.gated ? { gated: true as const } : {}), ...(v.ruled ? { ruled: true as const } : {}) };
}

/** One check entry of a `pr_checks` answer. */
interface CheckLike {
  name?: unknown;
  phase?: string;
  [k: string]: unknown;
}

/**
 * A `pr_checks` answer with the phases applied: a gate check is tagged `phase: "gate"`, a not-counted one `phase: "not counted"`, and the summary counts phase 1 only.
 * Without a repository (`repo` null) and with rules the answer is left as it is plus `phases: "repository unknown"`; with no rules it is returned unchanged.
 */
export function tagChecks(rules: readonly PhaseRule[], repo: string | null, res: Record<string, unknown>): Record<string, unknown> {
  if (rules.length === 0) return res;
  if (repo === null) return { ...res, phases: "repository unknown" };
  const v = viewOf(rules, repo);
  if (!v.ruled) return res;
  const out: Record<string, unknown> = { ...res };
  let passed = 0;
  let pending = 0;
  const failedOne: string[] = [];
  let failedAll = 0;
  for (const k of ["pending", "failed", "passed"] as const) {
    const list = Array.isArray(res[k]) ? (res[k] as CheckLike[]) : [];
    out[k] = list.map((e) => {
      const p = typeof e?.name === "string" ? phaseIn(v, { name: e.name }) : 1;
      if (p !== 1) return { ...e, phase: p === 2 ? "gate" : "not counted" };
      if (k === "passed") passed += 1;
      else if (k === "pending") pending += 1;
      else {
        failedAll += 1;
        if (failedOne.length < 5) failedOne.push(typeof e?.name === "string" && e.name ? e.name : "?");
      }
      return e;
    });
  }
  const total = passed + pending + failedAll;
  const more = failedAll > 5 ? `, +${failedAll - 5}` : "";
  out.summary = total === 0 ? "no checks reported" : `${passed} passed, ${failedAll > 0 ? `${failedAll} failed (${failedOne.join(", ")}${more})` : "0 failed"}, ${pending} pending`;
  return out;
}
