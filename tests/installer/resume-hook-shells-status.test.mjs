// The resume block keeps `$?` for what runs after it: a later PROMPT_COMMAND entry (bash) or precmd hook (zsh), or a later fish_prompt handler,
// still sees the status of the user's last command, with no pane note and with one. The foreman command is a stub; everything stays in a temp dir.
import { test } from "node:test";
import "./_sandbox-home.mjs";
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

const AFTER = {
  bash: 'PROMPT_COMMAND="${PROMPT_COMMAND};echo \\"RC=\\$?\\""\n',
  zsh: '__show_rc() { print "RC=$?" }\nprecmd_functions+=(__show_rc)\n',
  fish: "function __show_rc --on-event fish_prompt\n    echo RC=$status\nend\n",
};

function run(flavor, withNote) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-st-")));
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  // exit 75 removes the marker, so with a note every prompt takes the full path and the status after the foreman command is what the test checks
  fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n${withNote ? "exit 75\n" : ""}`, { mode: 0o755 });
  const agentDir = path.join(base, "agent");
  const panes = path.join(agentDir, "pi-foreman", "state", "panes");
  fs.mkdirSync(panes, { recursive: true });
  if (withNote) fs.writeFileSync(path.join(panes, "t1.json"), "{}");
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${NEUTRAL[flavor]}${renderResumeBlock({ bin: stub, flavor })}\n${AFTER[flavor]}`);
  const env = { PATH: process.env.PATH, HOME: base, TERM: "dumb", PI_CODING_AGENT_DIR: agentDir, HC_TERMINAL_ID: "t1", XDG_RUNTIME_DIR: "", TMPDIR: base };
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
  const r = spawnSync(PYTHON, ["-I", PTY, "false\n(exit 7)\ntrue\nexit\n", ...argv], { encoding: "utf8", env });
  const calls = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length : 0;
  fs.rmSync(base, { recursive: true, force: true });
  return { seen: [...r.stdout.matchAll(/RC=(\d+)/g)].map((m) => m[1]), out: r.stdout, calls };
}

for (const flavor of ["bash", "zsh", "fish"]) {
  const skip = !posix || !PYTHON || !has(flavor) ? `${flavor} or python pty not available` : false;
  for (const withNote of [false, true]) {
    test(`${flavor}: a hook behind the block still sees $? of the last command (${withNote ? "note present" : "no note"})`, { skip }, () => {
      const r = run(flavor, withNote);
      assert.deepEqual(r.seen.slice(0, 4), ["0", "1", "7", "0"], r.out);
      if (withNote) assert.ok(r.calls >= 1, "the block ran the foreman command");
    });
  }
}
