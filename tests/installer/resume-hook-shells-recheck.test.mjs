// The resume block checks a note at a prompt when this shell has not checked it yet or it changed since: a note made after the first prompt
// (a Pi started later in the shell that crashed) is checked at the next prompt, a kept note that did not change is not checked again, and
// no note means no call. The foreman command is a stub that records its arguments.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const PTY = path.join(HERE, "fixtures", "pty_run.py");
const { renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import pty"], { encoding: "utf8" }).status === 0);
const posix = process.platform !== "win32";

function run(flavor, input) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-re-")));
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
  const agentDir = path.join(base, "agent");
  const panes = path.join(agentDir, "pi-foreman", "state", "panes");
  fs.mkdirSync(panes, { recursive: true });
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${renderResumeBlock({ bin: stub, flavor })}\n`);
  const note = path.join(panes, "t1.json");
  const env = { PATH: process.env.PATH, HOME: base, TMPDIR: base, XDG_RUNTIME_DIR: "", TERM: "dumb", PI_CODING_AGENT_DIR: agentDir, HC_TERMINAL_ID: "t1" };
  let argv;
  if (flavor === "bash") argv = ["bash", "--noprofile", "--rcfile", rc, "-i"];
  else if (flavor === "zsh") {
    fs.copyFileSync(rc, path.join(base, ".zshrc"));
    argv = ["zsh", "-i"];
    env.ZDOTDIR = base;
  } else {
    const dir = path.join(base, "cfg", "fish", "conf.d");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(rc, path.join(dir, "pi-foreman-resume.fish"));
    argv = ["fish", "-i"];
    env.XDG_CONFIG_HOME = path.join(base, "cfg");
  }
  const r = spawnSync(PYTHON, ["-I", PTY, input(note), ...argv], { encoding: "utf8", env });
  const calls = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
  fs.rmSync(base, { recursive: true, force: true });
  return { calls, out: r.stdout };
}

for (const flavor of ["bash", "zsh", "fish"]) {
  const skip = !posix || !PYTHON || !has(flavor) ? `${flavor} or python pty not available` : false;

  test(`${flavor}: a note made after the first prompt is checked at the next prompt, once`, { skip }, () => {
    const r = run(flavor, (note) => `true\ntrue\necho x > '${note}'\ntrue\ntrue\ntrue\nexit\n`);
    assert.equal(r.calls.length, 1, r.out);
    assert.match(r.calls[0], /^pane-resume --shell-pid \d+$/);
  });

  test(`${flavor}: a kept note that did not change is not checked again, a changed one is`, { skip }, () => {
    const r = run(flavor, (note) => `echo x > '${note}'\ntrue\ntrue\ntrue\nsleep 1\necho y > '${note}'\ntrue\ntrue\nexit\n`);
    assert.equal(r.calls.length, 2, r.out);
  });

  test(`${flavor}: no note means no call over several prompts`, { skip }, () => {
    const r = run(flavor, () => "true\ntrue\ntrue\nexit\n");
    assert.deepEqual(r.calls, []);
  });
}
