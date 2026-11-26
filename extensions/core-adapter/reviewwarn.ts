// The "no classifier model" warning (ledger item 26, r79 wording), one text for `foreman doctor`, `/foreman setup` and the gate's one-time session notice.
// Role launches never reach the classifier; only judge-first calls do (the dangerous class, and with `gate.unclassified: judge` lines the code cannot classify), and without a model they are refused with that reason.

export const REVIEW_MODEL_KEY = "providers.<p>.roles.review.model";

/** The warning body (no WARN prefix). `provider` is the active provider, if any. */
export function noClassifierModelText(provider: string | undefined): string {
  return `no classifier model for provider ${provider ?? "(none)"}: the classifier is off, so every call on the judge-first list (docs/permissions.md#who-decides) is refused with that reason and nobody is asked; the agent rewrites the call or reports it. A call on a protected target is refused too, unless that target's check is set to ask (then you are asked); a protected call the code cannot read is always refused. Everything else follows your rules and runs. Set ${REVIEW_MODEL_KEY} in foreman.json`;
}

/** The warning body when the classifier model is the cheapest role-map model, not one the config names (no WARN prefix). */
export function autoClassifierModelText(provider: string | undefined, model: string): string {
  return `the classifier model for provider ${provider ?? "(none)"} is ${model}, the cheapest model of your role map: no model is configured for it, so it may be a larger and slower model than the judge needs. Set ${REVIEW_MODEL_KEY} (and providers.<p>.roles.review.thinking) in foreman.json`;
}

/** The doctor line of a configured classifier model: where the model came from, the thinking level and the time limit. */
export function classifierModelLine(target: { provider: string; modelId: string; timeoutMs: number }, level: string): string {
  return `classifier model: ${target.provider}/${target.modelId} (configured, thinking ${level}, timeout ${target.timeoutMs} ms)`;
}
