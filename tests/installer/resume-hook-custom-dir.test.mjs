// D34: with a custom agent dir `foreman setup` writes the resume block (it used to print a hand-add line). The block bakes the dir in as the fallback of the
// note lookup and hands it to pane-resume for that one call only. The default agent dir renders the block of before. Temp homes only: PI_FOREMAN_HOME or
// HOME/USERPROFILE point at a temp dir, so no real startup file is touched. The rendered blocks run in real shells in resume-hook-custom-dir-shells.test.mjs.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import "./_sandbox-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const BIN = path.join(ROOT, "bin", "foreman");
const { RESUME_START, RESUME_END, applyResumeHook, renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

const ODD = "/tmp/my agent/it's here";

function fresh(agentName = "agent") {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-custom-")));
  const agentDir = path.join(base, agentName);
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  for (const d of [agentDir, cwd, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, agentDir, cwd, home, log: `${base}-calls.jsonl` };
}

function run(env, args, extra = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env, CI: "1", PI_FOREMAN_PICKER: "off", PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log,
      PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-models"), PI_FOREMAN_HOME: env.home, SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "linux", PI_BG_FEATURES: undefined, ...extra,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const count = (text) => text.split(RESUME_START).length - 1;
const read = (f) => fs.readFileSync(f, "utf8");
// The literals the product writes: POSIX single quotes (`'` -> `'\''`), and fish single quotes where `\` is escaped too (fq in setup/resume-hook.mjs).
const sh = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
const fish = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

test("setup with a custom agent dir writes the block into ~/.zshrc, once, with the dir as the fallback and for the call only", () => {
  const env = fresh();
  const r = run(env, ["--no-addons"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /custom agent dir, your shell startup files are left alone/);
  assert.match(r.out, /wrote the pi-foreman resume block to .*\.zshrc/);
  const text = read(path.join(env.home, ".zshrc"));
  assert.equal(count(text), 1);
  assert.ok(text.includes(sh(env.agentDir)), "the dir is baked in");
  assert.ok(text.includes(`PI_CODING_AGENT_DIR="$__pi_foreman_agent" '${BIN}' pane-resume`), "a prefix assignment on the call");
  assert.doesNotMatch(text, /export PI_CODING_AGENT_DIR/);
  const again = run(env, ["--no-addons"]);
  assert.match(again.out, /resume hook: already in/);
  assert.equal(read(path.join(env.home, ".zshrc")), text);
});

test("setup with the default agent dir under PI_FOREMAN_HOME renders the block of before (no baked dir)", () => {
  const env = fresh();
  const def = path.join(env.home, ".pi", "agent");
  fs.mkdirSync(def, { recursive: true });
  fs.copyFileSync(path.join(env.agentDir, "settings.json"), path.join(def, "settings.json"));
  const r = run({ ...env, agentDir: def }, ["--no-addons"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(path.join(env.home, ".zshrc")).includes(renderResumeBlock({ bin: BIN, flavor: "zsh" })), true);
});

test("a rerun replaces a hand-written block with the same markers: exactly one block", () => {
  const env = fresh();
  const rc = path.join(env.home, ".zshrc");
  fs.writeFileSync(rc, `alias x=y\n\n${RESUME_START}\n# hand-written\n${RESUME_END}\nalias z=w\n`);
  const r = run(env, ["--no-addons"]);
  assert.equal(r.code, 0, r.out);
  const text = read(rc);
  assert.equal(count(text), 1);
  assert.equal(text.includes("# hand-written"), false);
  assert.ok(text.includes(sh(env.agentDir)));
  assert.ok(text.startsWith("alias x=y\n") && text.trimEnd().endsWith("alias z=w"));
});

test("--no-resume-hook and --remove delete the block for a custom agent dir", () => {
  const env = fresh();
  const rc = path.join(env.home, ".zshrc");
  fs.writeFileSync(rc, "alias x=y\n");
  assert.equal(run(env, ["--no-addons"]).code, 0);
  assert.equal(count(read(rc)), 1);
  const off = run(env, ["--no-addons", "--no-resume-hook"]);
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /removed the pi-foreman block from .*\.zshrc/);
  assert.equal(count(read(rc)), 0);
  assert.equal(run(env, ["--no-addons"]).code, 0);
  assert.equal(count(read(rc)), 1);
  const rm = run(env, ["--remove"]);
  assert.equal(rm.code, 0, rm.out);
  assert.equal(count(read(rc)), 0);
});

test("a dry run with a custom agent dir writes nothing; --no-env still prints the hand-add line", () => {
  const dry = fresh();
  const d = run(dry, ["--dry-run", "--no-addons"]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /would write the pi-foreman resume block to .*\.zshrc/);
  assert.deepEqual(fs.readdirSync(dry.home), []);
  const noEnv = fresh();
  assert.match(run(noEnv, ["--no-addons", "--no-env"]).out, /resume hook: not written \(--no-env\)/);
  assert.deepEqual(fs.readdirSync(noEnv.home), []);
});

test("setup with a custom agent dir and HOME (no PI_FOREMAN_HOME) writes the block under HOME; fish gets its own file", () => {
  const env = fresh();
  const r = run(env, ["--no-addons"], { PI_FOREMAN_HOME: undefined, HOME: env.home, USERPROFILE: env.home, SHELL: "/usr/bin/fish" });
  assert.equal(r.code, 0, r.out);
  const file = path.join(env.home, ".config", "fish", "conf.d", "pi-foreman-resume.fish");
  assert.equal(count(read(file)), 1);
  assert.ok(read(file).includes(`set -l dir ${fish(env.agentDir)}`));
});

test("guard: the setup child env of these tests points PI_FOREMAN_HOME at a temp dir, never the real home", () => {
  const tmp = fs.realpathSync(os.tmpdir());
  const home = process.env.PI_FOREMAN_HOME;
  assert.ok(home, "PI_FOREMAN_HOME is set by the preload or the shared sandbox module");
  assert.ok(path.resolve(home).startsWith(tmp + path.sep), home);
  assert.notEqual(path.resolve(home), path.resolve(os.homedir()));
  const env = fresh();
  const r = spawnSync(process.execPath, [SETUP, "--no-addons", "--agent-dir", env.agentDir], {
    cwd: env.cwd, encoding: "utf8", input: "",
    env: { ...process.env, HOME: env.home, USERPROFILE: env.home, CI: "1", PI_FOREMAN_PICKER: "off", PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-models"), SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "linux", PI_BG_FEATURES: undefined },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepEqual(fs.readdirSync(env.home), [], "nothing lands in HOME while PI_FOREMAN_HOME is set");
  assert.equal(count(read(path.join(home, ".zshrc"))), 1);
});

test("the zsh and bash blocks: the fallback dir and the call-only assignment, paths with spaces and a single quote quoted", () => {
  for (const flavor of ["zsh", "bash"]) {
    const block = renderResumeBlock({ bin: "/opt/f oo/foreman", flavor, agentDir: ODD });
    assert.ok(block.startsWith(RESUME_START) && block.endsWith(RESUME_END), flavor);
    assert.ok(block.includes(`__pi_foreman_agent='/tmp/my agent/it'\\''s here'`), flavor);
    assert.ok(block.includes(`PI_CODING_AGENT_DIR="$__pi_foreman_agent" '/opt/f oo/foreman' pane-resume --shell-pid "$$"`), flavor);
    assert.doesNotMatch(block, /export |\$HOME\/\.pi\/agent/, flavor);
  }
});

test("the fish block: single-quoted dir with fish escapes, a shell value still wins, env sets the variable for the call only", () => {
  const block = renderResumeBlock({ bin: "/opt/f oo/foreman", flavor: "fish", agentDir: "/tmp/my agent/it's\\here" });
  assert.ok(block.includes("set -l dir '/tmp/my agent/it\\'s\\\\here'"));
  const win = renderResumeBlock({ bin: "/opt/f oo/foreman", flavor: "fish", agentDir: "C:\\Users\\me\\my agent" });
  assert.ok(win.includes("set -l dir 'C:\\\\Users\\\\me\\\\my agent'"), "a Windows dir: each backslash doubled");
  assert.ok(block.includes("test -n \"$PI_CODING_AGENT_DIR\"; and set dir $PI_CODING_AGENT_DIR"));
  assert.ok(block.includes("env PI_CODING_AGENT_DIR=$dir '/opt/f oo/foreman' pane-resume --shell-pid $fish_pid"));
  assert.doesNotMatch(block, /set -[gx]+ PI_CODING_AGENT_DIR/);
});

test("the gitbash block: the baked Windows path goes through cygpath for the note, the call gets the Windows form", () => {
  const block = renderResumeBlock({ bin: "C:\\Program Files\\pf\\bin\\foreman", flavor: "gitbash", agentDir: "C:\\Users\\O'Neil\\my agent" });
  assert.ok(block.includes("__pi_foreman_agent='C:\\Users\\O'\\''Neil\\my agent'"));
  assert.ok(block.includes("cygpath -u \"$__pi_foreman_agent\""));
  assert.ok(block.includes("PI_CODING_AGENT_DIR=\"$__pi_foreman_agent\" 'C:/Program Files/pf/bin/foreman' pane-resume --shell-pid \"$(cat /proc/$$/winpid 2>/dev/null || echo $$)\""));
});

test("the powershell block: the baked dir is the fallback, $env:PI_CODING_AGENT_DIR is set only around Start-Process and restored in finally", () => {
  const block = renderResumeBlock({ bin: "C:\\pf\\bin\\foreman", flavor: "powershell", cli: "C:\\pf\\paneresume-cli.ts", agentDir: "C:\\Users\\O'Neil\\my agent" });
  assert.ok(block.includes("else { 'C:\\Users\\O''Neil\\my agent' }"));
  const lines = block.split("\n");
  const set = lines.findIndex((l) => l.includes("$env:PI_CODING_AGENT_DIR = $dir"));
  const start = lines.findIndex((l) => l.includes("Start-Process"));
  const fin = lines.findIndex((l) => l.includes("finally"));
  const restore = lines.findIndex((l) => l.includes("$env:PI_CODING_AGENT_DIR = $prevDir"));
  assert.ok(set > 0 && set < start && start < fin && fin < restore, "set, Start-Process, finally, restore");
  assert.ok(lines[fin - 1].trim() === "}" || lines[fin].includes("} finally {"));
  assert.ok(lines.some((l) => l.includes("Remove-Item Env:PI_CODING_AGENT_DIR")), "an absent value is restored to absent");
});

test("without agentDir every flavor renders exactly as before; the powershell profile with a custom dir is written and removed", () => {
  for (const flavor of ["zsh", "bash", "fish", "gitbash", "powershell"]) {
    assert.equal(renderResumeBlock({ bin: "/o/foreman", flavor, cli: "/o/cli.ts" }), renderResumeBlock({ bin: "/o/foreman", flavor, cli: "/o/cli.ts", agentDir: null }), flavor);
    const old = renderResumeBlock({ bin: "/o/foreman", flavor, cli: "/o/cli.ts" });
    const lines = {
      zsh: ['__pi_foreman_note="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-foreman/state/panes/$HC_TERMINAL_ID.json"', `'/o/foreman' pane-resume --shell-pid "$$"`],
      bash: ['__pi_foreman_note="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-foreman/state/panes/$HC_TERMINAL_ID.json"', `'/o/foreman' pane-resume --shell-pid "$$"`],
      fish: ["set -l dir $HOME/.pi/agent", "'/o/foreman' pane-resume --shell-pid $fish_pid"],
      gitbash: ['${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/pi-foreman/state/panes/$HC_TERMINAL_ID.json"', `'/o/foreman' pane-resume --shell-pid "$(cat /proc/$$/winpid 2>/dev/null || echo $$)"`],
      powershell: ["Join-Path $HOME '.pi\\agent'", `'--no-warnings --experimental-strip-types "' + $cli + '" --shell-pid ' + $PID`],
    }[flavor];
    for (const line of lines) assert.ok(old.includes(line), `${flavor}: ${line}`);
    assert.doesNotMatch(renderResumeBlock({ bin: "/o/foreman", flavor, cli: "/o/cli.ts" }), /prevDir|__pi_foreman_agent|env PI_CODING_AGENT_DIR=/, flavor);
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-custom-unit-"));
  const opts = { home, bin: "C:\\pf\\bin\\foreman", cli: "C:\\pf\\paneresume-cli.ts", platform: "win32", editions: ["pwsh"], agentDir: "C:\\my agent\\it's" };
  const dry = applyResumeHook({ ...opts, dry: true });
  assert.match(dry[0], /would write/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(applyResumeHook(opts)[0], /wrote the pi-foreman resume block/);
  const file = path.join(home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  assert.ok(read(file).includes("'C:\\my agent\\it''s'"));
  assert.match(applyResumeHook({ ...opts, remove: true })[0], /removed the pi-foreman block/);
  assert.equal(read(file).includes(RESUME_START), false);
});
