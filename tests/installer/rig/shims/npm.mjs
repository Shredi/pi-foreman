// Fake `npm`: `view <pkg> version` answers $SHIM_VERSIONS[pkg]; everything else (install, ci, ...) exits 0.
import { record, versions } from "./record.mjs";

const argv = record("npm");
if (argv[0] === "view" && argv[2] === "version") {
  const v = versions()[argv[1]];
  if (!v) process.exit(1);
  console.log(v);
}
