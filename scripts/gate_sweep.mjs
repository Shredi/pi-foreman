// Seed sweep of the permission-gate generator test (skill: .agents/skills/verifying-permission-gate).
// Usage: node scripts/gate_sweep.mjs [--seeds N] [--seed S]   -> N seeds (default 20) from S (default 1), one run of the one test file.
// A failure prints the seed, the shrunk command and the rerun line. Stale-mark checks run only at the default single seed (npm run test:node).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`gate_sweep: ${flag} needs a positive integer`);
    process.exit(2);
  }
  return n;
};
for (const a of args) if (a.startsWith("--") && a !== "--seeds" && a !== "--seed") {
  console.error(`gate_sweep: unknown option ${a} (use --seeds N, --seed S)`);
  process.exit(2);
}
const seeds = num("--seeds", 20);
const seed = num("--seed", 1);
const r = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "foreman_test_run.mjs"), "--targeted", "--import", "./extensions/core-adapter/test/_hermetic-env.mjs", "extensions/core-adapter/test/gate-generator.test.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env, FOREMAN_GATE_GEN_SEED: String(seed), FOREMAN_GATE_GEN_SEEDS: String(seeds) } },
);
process.exit(r.status ?? 1);
