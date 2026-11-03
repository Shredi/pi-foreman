// `foreman perms suggest|adopt|review` (bin/foreman, .cmd, .ps1): the rule workshop over the gate decision log (permssuggest.ts).
// `adopt` writes the user's permissions file, so it is the owner's command in the owner's terminal: it refuses without a TTY on stdin and stdout.
import * as fs from "node:fs";
import * as os from "node:os";
import * as readline from "node:readline/promises";
import { piAgentDir } from "./env.ts";
import { adopt, parsePicks, review, runSuggest } from "./permssuggest.ts";

const USAGE = "usage: foreman perms suggest [--since <days>] [--min <n>] [--json] | adopt <report> <n>... | review";
const [sub, ...rest] = process.argv.slice(2);
const agentDir = piAgentDir(process.env, os.homedir());

if (sub === "suggest") {
  const r = runSuggest(agentDir, process.cwd(), rest);
  if (r.ok === false) {
    process.stderr.write(`foreman perms suggest: ${r.error}\n`);
    process.exit(2);
  }
  process.stdout.write(`${r.text}\n`);
} else if (sub === "review" && rest.length === 0) {
  process.stdout.write(`${review(agentDir)}\n`);
} else if (sub === "adopt" && rest.length >= 2) {
  const picks = parsePicks(rest.slice(1));
  if (typeof picks === "string") {
    process.stderr.write(`foreman perms adopt: ${picks}\n`);
    process.exit(2);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("foreman perms adopt: refused: it changes your permissions file and needs you at a terminal (stdin and stdout must be a TTY)\n");
    process.exit(1);
  }
  let text: string;
  try {
    text = fs.readFileSync(rest[0], "utf8");
  } catch (e) {
    process.stderr.write(`foreman perms adopt: cannot read ${rest[0]}: ${(e as Error).message}\n`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const r = await adopt(agentDir, text, picks, async (e, file) => (await rl.question(`Add this ${e.kind} to ${file}?\n  ${e.text}\n[y/N] `)).trim().toLowerCase() === "y");
  rl.close();
  process.stdout.write(`${r.lines.join("\n")}\n`);
  process.exit(r.ok ? 0 : 1);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
