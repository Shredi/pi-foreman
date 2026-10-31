// The no-classifier-model warning for `foreman setup` (ledger item 26): bin/foreman runs this after a successful setup.
// It reads the user foreman.json of the agent dir and prints the same text as `foreman doctor` (reviewwarn.ts) for each
// provider that has no classifier rung (classifierTarget); nothing when every provider has one. There is no model registry on
// the command line, so every model the role map names counts as present.
// Usage (Node >= 22.6): node --no-warnings --experimental-strip-types scripts/foreman_review_warn.mjs [setup args]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = (name) => import(pathToFileURL(path.join(here, "..", "extensions", "core-adapter", name)).href);

/** The agent dir named by `--agent-dir`, else PI_CODING_AGENT_DIR, else ~/.pi/agent (as setup.mjs resolves it). */
export function agentDirOf(args, env = process.env) {
  const i = args.findIndex((a) => a === "--agent-dir" || a.startsWith("--agent-dir="));
  let d = i < 0 ? undefined : args[i].includes("=") ? args[i].slice(args[i].indexOf("=") + 1) : args[i + 1];
  d = d || env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  if (d === "~" || d.startsWith("~/") || d.startsWith("~\\")) d = path.join(os.homedir(), d.slice(1));
  return path.resolve(d);
}

/** The WARN lines for the user config of `agentDir`. */
export async function reviewWarnLines(agentDir) {
  const { classifierTarget } = await adapter("classifier.ts");
  const { noClassifierModelText } = await adapter("reviewwarn.ts");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(agentDir, "foreman.json"), "utf8"));
  } catch {
    config = {};
  }
  const registry = { find: () => ({}) };
  const names = Object.keys(config?.providers && typeof config.providers === "object" ? config.providers : {});
  return (names.length ? names : [undefined]).filter((p) => !classifierTarget(config, p, registry)).map((p) => `WARN ${noClassifierModelText(p)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.some((a) => a === "--help" || a === "-h" || a === "--remove")) {
    for (const line of await reviewWarnLines(agentDirOf(args))) console.log(line);
  }
}
