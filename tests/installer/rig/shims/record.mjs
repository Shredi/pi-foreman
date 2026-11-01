// Shared by the rig shims: append {tool, argv, cwd} to $FAKE_PI_LOG, read versions from $SHIM_VERSIONS.
import * as fs from "node:fs";

export function record(tool) {
  const argv = process.argv.slice(2);
  if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ tool, argv, cwd: process.cwd() })}\n`);
  return argv;
}

export function versions() {
  try {
    return JSON.parse(process.env.SHIM_VERSIONS || "{}");
  } catch {
    return {};
  }
}
