// The bash command a child has open, told to the launching session through the child's scratch dir (FOREMAN_SCRATCH):
// pi-subagents' "Subagent needs attention" notice (bash open past 240 s) names the tool call but not the command, so the child's
// adapter writes `<scratch>/open-command.json` at the bash tool_call and removes it at the matching tool_result. The foreman reads it
// to tell a test run (expected to be long, `ceremony.longCommands`) from an unknown command. Pure file helpers, best effort.
import * as fs from "node:fs";
import * as path from "node:path";

export const OPEN_COMMAND_FILE = "open-command.json";

export interface OpenCommand {
  toolCallId: string;
  command: string;
  startedAt: number;
}

/** Default `ceremony.longCommands`, used when the config key is missing or not a string array. */
export const DEFAULT_LONG_COMMANDS: readonly string[] = [
  "npm test", "npm run test", "npx vitest", "npx jest", "node --test", "pytest", "python -m unittest", "python -m pytest",
  "cargo test", "go test", "mvn test", "gradle test", "dotnet test", "make test", "pnpm test", "yarn test",
];

export function writeOpenCommand(dir: string, cmd: OpenCommand): void {
  try {
    fs.writeFileSync(path.join(dir, OPEN_COMMAND_FILE), JSON.stringify(cmd), { mode: 0o600 });
  } catch {
    // the notice then keeps its full text
  }
}

/** Remove the file when it names `toolCallId` (a parallel bash call must not clear another's record). */
export function clearOpenCommand(dir: string, toolCallId: string): void {
  try {
    if (readOpenCommand(dir)?.toolCallId === toolCallId) fs.rmSync(path.join(dir, OPEN_COMMAND_FILE), { force: true });
  } catch {
    // best effort
  }
}

export function readOpenCommand(dir: string): OpenCommand | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, OPEN_COMMAND_FILE), "utf8"));
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.toolCallId !== "string" || typeof o.command !== "string" || typeof o.startedAt !== "number") return null;
    return { toolCallId: o.toolCallId, command: o.command, startedAt: o.startedAt };
  } catch {
    return null;
  }
}

/** A leading `cd x &&` (or `;`, newline) segment or a `VAR=value` assignment, with the whitespace after it. */
const LEAD = /^(?:cd(?:\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+))?\s*(?:&&|;|\n)|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]*)\s+)\s*/;

/** The command text the runner must start: leading `cd` segments and env assignments removed. */
function stripLead(line: string): string {
  let s = line.trim();
  for (let m = LEAD.exec(s); m; m = LEAD.exec(s)) s = s.slice(m[0].length);
  return s;
}

/** Chaining, background, pipes, newlines, backticks and `$(`; a fd redirect (`2>&1`, `&>file`) is not one. */
const CHAIN = /[;&|\n\r`]|\$\(/;
const REDIRECT = /\d*>&\d*|&>/g;
/** A watch mode: `--watch`, `--watchAll` (not `=false`) or a script named `*:watch`. */
const WATCH = /--watch(?:All)?(?!=false)(?![\w-])|:watch(?![\w-])/;

/** The first pattern (a regular expression, anchored at the start) that the line's command is, as a whole command; null for none. */
export function isLongCommand(command: string, patterns: readonly string[]): string | null {
  const rest = stripLead(command);
  if (!rest || CHAIN.test(rest.replace(REDIRECT, "")) || WATCH.test(rest)) return null;
  for (const p of patterns) {
    try {
      if (new RegExp(`^(?:${p})(?![\\w-])`).test(rest)) return p;
    } catch {
      // an invalid pattern matches nothing
    }
  }
  return null;
}
