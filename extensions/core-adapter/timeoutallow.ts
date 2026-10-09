// `timeout <N> <cmd>` for a child's bash ask (frugal-roles D4). The permission system floors every
// wrapper (`timeout`, `env`, `nice`, ...) to "ask" unless the wrapped command is a pure reader, so no
// baseline glob can allow `timeout 900 cargo test`. The foreman's review link therefore allows it
// itself, and only when every unit of the command is allowed by the rules the permission file
// carries: the wrapped command must match an allow pattern and no later ask or deny pattern
// (last matching rule wins, as in the generated file). Anything with shell syntax beyond `&&` and
// `;` (pipes, redirects, substitutions, quotes holding such characters) is not handled here and
// goes on to the model review. A read-only sed unit (sedread.ts) is allowed the same way: the
// baseline has no sed rule because no glob can separate a print from `1wout` or `1etouch x`.
import type { Json } from "./config.ts";
import { get } from "./config.ts";
import type { Baseline } from "./permoverlay.ts";
import { wildcardRegExp } from "./permoverlay.ts";
import { isReadOnlySed } from "./sedread.ts";
import { isTmpScratch } from "./tmpscratch.ts";
import type { TmpScratchDeps } from "./tmpscratch.ts";

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
const UNSAFE = /[`$(){}<>|&\\\n\r!]/;

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

/**
 * The link's deterministic allow for a forwarded ask: "timeout-wrapper" when `command` holds a
 * `timeout N <allowed>` unit, else "sed-read" when it holds a read-only sed unit, provided every
 * other unit is allowed by the rules; null otherwise. Units are separated by `&&` or `;`.
 * "tmp-scratch" when the whole command is one `cp`/`mkdir` writing only under /tmp/ (tmpscratch.ts)
 * that no ask or deny pattern catches.
 */
export function deterministicAllow(rules: BashRules, command: string, scratch: TmpScratchDeps = {}): "timeout-wrapper" | "sed-read" | "tmp-scratch" | null {
  if (isTmpScratch(command, scratch) && !hits(rules.ask, command.trim(), "") && !hits(rules.deny, command.trim(), "")) return "tmp-scratch";
  if (UNSAFE.test(command.replace(/&&/g, ";"))) return null;
  const units = command.split(/&&|;/).map((u) => u.trim());
  if (units.some((u) => !u)) return null;
  let wrapped = 0;
  let sed = 0;
  for (const u of units) {
    let unit = u;
    if (/^timeout(\s|$)/.test(u)) {
      const inner = unwrapTimeout(u);
      if (!inner || /^timeout(\s|$)/.test(inner)) return null;
      unit = inner;
      wrapped++;
    }
    if (sedUnitAllowed(rules, unit)) sed++;
    else if (!unitAllowed(rules, unit)) return null;
  }
  return wrapped > 0 ? "timeout-wrapper" : sed > 0 ? "sed-read" : null;
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
