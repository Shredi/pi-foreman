// Fake `python`: `--version` prints $SHIM_VERSIONS.python; everything else exits 0.
import { record, versions } from "./record.mjs";

const argv = record("python");
if (argv[0] === "--version") {
  const v = versions().python;
  if (!v) process.exit(1);
  console.log(v);
}
