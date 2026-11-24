#!/usr/bin/env node
// Judge bench: the real judge path (Classifier.judge -> registry.complete) over bench/judge-corpus/corpus.jsonl, per model, through Pi's model registry.
// Usage: node scripts/judge_bench.mjs --model provider/id [--model provider/id ...] [--limit N] [--corpus file] [--thinking low] [--timeout-ms N]
//        [--concurrency N] [--json file] [--pi-root dir] [--validate]
// The first model is the baseline of the pass bar (Sonnet); later models are compared against it. It calls real models (cost): run it on purpose.
// --validate checks the corpus format only and calls no model. Output: a short table on stdout, the JSON report in --json (default $FOREMAN_OUT or the temp dir).
// The registry is built from Pi's ModelRuntime with the agent dir's auth.json and models.json; a provider that an extension registers (e.g. a bridge) is not in it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clearedAgainstBaseline, formatTable, loadCorpus, runModel, summarize } from "../extensions/core-adapter/judgebench.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const a = { models: [], limit: 0, corpus: path.join(root, "bench", "judge-corpus", "corpus.jsonl"), thinking: "low", timeoutMs: 60000, concurrency: 4, json: "", piRoot: process.env.PI_CODING_AGENT_ROOT ?? "", validate: false };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === "--model") a.models.push(v());
    else if (k === "--limit") a.limit = num(v(), k);
    else if (k === "--corpus") a.corpus = path.resolve(v());
    else if (k === "--thinking") a.thinking = v();
    else if (k === "--timeout-ms") a.timeoutMs = num(v(), k);
    else if (k === "--concurrency") a.concurrency = num(v(), k);
    else if (k === "--json") a.json = path.resolve(v());
    else if (k === "--pi-root") a.piRoot = path.resolve(v());
    else if (k === "--validate") a.validate = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let rows = loadCorpus(args.corpus, agentDir());
  if (args.limit) rows = rows.slice(0, args.limit);
  if (args.validate) {
    console.log(`corpus ok: ${rows.length} rows`);
    return;
  }
  if (!args.models.length) throw new Error("pass at least one --model provider/id");
  for (const m of args.models) if (!/^[^/\s]+\/\S+$/.test(m)) throw new Error(`--model ${m} is not provider/id`);
  const registry = await buildRegistry(args.piRoot);
  const models = [];
  for (const model of args.models) {
    let done = 0;
    const results = await runModel({ registry, model, rows, thinking: args.thinking, timeoutMs: args.timeoutMs, concurrency: args.concurrency, onRow: () => (++done % 25 === 0 ? console.error(`${model}: ${done}/${rows.length}`) : undefined) });
    models.push({ model, results, summary: summarize(model, rows, results) });
  }
  const report = { corpus: args.corpus, rows: rows.length, thinking: args.thinking, at: new Date().toISOString(), models: models.map((m) => m.summary), againstBaseline: clearedAgainstBaseline(models), results: Object.fromEntries(models.map((m) => [m.model, m.results])) };
  const jsonPath = args.json || path.join(process.env.FOREMAN_OUT || os.tmpdir(), `judge-bench-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  console.log(formatTable(report.models));
  for (const [m, c] of Object.entries(report.againstBaseline)) console.log(`${m} vs ${args.models[0]}: cleared owner:* rows ${c.clearedExpectedOwner}, cleared rows the baseline stopped as owner ${c.clearedBaselineOwner}`);
  console.log(`json: ${jsonPath}`);
}

main().catch((e) => {
  console.error(`judge_bench: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
