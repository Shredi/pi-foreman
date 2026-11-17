// The resume block (setup/resume-hook.mjs, docs/install.md): written per shell and file rule under the guard of the env block, replaced on a
// re-run, taken out by --no-resume-hook and --remove; a dry run, win32 and --no-env write none (a custom agent dir: resume-hook-custom-dir.test.mjs). Temp homes only.
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
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const BIN = path.join(ROOT, "bin", "foreman");
const { RESUME_START, RESUME_END, applyResumeHook, renderResumeBlock, resumeTargets, stripResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-hook-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  const home = path.join(base, "home");
  for (const d of [agentDir, cwd, home]) fs.mkdirSync(d);
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
const FISH = (home) => path.join(home, ".config", "fish", "conf.d", "pi-foreman-resume.fish");

test("zsh: the block goes into ~/.zshrc once, next to the env block, with the absolute bin/foreman; a re-run leaves it byte-identical", () => {
  const env = fresh();
  fs.writeFileSync(path.join(env.home, ".zshrc"), "alias x=y\n");
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  const text = read(path.join(env.home, ".zshrc"));
  assert.ok(text.startsWith("alias x=y\n"));
  assert.equal(count(text), 1);
  assert.ok(text.includes(`'${BIN}' pane-resume --shell-pid`));
  assert.ok(text.includes("add-zsh-hook precmd __pi_foreman_resume"));
  assert.match(text, /export PI_BG_FEATURES=/, "the env block is still there");
  assert.match(r.out, /wrote the pi-foreman resume block to .*\.zshrc/);
  const again = run(env, [], { PI_BG_FEATURES: "process" });
  assert.equal(again.code, 0, again.out);
  assert.equal(read(path.join(env.home, ".zshrc")), text);
  assert.match(again.out, /resume hook: already in/);
});

test("a changed block is replaced in place on a re-run; text around it stays", () => {
  const env = fresh();
  const rc = path.join(env.home, ".zshrc");
  assert.equal(run(env, ["--no-addons"]).code, 0);
  const good = read(rc);
  fs.writeFileSync(rc, `before\n${good.replace(/__pi_foreman_resume_ran/g, "stale")}after\n`);
  assert.equal(run(env, ["--no-addons"]).code, 0);
  const text = read(rc);
  assert.equal(count(text), 1);
  assert.ok(!text.includes("stale"));
  assert.ok(text.startsWith("before\n") && text.endsWith("after\n"));
});

test("the block is written without add-ons (--no-addons)", () => {
  const env = fresh();
  assert.equal(run(env, ["--no-addons"]).code, 0);
  const text = read(path.join(env.home, ".zshrc"));
  assert.equal(count(text), 1);
  assert.ok(!text.includes("PI_BG_FEATURES"));
});

test("bash: ~/.bashrc, and the first existing of .bash_profile, .bash_login, .profile", () => {
  const only = fresh();
  assert.equal(run(only, ["--no-addons"], { SHELL: "/bin/bash" }).code, 0);
  assert.equal(count(read(path.join(only.home, ".bashrc"))), 1);
  for (const f of [".bash_profile", ".bash_login", ".profile"]) assert.equal(fs.existsSync(path.join(only.home, f)), false, f);
  const env = fresh();
  fs.writeFileSync(path.join(env.home, ".bash_login"), "# login\n");
  fs.writeFileSync(path.join(env.home, ".profile"), "# profile\n");
  assert.equal(run(env, ["--no-addons"], { SHELL: "/bin/bash" }).code, 0);
  assert.equal(count(read(path.join(env.home, ".bashrc"))), 1);
  assert.equal(count(read(path.join(env.home, ".bash_login"))), 1);
  assert.equal(read(path.join(env.home, ".profile")), "# profile\n", "only the first login file");
  assert.equal(fs.existsSync(path.join(env.home, ".bash_profile")), false);
  assert.ok(read(path.join(env.home, ".bashrc")).includes('if [ -n "${BASH_VERSION:-}" ]; then'));
});

test("fish: one function file in conf.d; a shell that is none of zsh, bash, fish gets a line and no file", () => {
  const env = fresh();
  assert.equal(run(env, ["--no-addons"], { SHELL: "/usr/bin/fish" }).code, 0);
  const text = read(FISH(env.home));
  assert.equal(count(text), 1);
  assert.ok(text.includes("--on-event fish_prompt"));
  const other = fresh();
  const r = run(other, ["--no-addons"], { SHELL: "/bin/tcsh" });
  assert.match(r.out, /resume hook: shell tcsh is not zsh, bash or fish; add the block by hand \(docs\/install\.md\)/);
  assert.deepEqual(fs.readdirSync(other.home), []);
});

test("--no-resume-hook writes no block and removes an existing one; --remove removes it; the env block stays on --no-resume-hook", () => {
  const env = fresh();
  const rc = path.join(env.home, ".zshrc");
  assert.equal(run(env, []).code, 0);
  assert.equal(count(read(rc)), 1);
  const r = run(env, ["--no-resume-hook"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(count(read(rc)), 0);
  assert.match(r.out, /removed the pi-foreman block from .*\.zshrc/);
  assert.match(read(rc), /PI_BG_FEATURES/, "the env block stays");
  const fresh2 = fresh();
  assert.equal(run(fresh2, ["--no-resume-hook"]).code, 0);
  assert.equal(count(fs.existsSync(path.join(fresh2.home, ".zshrc")) ? read(path.join(fresh2.home, ".zshrc")) : ""), 0, "never written");
  const rm = fresh();
  const rmRc = path.join(rm.home, ".zshrc");
  assert.equal(run(rm, []).code, 0);
  assert.equal(count(read(rmRc)), 1);
  const gone = run(rm, ["--remove"]);
  assert.equal(gone.code, 0, gone.out);
  assert.equal(count(read(rmRc)), 0);
  const f = fresh();
  assert.equal(run(f, ["--no-addons"], { SHELL: "/usr/bin/fish" }).code, 0);
  assert.equal(run(f, ["--no-resume-hook"], { SHELL: "/usr/bin/fish" }).code, 0);
  assert.equal(fs.existsSync(FISH(f.home)), false, "a fish file that held only the block is deleted");
});

test("a dry run and --no-env write no block; --no-env prints the hand-add line", () => {
  const dry = fresh();
  const r = run(dry, ["--dry-run", "--no-addons"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /would write the pi-foreman resume block to .*\.zshrc/);
  assert.deepEqual(fs.readdirSync(dry.home), []);
  const custom = fresh();
  const c = run(custom, ["--no-addons"], { PI_FOREMAN_HOME: undefined, HOME: custom.home, USERPROFILE: custom.home });
  assert.match(c.out, /wrote the pi-foreman resume block to .*\.zshrc/, "a custom agent dir writes the block now (D34)");
  assert.ok(read(path.join(custom.home, ".zshrc")).includes(`'${custom.agentDir}'`));
  const noEnv = fresh();
  const n = run(noEnv, ["--no-addons", "--no-env"]);
  assert.match(n.out, /resume hook: not written \(--no-env\); .*docs\/install\.md/);
  assert.deepEqual(fs.readdirSync(noEnv.home), []);
});

test("--no-resume-hook is in the usage text", () => {
  const r = spawnSync(process.execPath, [SETUP, "--help"], { encoding: "utf8", env: { ...process.env, CI: "1" } });
  assert.match(`${r.stdout}${r.stderr}`, /--no-resume-hook/);
});

test("resumeTargets, stripResumeBlock and applyResumeHook over a temp home (dry run, remove, a block that is not there)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-unit-"));
  assert.deepEqual(resumeTargets({ home, shell: "/bin/zsh" }).map((t) => path.basename(t.file)), [".zshrc"]);
  assert.deepEqual(resumeTargets({ home, shell: "/bin/sh" }), []);
  assert.deepEqual(resumeTargets({ home, shell: "" }), []);
  const bin = "/opt/it's/foreman";
  for (const flavor of ["zsh", "bash", "fish"]) {
    const block = renderResumeBlock({ bin, flavor });
    assert.ok(block.startsWith(RESUME_START) && block.endsWith(RESUME_END), flavor);
    assert.ok(block.includes(`'/opt/it'\\''s/foreman'`), `${flavor}: the path is single-quoted`);
    assert.equal(stripResumeBlock(`a\n\n${block}\n`), "a\n", flavor);
  }
  assert.equal(stripResumeBlock("no block\n"), "no block\n");
  assert.deepEqual(applyResumeHook({ home, shell: "/bin/zsh", bin, remove: true }), []);
  assert.equal(fs.existsSync(path.join(home, ".zshrc")), false);
  assert.match(applyResumeHook({ home, shell: "/bin/zsh", bin, dry: true })[0], /would write/);
  assert.equal(fs.existsSync(path.join(home, ".zshrc")), false);
  applyResumeHook({ home, shell: "/bin/zsh", bin });
  assert.match(applyResumeHook({ home, shell: "/bin/zsh", bin, dry: true, remove: true })[0], /would remove/);
  assert.equal(count(read(path.join(home, ".zshrc"))), 1);
  fs.rmSync(home, { recursive: true, force: true });
});
