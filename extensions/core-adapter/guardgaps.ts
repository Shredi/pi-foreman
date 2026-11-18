// Shell payload gap on the adapter side (plan D5, ledger item 26): a shell call without a non-empty command
// string is refused, so nothing downstream ever treats a missing command as "nothing to check".

/** Block reason when a shell call has no command string to check, else undefined. */
export function guardPayloadBlock(piTool: string, input: unknown): string | undefined {
  const cmd = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof cmd === "string" && cmd.trim() !== "") return undefined;
  const what = typeof cmd === "string" ? "an empty command" : cmd === undefined ? "no command" : `a command of type ${Array.isArray(cmd) ? "array" : typeof cmd}`;
  return `pi-foreman: the ${piTool} call has ${what}, so the safety checks cannot read it; the call is blocked. Pass the command as a non-empty string.`;
}
