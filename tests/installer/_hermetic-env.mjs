// Preload for test:installer and the CI installer step (node --import): setup.mjs reads the herdr-app home, so an unset HERDR_APP_HOME would read the developer's installed mods. Tests that need a home set their own.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// An empty temp directory, removed on exit (the same style as the npm-root seed in extensions/core-adapter/test/_hermetic-env.mjs).
const appHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-app-home-")));
process.env.HERDR_APP_HOME = appHome;
process.on("exit", () => fs.rmSync(appHome, { recursive: true, force: true }));
