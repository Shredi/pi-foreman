// Herdr's Pi status file (<agent dir>/extensions/herdr-agent-state.ts): installed or refreshed by Herdr's own installer when `herdr` is on PATH.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** The `herdr` program on the PATH of `env` (not the process PATH), or null. */
export function findHerdr(env, platform = process.platform) {
  const win = platform === "win32";
  const key = win ? Object.keys(env).find((k) => k.toLowerCase() === "path") : "PATH";
  const dirs = String((key && env[key]) || "").split(win ? ";" : ":").filter(Boolean);
  const names = win ? ["herdr.exe", "herdr.cmd", "herdr.bat"] : ["herdr"];
  for (const dir of dirs) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/**
 * `herdr integration install pi` aimed at `agentDir` through PI_CODING_AGENT_DIR (idempotent, no prompt). Without Herdr on PATH nothing happens;
 * a dry run only names the step. Returns the lines to print.
 */
export function herdrPiStep({ agentDir, env, dry, platform = process.platform }) {
  const herdr = findHerdr(env, platform);
  if (!herdr) return [];
  const file = path.join(agentDir, "extensions", "herdr-agent-state.ts");
  const cmd = "herdr integration install pi";
  if (dry) return [`herdr: dry run, would run \`${cmd}\` (writes ${file})`];
  const r = spawnSync(herdr, ["integration", "install", "pi"], { encoding: "utf8", env: { ...env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : (r.stderr || r.stdout || `exit ${r.status}`).trim();
    return [`herdr: \`${cmd}\` failed (${why}); run it yourself so Herdr shows the Pi pane state`];
  }
  return [`herdr: Pi status file installed or refreshed at ${file}`];
}
