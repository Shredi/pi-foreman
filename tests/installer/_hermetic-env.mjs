// Preload for test:installer and the CI installer step (node --import): setup.mjs reads the herdr-app home, so an unset HERDR_APP_HOME would read the developer's installed mods. Tests that need a home set their own.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// setup.mjs writes the resume block under PI_FOREMAN_HOME (else the real home): an unset one gets its own temp directory.
import "./_sandbox-home.mjs";
import { scrubSessionEnv } from "../../scripts/session_env.mjs";

// A session's own variables (session-env.json) go first: the HERDR_ prefix would remove the HERDR_APP_HOME set below.
scrubSessionEnv(process.env);

// An empty temp directory, removed on exit (the same style as the npm-root seed in extensions/core-adapter/test/_hermetic-env.mjs).
const appHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-app-home-")));
process.env.HERDR_APP_HOME = appHome;
process.on("exit", () => fs.rmSync(appHome, { recursive: true, force: true }));
