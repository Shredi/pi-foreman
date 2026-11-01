// Per-test sandbox for installer tests: temp agent dir, fake HOME, and a bin dir first on PATH whose shims
// (pi, npm, herdr, herdr-app, hc, python) record every call to one JSONL log and answer from $SHIM_VERSIONS.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_PI = path.join(HERE, "..", "fixtures", "fake-pi.mjs");
const SHIMS = { pi: FAKE_PI, npm: "npm.mjs", herdr: "herdr.mjs", "herdr-app": "herdr-app.mjs", hc: "hc.mjs", python: "python.mjs" };

/** `versions`: JSON map for the shims, `{"<npm package>": "1.2.3", herdr: "0.5.1", "herdr-app": "0.1.0", hc: "1.0.0", python: "3.13.0"}`. */
export function createSandbox({ versions = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-rig-")));
  const agentDir = path.join(base, "agent");
  const home = path.join(base, "home");
  const binDir = path.join(base, "bin");
  const log = path.join(base, "calls.jsonl");
  for (const d of [agentDir, home, binDir]) fs.mkdirSync(d);
  fs.writeFileSync(log, "");

  for (const [name, script] of Object.entries(SHIMS)) {
    const file = path.isAbsolute(script) ? script : path.join(HERE, "shims", script);
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${file}" %*\r\n`);
    } else {
      const wrapper = path.join(binDir, name);
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${file}" "$@"\n`);
      fs.chmodSync(wrapper, 0o755);
    }
  }

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    PI_CODING_AGENT_DIR: agentDir,
    PI_FOREMAN_PI_BIN: FAKE_PI,
    FAKE_PI_LOG: log,
    PI_FOREMAN_PICKER: "off",
    CI: "1",
    SHIM_VERSIONS: JSON.stringify(versions),
  };

  return {
    agentDir,
    home,
    binDir,
    env,
    /** Every recorded call as `{tool, argv, cwd?}`; the fake pi's lines are mapped to tool "pi". */
    calls() {
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const r = JSON.parse(l);
          return r.tool ? r : { tool: "pi", argv: r.args };
        });
    },
    /** File tree of the agent dir: relative path to contents. */
    snapshot() {
      const out = {};
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out[path.relative(agentDir, p)] = fs.readFileSync(p, "utf8");
        }
      };
      walk(agentDir);
      return out;
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
