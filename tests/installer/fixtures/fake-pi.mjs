// Fake `pi` for installer tests. Run through Node (PI_FOREMAN_PI_BIN).
// Records every call as one JSON line in $FAKE_PI_LOG; `--version` answers $FAKE_PI_VERSION (default 1.1.0).
// `install` / `remove` edit `packages` in settings.json the way Pi does (local paths are stored
// relative to the settings directory).
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
if (process.env.FAKE_PI_LOG) {
  fs.appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ args, agentDir: process.env.PI_CODING_AGENT_DIR })}\n`);
}
if (args[0] === "--version") {
  console.log(process.env.FAKE_PI_VERSION || "1.1.0");
  process.exit(0);
}
const local = args.includes("-l");
const source = args[1];
const base = local ? path.join(process.cwd(), ".pi") : process.env.PI_CODING_AGENT_DIR;
const file = path.join(base, "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  /* new file */
}
const isLocalPath = !/^(npm|git|https?|ssh):/.test(source);
const stored = isLocalPath ? path.relative(base, source) : source;
const same = (e) => e === stored || (isLocalPath && path.resolve(base, e) === path.resolve(source));
const list = Array.isArray(settings.packages) ? settings.packages : [];
if (args[0] === "install") {
  if (!list.some(same)) list.push(stored);
} else if (args[0] === "remove") {
  settings.packages = list.filter((e) => !same(e));
  list.length = 0;
  list.push(...settings.packages);
} else {
  process.exit(2);
}
settings.packages = list;
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`${args[0]} ${source}`);
