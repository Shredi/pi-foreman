// The resume block run by real shells (skipped for a shell, or the pseudo terminal helper, that is not installed): at an interactive shell's
// first prompt it runs `foreman pane-resume --shell-pid <pid>` only with HC_TERMINAL_ID set, a pane note and an executable bin/foreman.
// The foreman command here is a stub that records its arguments; no node process starts.
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

const has = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0 || spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const PYTHON = ["python3", "python"].find((p) => spawnSync(p, ["-c", "import pty"], { encoding: "utf8" }).status === 0);
const posix = process.platform !== "win32";

function world(flavor, { note = true, bin = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hook-sh-")));
  const marker = path.join(base, "marker");
  const stub = path.join(base, "foreman");
  if (bin) fs.writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 });
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(path.join(agentDir, "pi-foreman", "state", "panes"), { recursive: true });
  if (note) fs.writeFileSync(path.join(agentDir, "pi-foreman", "state", "panes", "t1.json"), "{}");
  const rc = path.join(base, "rc");
  fs.writeFileSync(rc, `${renderResumeBlock({ bin: stub, flavor })}\n`);
  return { base, marker, stub, agentDir, rc };
}

function interactive(w, argv, input, env = {}) {
  const r = spawnSync(PYTHON, ["-I", PTY, input, ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: w.base, TERM: "dumb", PI_CODING_AGENT_DIR: w.agentDir, HC_TERMINAL_ID: "t1", TMPDIR: w.base, XDG_RUNTIME_DIR: "", ...env },
  });
  return { out: r.stdout, marker: fs.existsSync(w.marker) ? fs.readFileSync(w.marker, "utf8").trim().split("\n") : [] };
}

const shells = {
  bash: (w, env) => interactive(w, ["bash", "--noprofile", "--rcfile", w.rc, "-i"], "true\nexit\n", env),
  zsh: (w, env) => {
    fs.copyFileSync(w.rc, path.join(w.base, ".zshrc"));
    return interactive(w, ["zsh", "-i"], "true\nexit\n", { ZDOTDIR: w.base, ...env });
  },
  fish: (w, env) => {
    const dir = path.join(w.base, "cfg", "fish", "conf.d");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(w.rc, path.join(dir, "pi-foreman-resume.fish"));
    return interactive(w, ["fish", "-i"], "true\nexit\n", { XDG_CONFIG_HOME: path.join(w.base, "cfg"), ...env });
  },
};

for (const [name, start] of Object.entries(shells)) {
  const skip = !posix || !PYTHON || !has(name) ? `${name} or python pty not available` : false;
  const flavor = name;

  test(`${name}: a note, HC_TERMINAL_ID and an executable bin/foreman run pane-resume with the shell pid, once`, { skip }, (t) => {
    const w = world(flavor);
    t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
    const r = start(w);
    assert.equal(r.marker.length, 1, r.out);
    assert.match(r.marker[0], /^pane-resume --shell-pid \d+$/);
  });

  test(`${name}: no HC_TERMINAL_ID, no note, or a missing bin/foreman: nothing runs and nothing is printed`, { skip }, (t) => {
    const cases = [
      [world(flavor), { HC_TERMINAL_ID: "" }],
      [world(flavor, { note: false }), {}],
      [world(flavor, { bin: false }), {}],
      [world(flavor), { HC_TERMINAL_ID: "t2" }],
    ];
    for (const [w, env] of cases) {
      t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
      const r = start(w, env);
      assert.deepEqual(r.marker, []);
      assert.doesNotMatch(r.out, /pane-resume|foreman|No such file|not found/i);
    }
  });
}

test("bash: a non-interactive shell does not run the command even when called", { skip: !posix || !has("bash") }, (t) => {
  const w = world("bash");
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const r = spawnSync("bash", ["-c", `. '${w.rc}'; __pi_foreman_resume; true`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: w.base, PI_CODING_AGENT_DIR: w.agentDir, HC_TERMINAL_ID: "t1" } });
  assert.equal(r.status, 0);
  assert.equal(`${r.stdout}${r.stderr}`, "");
  assert.equal(fs.existsSync(w.marker), false);
});

test("bash: the block sourced twice, and again after PROMPT_COMMAND was reset, registers the function once each time", { skip: !posix || !has("bash") }, (t) => {
  const w = world("bash");
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  const pc = (script) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: w.base } }).stdout;
  const times = (s) => s.split("__pi_foreman_resume").length - 1;
  assert.equal(times(pc(`. '${w.rc}'; . '${w.rc}'; printf %s "$PROMPT_COMMAND"`)), 1);
  const reset = pc(`. '${w.rc}'; PROMPT_COMMAND='echo x'; . '${w.rc}'; . '${w.rc}'; printf %s "$PROMPT_COMMAND"`);
  assert.equal(times(reset), 1);
  assert.match(reset, /echo x/, "the later content is kept");
});

for (const shname of ["sh", "dash"]) test(`${shname}: the bash block parses as POSIX and its body does nothing when BASH_VERSION is unset`, { skip: !posix || !has(shname) }, (t) => {
  const w = world("bash");
  t.after(() => fs.rmSync(w.base, { recursive: true, force: true }));
  assert.equal(spawnSync(shname, ["-n", w.rc]).status, 0, `${shname} -n parses the block`);
  const env = { PATH: process.env.PATH, HOME: w.base, PI_CODING_AGENT_DIR: w.agentDir, HC_TERMINAL_ID: "t1" };
  const sh = spawnSync(shname, ["-c", `printf %s "\${BASH_VERSION:-}"`], { encoding: "utf8", env }).stdout;
  if (sh) return t.skip("this sh is bash (it sets BASH_VERSION), so the body runs by design");
  const r = spawnSync(shname, ["-c", `. '${w.rc}'; printf %s "\${PROMPT_COMMAND:-unset}"; type __pi_foreman_resume >/dev/null 2>&1 && echo defined`], { encoding: "utf8", env });
  assert.equal(r.stdout, "unset");
});
