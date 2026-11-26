// setup.mjs installs or refreshes Herdr's Pi status file through `herdr integration install pi` when `herdr` is on PATH (setup/herdr-pi.mjs).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./_sandbox-home.mjs";
import { findHerdr, herdrPiStep } from "../../setup/herdr-pi.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
const posix = process.platform !== "win32";
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

const BASES = [];
after(() => {
  for (const b of BASES) {
    fs.rmSync(b, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    fs.rmSync(`${b}-calls.jsonl`, { force: true });
  }
});

/** A temp tree with an agent dir and, when `withHerdr`, a fake `herdr` that logs its args and the agent dir it was given, then writes the file the real one writes. */
function fresh(withHerdr) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-installer-herdrpi-")));
  BASES.push(base);
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  const bin = path.join(base, "bin");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  const log = path.join(base, "herdr-calls.log");
  if (withHerdr) {
    const script = `#!/bin/sh\necho "$* dir=$PI_CODING_AGENT_DIR" >> "${log}"\nmkdir -p "$PI_CODING_AGENT_DIR/extensions"\necho "// installed by herdr" > "$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts"\n`;
    fs.writeFileSync(path.join(bin, "herdr"), script, { mode: 0o755 });
  }
  return { base, agentDir, cwd, bin, log, file: path.join(agentDir, "extensions", "herdr-agent-state.ts") };
}

function run(env, args) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${env.bin}${path.delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${env.base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("findHerdr and herdrPiStep read the PATH of the env they are given: env {} finds nothing", () => {
  assert.equal(findHerdr({}), null);
  assert.deepEqual(herdrPiStep({ agentDir: "/nowhere", env: {}, dry: false }), []);
});

test("setup: no herdr on PATH, no step and no file", { skip: !posix }, () => {
  const env = fresh(false);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  // the developer's PATH may hold a real herdr; the step then ran against the temp agent dir only
  if (!/herdr: /.test(r.out)) assert.equal(fs.existsSync(env.file), false);
});

test("setup: the dry run lists the step and runs nothing; the real run calls herdr once, aimed at the agent dir; a second run refreshes", { skip: !posix }, () => {
  const env = fresh(true);
  const dry = run(env, ["--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /herdr: dry run, would run `herdr integration install pi`/);
  assert.equal(fs.existsSync(env.log), false);
  assert.equal(fs.existsSync(env.file), false);
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /herdr: Pi status file installed or refreshed at /);
  assert.deepEqual(fs.readFileSync(env.log, "utf8").trim().split("\n"), [`integration install pi dir=${env.agentDir}`]);
  assert.ok(fs.existsSync(env.file));
  assert.equal(run(env, []).code, 0);
  assert.equal(fs.readFileSync(env.log, "utf8").trim().split("\n").length, 2);
});

test("herdrPiStep: a failing installer gives a line that names the command, not an exception", { skip: !posix }, () => {
  const env = fresh(false);
  fs.writeFileSync(path.join(env.bin, "herdr"), "#!/bin/sh\necho boom >&2\nexit 3\n", { mode: 0o755 });
  const lines = herdrPiStep({ agentDir: env.agentDir, env: { PATH: env.bin }, dry: false });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`herdr integration install pi` failed \(boom\)/);
});
