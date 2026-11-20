// Fake `pi` that never answers in time. Run through Node (PI_FOREMAN_PI_BIN).
// Appends one line per call to $FAKE_PI_LOG, then sleeps $FAKE_PI_SLEEP_MS (default 5000) before it would print a version.
import * as fs from "node:fs";

if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args: process.argv.slice(2) })}\n`);
setTimeout(() => {
  console.log("1.6.0");
}, Number(process.env.FAKE_PI_SLEEP_MS || 5000));
