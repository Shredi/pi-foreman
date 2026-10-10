// `timeout <N> <cmd>` for a child's bash ask (frugal-roles D4). The permission system floors every
// wrapper (`timeout`, `env`, `nice`, ...) to "ask" unless the wrapped command is a pure reader, so no
// baseline glob can allow `timeout 900 cargo test`. The foreman's review link therefore allows it
// itself, and only when every unit of the command is allowed by the rules the permission file
// carries: the wrapped command must match an allow pattern and no later ask or deny pattern
// (last matching rule wins, as in the generated file). Chains (`&&`, `||`, `;`, `|`) are split by
// shellchain.ts, which refuses substitutions, subshells, heredocs and the like; those go on to the
// model review. A read-only sed unit (sedread.ts) is allowed the same way: the baseline has no sed
// rule because no glob can separate a print from `1wout` or `1etouch x`. With an effect context
// (effects.ts) a segment may also pass by its effect class; docs/permissions.md has the whole set.
import type { Json } from "./config.ts";
import { get } from "./config.ts";
import type { Baseline } from "./permoverlay.ts";
import { wildcardRegExp } from "./permoverlay.ts";
import { isReadOnlySed } from "./sedread.ts";
import { scratchCommandAllowed } from "./childscratch.ts";
import { isTmpScratch } from "./tmpscratch.ts";
import type { TmpScratchDeps } from "./tmpscratch.ts";
import { ChainWrites, redirectOk, refusedProgram, SAFE_CLASSES, scratchExpansions, segmentEffect } from "./effects.ts";
import type { EffectCtx } from "./effects.ts";
import { splitChain } from "./shellchain.ts";

export interface BashRules {
  allow: string[];
  ask: string[];
  deny: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/** The bash rules in generated-file order: baseline + projectCommands + allow, then asks, then denies. */
export function bashRules(baseline: Baseline, merged: Json | undefined): BashRules {
  const perms = get(merged, "safety.permissions");
  const p = perms && typeof perms === "object" && !Array.isArray(perms) ? (perms as Json) : {};
  return {
    allow: [...(baseline.bash.allow ?? []), ...strs(p.projectCommands), ...strs(p.allow)],
    ask: [...baseline.bash.ask, ...strs(p.ask)],
    deny: [...baseline.bash.deny, ...strs(p.deny)],
  };
}

/** True when `unit` is allowed outright: it matches an allow pattern and no ask or deny pattern. */
export function unitAllowed(rules: BashRules, unit: string, home = ""): boolean {
  return hits(rules.allow, unit, home) && !hits(rules.ask, unit, home) && !hits(rules.deny, unit, home);
}

/** True when `unit` is a read-only sed call that no ask or deny pattern (a user's own included) catches. */
export function sedUnitAllowed(rules: BashRules, unit: string, home = ""): boolean {
  return isReadOnlySed(unit) && !hits(rules.ask, unit, home) && !hits(rules.deny, unit, home);
}

function hits(list: string[], unit: string, home: string): boolean {
  return list.some((pat) => wildcardRegExp(pat, { home, ignoreCase: false, foldSeparators: false }).test(unit));
}

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const FLAGS_WITH_VALUE = new Set(["-s", "-k"]);
const PLAIN_FLAGS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);

/** `timeout [flags] N rest` -> `rest`, or null when the form is anything else. */
export function unwrapTimeout(unit: string): string | null {
  const m = /^timeout\s+(.*)$/s.exec(unit.trim());
  if (!m) return null;
  let rest = m[1].trim();
  for (;;) {
    const w = /^(\S+)\s*(.*)$/s.exec(rest);
    if (!w) return null;
    const [, first, tail] = w;
    if (PLAIN_FLAGS.has(first) || /^--(?:signal|kill-after)=\S+$/.test(first)) {
      rest = tail;
    } else if (FLAGS_WITH_VALUE.has(first)) {
      const v = /^(\S+)\s*(.*)$/s.exec(tail);
      if (!v) return null;
      rest = v[2];
    } else if (DURATION.test(first)) {
      return tail.trim() || null;
    } else return null;
  }
}

export type AllowLabel = "timeout-wrapper" | "test-restore" | "sed-read" | "tmp-scratch" | "child-scratch" | "effect-write-in" | "effect-build-test" | "effect-read";

/** Label precedence when a chain mixes allowed segments (the first present wins). */
const PRECEDENCE: AllowLabel[] = ["timeout-wrapper", "test-restore", "sed-read", "effect-write-in", "effect-build-test", "effect-read"];

export interface AllowDeps extends TmpScratchDeps {
  scratchDirs?: string[];
  /** The effect context (effects.ts); without it only the rules, sed-read and timeout-wrapper apply per segment. */
  effects?: EffectCtx;
}

