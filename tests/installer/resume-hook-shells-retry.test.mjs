// The resume block under noclobber (the marker touch must not fail or print an error) and its retry rule: exit 75 (Pi still ending) and
// exit 127 (no node yet) from the foreman command remove the marker, so the next prompt checks again; any other code keeps the marker.
// The foreman command is a stub that records its arguments and exits with the code in the file `code` next to it.
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
// A fixed prompt in the test's own rc, so host prompt text (user, host, directory names) can never match an output check.
const NEUTRAL = { bash: "PS1='> '\n", zsh: "PROMPT='> '\nRPROMPT=''\n", fish: "function fish_prompt; echo -n '> '; end\nfunction fish_right_prompt; end\n" };

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import pty"], { encoding: "utf8" }).status === 0);
const posix = process.platform !== "win32";

function run(flavor, code, input) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-rt-")));
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  fs.writeFileSync(path.join(base, "code"), String(code));
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\nexit "$(cat "${path.join(base, "code")}")"\n`, { mode: 0o755 });
  const agentDir = path.join(base, "agent");
  const panes = path.join(agentDir, "pi-foreman", "state", "panes");
  fs.mkdirSync(panes, { recursive: true });
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${NEUTRAL[flavor]}${renderResumeBlock({ bin: stub, flavor })}\n`);
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

  if (flavor !== "fish") {
    const noclobber = flavor === "bash" ? "set -o noclobber" : "setopt noclobber";
    test(`${flavor}: under noclobber one note change gives one recheck and no error output`, { skip }, () => {
      const r = run(flavor, 0, (note) => `${noclobber}\necho x >| '${note}'\ntrue\ntrue\nsleep 1\necho y >| '${note}'\ntrue\ntrue\ntrue\nexit\n`);
      assert.equal(r.calls.length, 2, r.out);
      assert.doesNotMatch(r.out, /file exists|cannot overwrite|__pi_foreman_resume:/i);
    });
  }

  for (const code of [75, 127]) {
    test(`${flavor}: exit ${code} removes the marker, so the next prompt checks again`, { skip }, () => {
      const r = run(flavor, code, (note) => `echo x > '${note}'\ntrue\ntrue\ntrue\nexit\n`);
      assert.ok(r.calls.length >= 3, r.out);
    });
  }

  test(`${flavor}: exit 0 and another code keep the marker, the note is checked once`, { skip }, () => {
    for (const code of [0, 3]) {
      const r = run(flavor, code, (note) => `echo x > '${note}'\ntrue\ntrue\ntrue\nexit\n`);
      assert.equal(r.calls.length, 1, `code ${code}: ${r.out}`);
    }
  });
}
