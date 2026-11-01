// Fake `herdr`: `--version` prints $SHIM_VERSIONS.herdr; everything else exits 0.
import { record, versions } from "./record.mjs";

const argv = record("herdr");
if (argv[0] === "--version") {
  const v = versions().herdr;
  if (!v) process.exit(1);
  console.log(v);
}
