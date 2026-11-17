// D34: the resume block of a custom agent dir run by real shells (skipped for a shell, or the pseudo terminal helper, that is not installed). The agent dir
// has a space and a single quote in its name and is not in the shell's environment; the block must find the note there and hand the dir to the (stub)
// foreman for that one call, and the shell's own environment must stay without PI_CODING_AGENT_DIR. The gitbash block runs in plain bash here (no cygpath:
// the lookup falls back to the baked path); the Windows run in Git Bash itself is in resume-hook-gitbash.test.mjs. The PowerShell block runs only on Windows.
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
const NEUTRAL = { bash: "PS1='> '\n", zsh: "PROMPT='> '\nRPROMPT=''\n", fish: "function fish_prompt; echo -n '> '; end\nfunction fish_right_prompt; end\n" };

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import pty"], { encoding: "utf8" }).status === 0);
const posix = process.platform !== "win32";

// The stub logs the PI_CODING_AGENT_DIR it was called with and its arguments.
function world(flavor, blockFlavor = flavor) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-custom-")));
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  fs.writeFileSync(stub, `#!/bin/sh\necho "dir=$PI_CODING_AGENT_DIR args=$@" >> '${marker}'\n`, { mode: 0o755 });
  const agentDir = path.join(base, "my agent", "it's here");
  fs.mkdirSync(path.join(agentDir, "pi-foreman", "state", "panes"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-foreman", "state", "panes", "t1.json"), "{}");
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${NEUTRAL[flavor]}${renderResumeBlock({ bin: stub, flavor: blockFlavor, agentDir })}\n`);
  return { base, marker, agentDir, rc };
}

// After the first prompt the shell prints whether it has PI_CODING_AGENT_DIR in its environment.
const PROBE = "printenv PI_CODING_AGENT_DIR || echo AFTER=unset\nexit\n";

function interactive(w, argv, env = {}) {
  const r = spawnSync(PYTHON, ["-I", PTY, PROBE, ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: w.base, TERM: "dumb", HC_TERMINAL_ID: "t1", TMPDIR: w.base, XDG_RUNTIME_DIR: "", ...env },
  });
  return { out: r.stdout, marker: fs.existsSync(w.marker) ? fs.readFileSync(w.marker, "utf8").trim().split("\n") : [] };
}

const shells = {
  bash: (w, env) => interactive(w, ["bash", "--noprofile", "--rcfile", w.rc, "-i"], env),
  gitbash: (w, env) => interactive(w, ["bash", "--noprofile", "--rcfile", w.rc, "-i"], env),
  zsh: (w, env) => {
    fs.copyFileSync(w.rc, path.join(w.base, ".zshrc"));
    return interactive(w, ["zsh", "-i"], { ZDOTDIR: w.base, ...env });
  },
  fish: (w, env) => {
    const dir = path.join(w.base, "cfg", "fish", "conf.d");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(w.rc, path.join(dir, "pi-foreman-resume.fish"));
    return interactive(w, ["fish", "-i"], { XDG_CONFIG_HOME: path.join(w.base, "cfg"), ...env });
  },
};

for (const [name, start] of Object.entries(shells)) {
  const shell = name === "gitbash" ? "bash" : name;
  const skip = !posix || !PYTHON || !has(shell) ? `${shell} or python pty not available` : false;
  const flavor = name === "gitbash" ? "bash" : name;

  test(`${name}: the note is found in the baked dir, the call gets it, and the shell's environment stays without it`, { skip }, (t) => {
    const w = world(flavor, name);
    t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
    const r = start(w);
    assert.equal(r.marker.length, 1, r.out);
    assert.match(r.marker[0], /^dir=.* args=pane-resume --shell-pid \d+$/);
    assert.equal(r.marker[0].startsWith(`dir=${w.agentDir} `), true, r.marker[0]);
    assert.match(r.out, /AFTER=unset/, "no PI_CODING_AGENT_DIR left in the shell");
  });

  test(`${name}: a PI_CODING_AGENT_DIR set in the shell still wins, for the lookup and for the call; no note there, no call`, { skip }, (t) => {
    const w = world(flavor, name);
    t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
    const other = path.join(w.base, "other dir");
    fs.mkdirSync(path.join(other, "pi-foreman", "state", "panes"), { recursive: true });
    const none = start(w, { PI_CODING_AGENT_DIR: other });
    assert.deepEqual(none.marker, [], "the shell's dir has no note: the baked dir is not consulted");
    fs.writeFileSync(path.join(other, "pi-foreman", "state", "panes", "t1.json"), "{}");
    const r = start(w, { PI_CODING_AGENT_DIR: other });
    assert.equal(r.marker.length, 1, r.out);
    assert.equal(r.marker[0].startsWith(`dir=${other} `), true, r.marker[0]);
  });
}

// Windows only: the block run by PowerShell with a fake node.cmd that logs the variable; the session's value is back after the call.
const win = process.platform === "win32";
const psHas = (exe) => win && spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "1"], { encoding: "utf8" }).status === 0;
for (const exe of ["pwsh", "powershell"].filter(psHas)) {
  test(`${exe}: the call gets the baked dir (space and quote in the path), the session variable is restored or removed afterwards`, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-pwsh-custom-")));
    try {
      const bin = path.join(base, "bin");
      fs.mkdirSync(bin);
      const log = path.join(base, "calls.log");
      fs.writeFileSync(path.join(bin, "node.cmd"), ["@echo off", "if \"%~1\"==\"--version\" (echo v22.6.0& exit /b 0)", "echo dir=%PI_CODING_AGENT_DIR%>> \"%PF_LOG%\"", "exit /b 0", ""].join("\r\n"));
      const cli = path.join(base, "paneresume-cli.ts");
      fs.writeFileSync(cli, "// fake\n");
      const agentDir = path.join(base, "my agent", "it's here");
      fs.mkdirSync(path.join(agentDir, "pi-foreman", "state", "panes"), { recursive: true });
      fs.writeFileSync(path.join(agentDir, "pi-foreman", "state", "panes", "t1.json"), "{}");
      const BOM = String.fromCharCode(0xfeff);
      const blockFile = path.join(base, "block.ps1");
      fs.writeFileSync(blockFile, `${BOM}${renderResumeBlock({ bin: path.join(bin, "foreman"), flavor: "powershell", cli, agentDir })}\r\n`);
      const script = path.join(base, "case.ps1");
      fs.writeFileSync(script, `${BOM}${["function prompt { 'ORIG> ' }", ". $env:PF_BLOCK", "function __PiForemanResume { __PiForemanResumeCheck }", "$null = prompt", "Write-Output ('after=' + [string]$env:PI_CODING_AGENT_DIR)"].join("\r\n")}\r\n`);
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t1", TEMP: base, TMP: base, PF_LOG: log, PF_BLOCK: blockFile };
      delete env.PI_CODING_AGENT_DIR;
      const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", input: "", timeout: 90_000, env });
      assert.match(r.stdout, /after=\r?\n/, `${r.stdout}${r.stderr}`);
      assert.equal(fs.readFileSync(log, "utf8").trim(), `dir=${agentDir}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}
