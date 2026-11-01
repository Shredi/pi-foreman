// The "no review model" warning (ledger item 26), one text for `foreman doctor`, `/foreman setup` and the gate's one-time session notice.
// Role launches are a default allow and need no review model; every other non-default tool call asks.

export const REVIEW_MODEL_KEY = "providers.<p>.roles.review.model";

/** The warning body (no WARN prefix). `provider` is the active provider, if any. */
export function noReviewModelText(provider: string | undefined): string {
  return `no review model for provider ${provider ?? "(none)"}: model review is off, so every tool call that is not a default allow asks you (a child or headless session denies it). Role launches (explorer, builder, reviewer) still run. Set ${REVIEW_MODEL_KEY} in foreman.json`;
}