/**
 * The link's deterministic allow for a forwarded ask, or null:
 *  - "tmp-scratch": the whole command is one `cp`/`mkdir` writing only under /tmp/ (tmpscratch.ts);
 *  - "child-scratch": every `&&`/`;` unit copies into, makes, removes inside or cds into one of
 *    `scratchDirs` (childscratch.ts) or is allowed by the rules;
 *  - else the chain composer: `command` is split on top-level `&&`, `||`, `;` and `|`
 *    (shellchain.ts refuses subshells, substitutions, heredocs, background and the like), every
 *    redirect goes to /dev/null, a scratch dir or /tmp (or is an fd dup), and every segment is
 *    allowed on its own: a `timeout N` wrapper around an allowed segment, print-only sed, a test
 *    restore or a read/build-test/write-in effect class (effects.ts), or a unit the rules allow
 *    when the effect layer does not know the program. At least one segment must carry a label.
 * No ask or deny pattern (a user's own included) may catch the command or any segment.
 */
export function deterministicAllow(rules: BashRules, command: string, deps: AllowDeps = {}): AllowLabel | null {
  return deterministicAllowInfo(rules, command, deps)?.label ?? null;
}

/** deterministicAllow with the number of chain segments (for the `chain_allow` trace). */
export function deterministicAllowInfo(rules: BashRules, command: string, deps: AllowDeps = {}): { label: AllowLabel; segments: number } | null {
  const whole = command.trim();
  if (hits(rules.ask, whole, "") || hits(rules.deny, whole, "")) return null;
  if (isTmpScratch(command, deps)) return { label: "tmp-scratch", segments: 1 };
  if (deps.scratchDirs?.length && scratchCommandAllowed(command, deps.scratchDirs, (u) => unitAllowed(rules, u), deps.platform)) return { label: "child-scratch", segments: command.split(/&&|;/).length };
  for (const text of scratchExpansions(command, deps.scratchDirs ?? [])) {
    const r = compose(rules, text, deps);
    if (r) return r;
  }
  return null;
}

function compose(rules: BashRules, text: string, deps: AllowDeps): { label: AllowLabel; segments: number } | null {
  const chain = splitChain(text);
  if (!chain) return null;
  const c = deps.effects ?? null;
  const scratch = c?.scratch ?? deps.scratchDirs ?? [];
  const platform = c?.platform ?? deps.platform ?? process.platform;
  let cwd: string | null = c?.cwd ?? null;
  const labels = new Set<string>();
  const writes = c ? new ChainWrites(c) : null;
  for (const seg of chain.segments) {
    if (hits(rules.ask, seg.text, "") || hits(rules.deny, seg.text, "") || refusedProgram(seg.words)) return null;
    if (!seg.redirects.every((r) => redirectOk(r, c, cwd, scratch, platform))) return null;
    if (c) {
      if (!writes!.pass(cwd, seg)) return null; // a path under an earlier segment's write (effects.ts ChainWrites)
      const e = segmentEffect(c, cwd, seg);
      if (e.unit !== seg.text && (hits(rules.ask, e.unit, "") || hits(rules.deny, e.unit, ""))) return null;
      if (e.label && SAFE_CLASSES.includes(e.cls)) labels.add(e.label);
      else if (!e.known && unitAllowed(rules, e.unit)) labels.add("rules");
      else return null;
      if (e.wrapped) labels.add("timeout-wrapper");
      cwd = e.cwd;
      continue;
    }
    // no effect context: the rules, print-only sed and the timeout wrapper only
    let unit = seg.text;
    if (seg.words[0] === "timeout") {
      const inner = unwrapTimeout(unit);
      const sub = inner ? splitChain(inner) : null;
      if (!inner || !sub || sub.segments.length !== 1 || sub.segments[0].redirects.length || sub.segments[0].words[0] === "timeout" || refusedProgram(sub.segments[0].words)) return null;
      unit = inner;
      labels.add("timeout-wrapper");
    }
    if (sedUnitAllowed(rules, unit)) labels.add("sed-read");
    else if (!unitAllowed(rules, unit)) return null;
  }
  const label = PRECEDENCE.find((l) => labels.has(l));
  return label ? { label, segments: chain.segments.length } : null;
}

/** Does the ask `command` consist only of allowed units and at least one `timeout N <allowed>` or read-only sed unit? */
export function timeoutCommandAllowed(rules: BashRules, command: string): boolean {
  return deterministicAllow(rules, command) !== null;
}

/**
 * The two session hooks of the review link (index.ts wiring): `headless` is true in print/json mode,
 * without a UI, or when `review.headless` is set (a rig that answers every dialog with "no");
 * `bashRules` feeds the `timeout N <allowed>` rule.
 */
export function reviewExtras(baseline: Baseline | null, config: () => Json | undefined, ctx: { mode?: string; hasUI?: boolean }): { headless: () => boolean; bashRules: () => BashRules | null } {
  const human = ctx.hasUI === true && (ctx.mode === "tui" || ctx.mode === "rpc");
  return {
    headless: () => !human || get(config(), "review.headless") === true,
    bashRules: () => (baseline ? bashRules(baseline, config()) : null),
  };
}
