// Importing this module points PI_FOREMAN_HOME at a fresh temp directory unless one is set: a setup.mjs run with a temp --agent-dir writes the resume block
// into the shell startup files under that home, so without it a test would write the developer's real ~/.zshrc. Child processes inherit it through process.env.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

if (!process.env.PI_FOREMAN_HOME) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-home-")));
  process.env.PI_FOREMAN_HOME = home;
  process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
}
