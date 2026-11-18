// Process watch for the spawn guard of scripts/foreman_test_run.mjs, loaded through `--require` in the run's NODE_OPTIONS (CJS, so it
// also runs in the `node --test` runner and in node descendants). Active only when the wrapper names a directory in FOREMAN_SPAWN_COUNT_DIR.
// Title watch: a process whose process.title changed writes title-<pid>.json ({ titled: true, file }) into that directory, found by an
// unref'd 1 s check (so a process killed by a signal after its first second is still recorded) or at exit.
// Parent watch: when FOREMAN_TEST_WRAPPER_PID is set, the same check exits the process once the wrapper is gone.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIR = process.env.FOREMAN_SPAWN_COUNT_DIR;
if (DIR) {
  const startTitle = process.title;
  let written = false;

  /** The test file this process is named by: FOREMAN_TEST_FILE, "test runner" for the runner, else its own script's basename. */
  const fileLabel = () => {
    if (process.env.FOREMAN_TEST_FILE) return process.env.FOREMAN_TEST_FILE;
    if (process.execArgv.includes("--test")) return "test runner";
    return process.argv[1] ? path.basename(process.argv[1]) : "-";
  };

  const checkTitle = () => {
    if (written || process.title === startTitle) return;
    written = true;
    try {
      fs.writeFileSync(path.join(DIR, `title-${process.pid}.json`), JSON.stringify({ titled: true, file: fileLabel() }));
    } catch {}
  };

  process.on("exit", checkTitle);

  const wrapperPid = Number(process.env.FOREMAN_TEST_WRAPPER_PID);
  const watchParent = Number.isInteger(wrapperPid) && wrapperPid > 0;
  setInterval(() => {
    checkTitle();
    if (!watchParent) return;
    try {
      process.kill(wrapperPid, 0);
    } catch (e) {
      if (e && e.code === "ESRCH") {
        process.stderr.write(`foreman_test_run: wrapper pid ${wrapperPid} is gone, stopping pid ${process.pid}\n`);
        process.exit(1);
      }
    }
  }, 1000).unref();
}
