// Wake rules for pr_watch (docs/tools.md#wake-rules): `tools.prWake` is an ordered list of rules that decide which events of a watched PR
// wake the session. Built-in defaults come first, the last matching rule wins, an event no rule matches does not wake. A filter that cannot
// apply to an event never matches: `authors` applies to comment events only, `checks` to `check_failed` only. PR-level events
// (`checks_settled`, `mergeable`, `no_checks`) carry the source `github`. Merged, closed, ready to merge and watch lost are not rule events.
// A malformed rule is dropped with a message, never widened.

export const WAKE_KINDS = ["issue", "review", "review_summary", "check_failed", "checks_settled", "mergeable", "no_checks"] as const;
export type WakeKind = (typeof WAKE_KINDS)[number];
export const MAX_RULES = 64;
const MAX_GLOB = 200;
const MAX_GLOBS = 50;
const SOURCE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type AuthorFilter = "bot" | "human" | "any" | string[];
export interface WakeRule {
  /** A source name, `github` or `*`. */
  source: string;
  /** Globs over the lowercased `owner/name`; null: any. */
  repos: string[] | null;
  /** null: every kind. */
  events: WakeKind[] | null;
  authors: AuthorFilter;
  /** Globs over the raw check name (no `<source>/` prefix); null: any. */
  checks: string[] | null;
  wake: boolean;
}
export interface WakeEvent {
  kind: WakeKind;
  /** `github` or a source name. */
  source: string;
  /** `owner/name`, any case. */
  repo: string;
  author?: string;
  bot?: boolean;
  check?: string;
}

export const DEFAULT_RULES: readonly WakeRule[] = [
  { source: "github", repos: null, events: null, authors: "any", checks: null, wake: true },
  { source: "*", repos: null, events: ["issue", "review", "review_summary", "check_failed", "checks_settled"], authors: "any", checks: null, wake: true },
];

/** `*` (any run of characters) and `?` (one character) over the whole text; case-insensitive. */
export function globMatch(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = ti;
    } else if (star >= 0) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A non-empty list of non-empty glob strings, or an error text. */
export function parseGlobs(v: unknown, what: string): string[] | string {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_GLOBS) return `${what} must be a list of 1..${MAX_GLOBS} globs`;
  const out: string[] = [];
  for (const g of v) {
    if (typeof g !== "string" || g.trim() === "" || g.length > MAX_GLOB || /[\p{Cc}]/u.test(g)) return `${what} has an invalid glob`;
    out.push(g.trim());
  }
  return out;
}

const KNOWN_KEYS = new Set(["source", "repos", "events", "authors", "checks", "wake"]);

function parseRule(raw: unknown): WakeRule | string {
  if (!isObj(raw)) return "not an object";
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) return `unknown key ${JSON.stringify(k.slice(0, 40))}`;
  if (typeof raw.wake !== "boolean") return "wake (boolean) is required";
  let source = "*";
  if (raw.source !== undefined) {
    if (typeof raw.source !== "string" || !(raw.source === "*" || raw.source === "github" || SOURCE_NAME.test(raw.source))) return "source must be a source name, github or *";
    source = raw.source;
  }
  let repos: string[] | null = null;
  if (raw.repos !== undefined) {
    const g = parseGlobs(raw.repos, "repos");
    if (typeof g === "string") return g;
    repos = g.map((x) => x.toLowerCase());
  }
  let events: WakeKind[] | null = null;
  if (raw.events !== undefined) {
    if (!Array.isArray(raw.events) || raw.events.length === 0) return "events must be a non-empty list";
    for (const e of raw.events) if (!(WAKE_KINDS as readonly unknown[]).includes(e)) return `unknown event ${JSON.stringify(String(e).slice(0, 40))}`;
    events = [...new Set(raw.events as WakeKind[])];
  }
  let authors: AuthorFilter = "any";
  if (raw.authors !== undefined) {
    if (raw.authors === "bot" || raw.authors === "human" || raw.authors === "any") authors = raw.authors;
    else {
      const g = parseGlobs(raw.authors, "authors");
      if (typeof g === "string") return `authors must be bot, human, any or a list of login globs`;
      authors = g;
    }
  }
  let checks: string[] | null = null;
  if (raw.checks !== undefined) {
    const g = parseGlobs(raw.checks, "checks");
    if (typeof g === "string") return g;
    checks = g;
  }
  return { source, repos, events, authors, checks, wake: raw.wake };
}

/** The effective rule list (defaults first, then the valid user rules) and one message per dropped rule. */
export function parseWakeRules(raw: unknown): { rules: WakeRule[]; errors: string[] } {
  const rules: WakeRule[] = [...DEFAULT_RULES];
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { rules, errors };
  if (!Array.isArray(raw)) return { rules, errors: ["tools.prWake must be a list"] };
  raw.forEach((r, i) => {
    if (i >= MAX_RULES) {
      if (i === MAX_RULES) errors.push(`tools.prWake: only the first ${MAX_RULES} rules are used`);
      return;
    }
    const p = parseRule(r);
    if (typeof p === "string") errors.push(`tools.prWake[${i}]: ${p}`);
    else rules.push(p);
  });
  return { rules, errors };
}

const COMMENT_KINDS: readonly WakeKind[] = ["issue", "review", "review_summary"];

function matches(r: WakeRule, e: WakeEvent): boolean {
  if (r.source !== "*" && r.source !== e.source) return false;
  if (r.repos && !r.repos.some((g) => globMatch(g, e.repo))) return false;
  if (r.events && !r.events.includes(e.kind)) return false;
  if (r.authors !== "any") {
    if (!COMMENT_KINDS.includes(e.kind)) return false;
    if (r.authors === "bot") {
      if (e.bot !== true) return false;
    } else if (r.authors === "human") {
      if (e.bot === true) return false;
    } else if (e.author === undefined || !r.authors.some((g) => globMatch(g, e.author as string))) return false;
  }
  if (r.checks) {
    if (e.kind !== "check_failed" || e.check === undefined) return false;
    if (!r.checks.some((g) => globMatch(g, e.check as string))) return false;
  }
  return true;
}

/** Does `e` wake? The last matching rule decides; no match: no wake. */
export function wakes(rules: readonly WakeRule[], e: WakeEvent): boolean {
  for (let i = rules.length - 1; i >= 0; i--) if (matches(rules[i], e)) return rules[i].wake;
  return false;
}
