#!/usr/bin/env node
// Judge bench: the real judge path (Classifier.judge -> registry.complete) over bench/judge-corpus/corpus.jsonl, per model, through Pi's model registry.
// Usage: node scripts/judge_bench.mjs --model provider/id [--model provider/id ...] [--limit N] [--corpus file] [--thinking low] [--timeout-ms N]
//        [--concurrency N] [--json file] [--pi-root dir] [--headless] [--validate]
// The first model is the baseline of the pass bar (Sonnet); later models are compared against it. It calls real models (cost): run it on purpose.
// --validate checks the corpus format only and calls no model. Output: a short table on stdout, the JSON report in --json (default $FOREMAN_OUT or the temp dir).
// Standalone, the registry is built from Pi's ModelRuntime with the agent dir's auth.json and models.json; a provider that an extension registers (claude-bridge)
// is not in it and a --model that does not resolve fails before any call. --headless runs the bench inside a headless pi (hidden /judge-bench command of the
// core-adapter extension) so extension providers resolve: node scripts/judge_bench.mjs --headless --model claude-bridge/claude-haiku-5-5
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseBenchArgs, runBench } from "../extensions/core-adapter/judgebench.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `--headless` and `--pi-root` belong to the script; the rest goes to parseBenchArgs (and, headless, to the /judge-bench command). */
function splitArgs(argv) {
  const rest = [];
  const own = { headless: false, piRoot: process.env.PI_CODING_AGENT_ROOT ?? "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--headless") own.headless = true;
    else if (argv[i] === "--pi-root") {
      if (i + 1 >= argv.length) throw new Error("--pi-root needs a value");
      own.piRoot = path.resolve(argv[++i]);
    } else rest.push(argv[i]);
  }
  return { own, rest };
}

const agentDir = () => {
  const raw = process.env.PI_CODING_AGENT_DIR;
  if (!raw) return path.join(os.homedir(), ".pi", "agent");
  return raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
};

/** The model registry the extension would hand the classifier: Pi's `ModelRegistry` over a `ModelRuntime` with the agent dir's credentials and models. */
async function buildRegistry(piRoot) {
  const candidates = [piRoot, path.join(root, "node_modules", "@earendil-works", "pi-coding-agent")];
  try {
    candidates.push(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
  } catch {
    // no npm: the other candidates stay
  }
  const dir = candidates.find((c) => c && fs.existsSync(path.join(c, "dist", "index.js")));
  if (!dir) throw new Error("Pi is not installed here: pass --pi-root <dir of @earendil-works/pi-coding-agent> or set PI_CODING_AGENT_ROOT");
  const pi = await import(pathToFileURL(path.join(dir, "dist", "index.js")).href);
  const ad = agentDir();
  const runtime = await pi.ModelRuntime.create({ authPath: path.join(ad, "auth.json"), modelsPath: path.join(ad, "models.json") });
  return new pi.ModelRegistry(runtime);
}

/** Headless path: a pi with this package loaded runs the hidden /judge-bench command, so providers an extension registers (claude-bridge) resolve. */
function runHeadless(rest) {
  if (rest.some((w) => /\s/.test(w))) throw new Error("--headless takes arguments without spaces");
  const pi = process.env.PI_FOREMAN_PI_BIN || "pi";
  const r = spawnSync(pi, ["-p", "--no-session", `/judge-bench ${rest.join(" ")}`], { stdio: "inherit" });
  if (r.error) throw new Error(`cannot start ${pi}: ${r.error.message} (set PI_FOREMAN_PI_BIN)`);
  process.exit(r.status ?? 1);
}

async function main() {
  const { own, rest } = splitArgs(process.argv.slice(2));
  const args = parseBenchArgs(rest, path.join(root, "bench", "judge-corpus", "corpus.jsonl"));
  if (own.headless && !args.validate) return runHeadless(rest);
  const registry = args.validate ? null : await buildRegistry(own.piRoot);
  await runBench({ args, registry, agentDir: agentDir(), log: (l) => console.log(l), outDir: process.env.FOREMAN_OUT || os.tmpdir() });
}

main().catch((e) => {
  console.error(`judge_bench: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
