// Fake `python3` for installer and launcher tests (POSIX). Written as a shell script that answers the
// version probes the launchers and setup.mjs send (`-c "...sys.exit(...)"` and `-c "...%d.%d..."` /
// `...sys.executable...`) and records every call's argv, one line each, in `log`. Any other call
// (the launcher exec of a script) only records and exits 0.
import * as fs from "node:fs";

export function writeFakePython(file, version, log) {
  const [major, minor] = version.split(".").map(Number);
  fs.writeFileSync(
    file,
    `#!/bin/sh
echo "$*" >> '${log}'
case "$*" in
  *sys.exit*) [ ${major * 100 + minor} -ge 313 ] ;;
  *sys.executable*) echo ${version}; echo "$0" ;;
  *"%d.%d"*) echo ${version} ;;
esac
`,
    { mode: 0o755 },
  );
  return file;
}
