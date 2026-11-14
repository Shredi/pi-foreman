/** Usage line of `/foreman config`. */
export const CONFIG_USAGE = "Usage: /foreman config apply-preset <name> [--foreman <model id>] [--dry-run] | /foreman config validate";

/** The line shown after a real apply-preset. */
export const CONFIG_APPLIED_LINE = "run /foreman setup to apply the models";

/** The script output, with the follow-up line after a successful real apply-preset. */
export function configResultText(text: string, applies: boolean, ok: boolean): string {
  return applies && ok ? `${text}\n${CONFIG_APPLIED_LINE}` : text;
}

export type ConfigCommand = { argv: string[]; applies: boolean } | { usage: string };

/**
 * The foreman_config.py argv for the words after `/foreman config`, or the usage line. Only `apply-preset <name>
 * [--foreman <value>] [--dry-run]` and `validate` (no arguments) are accepted; the agent dir is the session's and is
 * passed last, never typed. `applies` is true when the run changes files (apply-preset without --dry-run).
 */
export function parseConfigArgs(words: string[], agentDir: string): ConfigCommand {
  const refuse = { usage: CONFIG_USAGE };
  const [verb, ...args] = words;
  if (verb === "validate") return args.length === 0 ? { argv: ["validate", "--agent-dir", agentDir], applies: false } : refuse;
  if (verb !== "apply-preset") return refuse;
  const name = args[0];
  if (name === undefined || name.startsWith("-")) return refuse;
  let foreman: string | undefined;
  let dry = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--dry-run" && !dry) {
      dry = true;
    } else if (args[i] === "--foreman" && foreman === undefined) {
      const v = args[++i];
      if (v === undefined || v.startsWith("-")) return refuse;
      foreman = v;
    } else {
      return refuse;
    }
  }
  return { argv: ["apply-preset", name, ...(foreman !== undefined ? ["--foreman", foreman] : []), ...(dry ? ["--dry-run"] : []), "--agent-dir", agentDir], applies: !dry };
}
