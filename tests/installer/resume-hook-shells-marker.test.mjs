// The resume block fails toward "check": when the shell's marker file vanishes (tmp cleaner, unwritable TMPDIR) a note is checked again at the
// next prompt, also in shells where `[ note -nt missing ]` is false (zsh). The marker lives in $XDG_RUNTIME_DIR when set, else $TMPDIR; both
// point into the test's temp dir here. The foreman command is a stub that records its arguments.
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

// `runtime` selects which variable carries the marker directory; the other is cleared or points elsewhere inside the temp dir
function run(flavor, runtime, input) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-mk-")));
  const markDir = path.join(base, "mark");
  const other = path.join(base, "other");
  fs.mkdirSync(markDir);
  fs.mkdirSync(other);
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
  const agentDir = path.join(base, "agent");
  const panes = path.join(agentDir, "pi-foreman", "state", "panes");
  fs.mkdirSync(panes, { recursive: true });
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${NEUTRAL[flavor]}${renderResumeBlock({ bin: stub, flavor })}\n`);
  const note = path.join(panes, "t1.json");
  const env = { PATH: process.env.PATH, HOME: base, TERM: "dumb", PI_CODING_AGENT_DIR: agentDir, HC_TERMINAL_ID: "t1" };
  if (runtime) {
    env.XDG_RUNTIME_DIR = markDir;
    env.TMPDIR = other;
  } else {
    env.XDG_RUNTIME_DIR = "";
    env.TMPDIR = markDir;
  }
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
  const r = spawnSync(PYTHON, ["-I", PTY, input(note, markDir), ...argv], { encoding: "utf8", env });
  const calls = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [];
  const marks = fs.readdirSync(markDir).filter((f) => f.startsWith("pi-foreman-resume."));
  const strays = fs.readdirSync(other).length;
  fs.rmSync(base, { recursive: true, force: true });
  return { calls, out: r.stdout, marks, strays };
}

for (const flavor of ["bash", "zsh", "fish"]) {
  const skip = !posix || !PYTHON || !has(flavor) ? `${flavor} or python pty not available` : false;

  for (const runtime of [false, true]) {
    const where = runtime ? "XDG_RUNTIME_DIR" : "TMPDIR";

    test(`${flavor}: a marker deleted between prompts and a rewritten note are checked again (marker in ${where})`, { skip }, () => {
      const r = run(flavor, runtime, (note, dir) => `echo x > '${note}'\ntrue\ntrue\nrm -f '${dir}'/pi-foreman-resume.*; echo y > '${note}'\ntrue\ntrue\ntrue\nexit\n`);
      assert.equal(r.calls.length, 2, r.out);
      assert.equal(r.marks.length, 1, "the marker is back after the second check");
      assert.equal(r.strays, 0, "nothing in the other directory");
    });
  }
}
