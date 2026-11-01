// Fake `hc`: `--version` prints $SHIM_VERSIONS.hc; everything else exits 0.
import { record, versions } from "./record.mjs";

const argv = record("hc");
if (argv[0] === "--version") {
  const v = versions().hc;
  if (!v) process.exit(1);
  console.log(v);
}
