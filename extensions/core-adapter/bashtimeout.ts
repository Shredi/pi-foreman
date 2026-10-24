// R30 item 8: a child's `bash` call gets a default time limit when it names none, and an explicit one above the cap is capped.
// The foreman's own calls are not passed here (index.ts checks the child first). Pure: index.ts sets the result on `event.input`
// and traces `bash_timeout`.

/** Seconds a child's shell command runs when it names no `timeout` (`ceremony.childBashTimeoutSeconds`). */
export const DEFAULT_CHILD_BASH_TIMEOUT = 600;
/** The largest `timeout` a child's shell command may name (`ceremony.childBashTimeoutMaxSeconds`). Matches the child tool timeout. */
export const DEFAULT_CHILD_BASH_TIMEOUT_MAX = 1800;

export interface ChildBashTimeout {
  timeout: number;
  action: "applied" | "capped";
  /** The `timeout` the child named, null when it named none (or a non-number). */
  requested: number | null;
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * The timeout to set on a child's bash input, or null when it keeps its own valid one. A missing, non-numeric or non-positive
 * `timeout` gets `cfg.seconds`, clamped to `cfg.max`; a larger one is capped at `cfg.max`. Invalid config values fall back to the defaults above.
 */
export function childBashTimeout(input: Record<string, unknown>, cfg: { seconds?: unknown; max?: unknown }): ChildBashTimeout | null {
  const max = positive(cfg.max) ? cfg.max : DEFAULT_CHILD_BASH_TIMEOUT_MAX;
  const seconds = Math.min(positive(cfg.seconds) ? cfg.seconds : DEFAULT_CHILD_BASH_TIMEOUT, max);
  const requested = typeof input.timeout === "number" && Number.isFinite(input.timeout) ? input.timeout : null;
  if (!positive(input.timeout)) return { timeout: seconds, action: "applied", requested };
  if (input.timeout > max) return { timeout: max, action: "capped", requested };
  return null;
}
