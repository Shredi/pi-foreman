// Preload for test:node (node --import): a session opened by `foreman session open` carries the parent env; the tests set their own.
// The names come from session-env.json, the list tests/_isolation.py and _r46world.ts share.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./_spawn-count.mjs";

const { keys, prefixes } = JSON.parse(fs.readFileSync(new URL("./session-env.json", import.meta.url), "utf8"));
for (const k of keys) delete process.env[k];
// A runner inside a Herdr pane must not hand its pane to the adapters under test: their presence files would name it.
for (const k of Object.keys(process.env)) if (prefixes.some((p) => k.startsWith(p))) delete process.env[k];

// No test may reach the real `gh` (the open-PRs refresher of an adapter session runs it): a fake `gh` first on PATH records each
// call's arguments in FOREMAN_FAKE_GH_LOG and fails. r78-fake-gh.test.ts proves the interception. POSIX only: Node cannot exec a
// .cmd stub without a shell, so on Windows the variable stays unset and that test skips.
if (process.platform !== "win32") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fake-gh-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(log, "");
  // Same for `npm`: nothing under test may start it (the global npm root is seeded below); a stray call is logged in
  // FOREMAN_FAKE_NPM_LOG and fails, and the spawn guard of foreman_test_run.mjs counts it.
  const npmLog = path.join(dir, "npm-calls.log");
  fs.writeFileSync(path.join(dir, "npm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${npmLog}'\nexit 1\n`, { mode: 0o755 });
  // `npx` through a shell is a stray npm start too: same log, same failure.
  fs.writeFileSync(path.join(dir, "npx"), `#!/bin/sh\nprintf '%s\\n' "npx $*" >> '${npmLog}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(npmLog, "");
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FOREMAN_FAKE_GH_LOG = log;
  process.env.FOREMAN_FAKE_NPM_LOG = npmLog;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}

// The global npm root every session of a test process sees (owned.ts `npmRootOnce`, pi-model-data.mjs): an empty temp directory, so
// no test starts `npm root -g`. Tests of the lookup itself clear the slot and put their own stub `npm` on PATH.
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-npm-root-")));
  globalThis[Symbol.for("pi-foreman.npm-root")] = { seed: root };
  process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
}

// The herdr-app home the in-process doctor reads (`doctorAppHome` in profiles.mjs): an empty temp dir, seeded like the npm root because HERDR_* is cleared here.
{
  const appHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-app-home-")));
  globalThis[Symbol.for("pi-foreman.herdr-app-home")] = { seed: appHome };
  process.on("exit", () => fs.rmSync(appHome, { recursive: true, force: true }));
}
