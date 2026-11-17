// The JS entry a Windows npm-style `pi.cmd` shim launches. Its own module (node:* imports only) so `foreman pane-resume` can use it without
// pulling in pi-model-data.mjs, which names the Pi package.
import * as fs from "node:fs";
import * as path from "node:path";

/** The JS entry a Windows `pi.cmd` shim in `dir` launches, or null. */
export function shimScript(cmd, dir) {
  const m = /%dp0%[\\/]+([^"\r\n]+?\.(?:c|m)?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
  return m ? path.resolve(dir, m[1]) : null;
}
