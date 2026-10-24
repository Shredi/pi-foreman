// Pi's model data folder, found by plain path lookup. Shared by setup.mjs and /foreman doctor; plain JS, no dependencies.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const WIN = process.platform === "win32";

/** The JS entry a Windows `pi.cmd` shim in `dir` launches, or null. */
function shimScript(cmd, dir) {
  const m = /%dp0%[\\/]+([^"\r\n]+?\.(?:c|m)?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
  return m ? path.resolve(dir, m[1]) : null;
}

/** The @earendil-works/pi-coding-agent folder `file` (after symlinks) lies in, or null. */
function piPackageOf(file) {
  let d;
  try {
    d = fs.realpathSync(file);
  } catch {
    return null;
  }
  for (;;) {
    if (path.basename(d) === "pi-coding-agent" && path.basename(path.dirname(d)) === "@earendil-works") return d;
    if (path.dirname(d) === d) return null;
    d = path.dirname(d);
  }
}

/**
 * Pi's model data folder (<provider>.json files), found by plain path lookup: no module resolution, no network.
 * Order: PI_FOREMAN_PI_AI_DATA (the folder itself; also the test hook), PI_FOREMAN_PI_BIN, every `pi` on PATH that
 * resolves into the pi-coding-agent package (a plain-file launcher is skipped), then `npm root -g`.
 * Returns { dir } or { error }.
 */
export function piModelDataDir() {
  const override = (process.env.PI_FOREMAN_PI_AI_DATA || "").trim();
  if (override) return fs.existsSync(override) ? { dir: path.resolve(override) } : { error: `PI_FOREMAN_PI_AI_DATA ${override} does not exist` };
  const found = () => {
    const bin = process.env.PI_FOREMAN_PI_BIN;
    const fromBin = bin ? piPackageOf(path.resolve(bin)) : null;
    if (fromBin) return fromBin;
    for (const dir of (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean)) {
      for (const name of WIN ? ["pi.exe", "pi.cmd", "pi"] : ["pi"]) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        let target = file;
        if (name === "pi.cmd") {
          try {
            target = shimScript(file, dir);
          } catch {
            target = null;
          }
        }
        const pkg = target ? piPackageOf(target) : null;
        if (pkg) return pkg;
      }
    }
    const r = spawnSync(WIN ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 30_000, shell: WIN, windowsHide: true });
    const root = r.status === 0 ? (r.stdout || "").trim().split(/\r?\n/).pop() : "";
    const pkg = root ? path.join(root, "@earendil-works", "pi-coding-agent") : null;
    return pkg && fs.existsSync(pkg) ? pkg : null;
  };
  const pkg = found();
  if (!pkg) return { error: "the Pi package (@earendil-works/pi-coding-agent) was not found; set PI_FOREMAN_PI_BIN to its cli.js" };
  const rel = path.join("@earendil-works", "pi-ai", "dist", "providers", "data");
  for (const dir of [path.join(pkg, "node_modules", rel), path.join(path.dirname(path.dirname(pkg)), rel)]) if (fs.existsSync(dir)) return { dir };
  return { error: `no pi-ai model data under ${pkg}` };
}
