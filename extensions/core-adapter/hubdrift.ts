// `paths.hubWorkflow` sanity check for the doctor and `/foreman setup` (ledger item R12-6): the key is the hub ROOT, the reader appends `.workflow`.
// Nothing here changes a rule or sets the key.

export const HUB_ROOT_FIX = "hub ROOT, the renderer appends .workflow";

/** WARN per `paths.hubWorkflow` value whose last segment is `.workflow`. */
export function hubWorkflowDriftLines(i: { hubWorkflow: unknown }): string[] {
  return (typeof i.hubWorkflow === "string" ? [i.hubWorkflow] : Array.isArray(i.hubWorkflow) ? i.hubWorkflow : [])
    .filter((v): v is string => typeof v === "string" && v.split(/[\\/]+/).filter(Boolean).pop() === ".workflow")
    .map((v) => `WARN paths.hubWorkflow ${v} ends in .workflow: ${HUB_ROOT_FIX}.`);
}
