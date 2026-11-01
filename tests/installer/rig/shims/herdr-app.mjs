// Fake `herdr-app`: `--version` prints $SHIM_VERSIONS["herdr-app"]; everything else exits 0.
import { record, versions } from "./record.mjs";

const argv = record("herdr-app");
if (argv[0] === "--version") {
  const v = versions()["herdr-app"];
  if (!v) process.exit(1);
  console.log(v);
}
