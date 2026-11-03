// Runs setup.mjs's readline picker with the GitHub-hosts step on a pseudo terminal, so readline raises SIGINT for "\x03" (a piped stdin never does).
//   node host-step-probe.mjs ctrl-c   -> RESULT null
//   node host-step-probe.mjs eof      -> RESULT {... "githubHosts":["github.com"]}
import { PassThrough } from "node:stream";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const mode = process.argv[2];
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
process.stdout.isTTY = true;

let seen = "";
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  seen += String(chunk);
  return realWrite(chunk, ...rest);
};

// Answer each prompt once it shows up in the output, then act at the host prompt.
// (a terminal redraws the prompt line with escape sequences, so they are stripped first)
const ANSWERS = [[/Profile \[\d+\]: /, "\r"], [/Adjust features\? \[y\/N\]: /, "n\r"], [/Install [\w-]+\? \[y\/N\]: /, "n\r"], [/Apply\? \[y\/N\]: /, "y\r"]];
const answerer = setInterval(() => {
  seen = seen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (/GitHub hosts \(comma-separated\) \[github\.com\]: /.test(seen)) {
    seen = "";
    if (mode === "ctrl-c") stdin.write("\x03");
    else stdin.end();
    return;
  }
  for (const [re, reply] of ANSWERS) {
    if (re.test(seen)) {
      seen = "";
      stdin.write(reply);
      return;
    }
  }
}, 20);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { runPicker } = await import(pathToFileURL(path.join(root, "setup.mjs")).href);
const ctx = { currentText: null, currentConfig: {}, recorded: null, installed: [], project: false };
const r = await runPicker(ctx, { tty: false }, { githubHosts: { prefill: ["github.com"], pending: ["github.com"] } });
clearInterval(answerer);
console.log(`\nRESULT ${JSON.stringify(r)}`);
process.exit(0);
