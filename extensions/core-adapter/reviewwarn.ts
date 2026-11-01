// The "no classifier model" warning (ledger item 26, r79 wording), one text for `foreman doctor`, `/foreman setup` and the gate's one-time session notice.
// Role launches never reach the classifier; only calls of the dangerous class do, and without a model they ask the owner.

export const REVIEW_MODEL_KEY = "providers.<p>.roles.review.model";

/** The warning body (no WARN prefix). `provider` is the active provider, if any. */
export function noClassifierModelText(provider: string | undefined): string {
  return `no classifier model for provider ${provider ?? "(none)"}: the classifier is off, so every call of the dangerous class (deploys, forge writes, installs, writes outside the worktree and the like) asks you (a child or headless session denies it). Everything else follows your rules and runs. Set ${REVIEW_MODEL_KEY} in foreman.json`;
}
