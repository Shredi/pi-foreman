// Windows: setup writes Pi's `shellPath` to Git Bash when unset, keeps a set value, and fails (after the other steps) when Git Bash is missing.
// Everything runs in a temp agent dir; the platform is faked with PI_FOREMAN_GITBASH_PLATFORM and Git Bash is placed under a temp ProgramFiles.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findGitBash } from "../../setup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.join(fs.realpathSync(path.resolve(HERE, "..", "..")), "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

/** The value of an env name, matched case-insensitively (Windows env names are). */
const envValue = (env, name) => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
};

/** PATH without the folders that hold a bash.exe; each entry is read as findGitBash reads it (trimmed, surrounding double quotes stripped). */
const noBashOnPath = (env = process.env) =>
  (envValue(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && !fs.existsSync(path.join(d, "bash.exe")))
    .join(path.delimiter);

/** A child env: a copy of `base` where each override replaces every key that equals its name case-insensitively, so one name never appears twice. */
function childEnv(base, overrides) {
  const env = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    for (const key of Object.keys(env)) if (key.toLowerCase() === name.toLowerCase()) delete env[key];
    env[name] = value;
  }
  return env;
}

/** The env for a setup child in a temp tree: no bash.exe on PATH, the temp ProgramFiles as the Git Bash search root (the seam), and the fake platform. */
const setupEnv = ({ agentDir, base, programFiles, platform }) =>
  childEnv(process.env, {
    PATH: noBashOnPath(),
    PI_CODING_AGENT_DIR: agentDir,
    PI_FOREMAN_PI_BIN: FAKE_PI,
    FAKE_PI_LOG: `${base}-calls.jsonl`,
    PI_FOREMAN_PI_AI_DATA: EMPTY_DATA,
    PI_FOREMAN_GITBASH_PLATFORM: platform,
    PI_FOREMAN_GITBASH_PROGRAMFILES: programFiles,
  });

/** Runs setup in a fresh temp tree. `userSettings`/`projectSettings` are objects; `bash` places a Git Bash under the temp ProgramFiles. */
function runSetup({ platform = "win32", bash = true, userSettings = {}, projectSettings = null, args = [] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    const programFiles = path.join(base, "pf");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(programFiles);
    const userFile = path.join(agentDir, "settings.json");
    fs.writeFileSync(userFile, `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"], ...userSettings }, null, 2)}\n`);
    const projectFile = path.join(cwd, ".pi", "settings.json");
    if (projectSettings) fs.writeFileSync(projectFile, `${JSON.stringify(projectSettings, null, 2)}\n`);
    const bashExe = path.join(programFiles, "Git", "bin", "bash.exe");
    if (bash) {
      fs.mkdirSync(path.dirname(bashExe), { recursive: true });
      fs.writeFileSync(bashExe, "");
    }
    const before = fs.readFileSync(userFile, "utf8");
    const r = spawnSync(process.execPath, [SETUP, "--no-addons", ...args, "--agent-dir", agentDir], {
      cwd,
      encoding: "utf8",
      env: setupEnv({ agentDir, base, programFiles, platform }),
    });
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
    return { code: r.status, out: `${r.stdout}${r.stderr}`, bashExe, userFile, before, user: read(userFile), project: read(projectFile) };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("windows: shellPath is written to the found Git Bash when unset, other keys kept, path printed", () => {
  const r = runSetup();
  assert.equal(r.code, 0, r.out);
  const written = JSON.parse(r.user);
  assert.equal(written.shellPath, r.bashExe);
  assert.deepEqual(written.packages, ["git:github.com/Shredi/pi-foreman"]);
  assert.ok(r.out.includes(`wrote shellPath ${r.bashExe}`), r.out);
});

test("windows: a set shellPath stays byte-for-byte and the run says it was kept", () => {
  const r = runSetup({ userSettings: { shellPath: "custom-bash" } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /shellPath already set in .*custom-bash.*kept/);
  assert.equal(JSON.parse(r.user).shellPath, "custom-bash");
  assert.doesNotMatch(r.out, /wrote shellPath/);
});

test("windows: a shellPath in the project settings counts as set and nothing is written", () => {
  const r = runSetup({ projectSettings: { shellPath: "project-bash" } });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.user).shellPath, undefined);
  assert.equal(JSON.parse(r.project).shellPath, "project-bash");
});

test("windows: the project settings file never receives shellPath (--project)", () => {
  const r = runSetup({ projectSettings: { packages: ["git:github.com/Shredi/pi-foreman"] }, args: ["--project"] });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.project).shellPath, undefined);
  assert.equal(JSON.parse(r.user).shellPath, r.bashExe);
});

test("windows: Git Bash missing gives a missing-step line and a non-zero exit after the other steps", () => {
  const r = runSetup({ bash: false });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /missing step: Git Bash not found/);
  assert.match(r.out, /Install Git for Windows/);
  assert.match(r.out, /pi-foreman: (done|up to date)/, "the other steps finished first");
  assert.equal(JSON.parse(r.user).shellPath, undefined);
});

test("windows: the Program Files seam replaces the root, it does not add to it (a Git Bash under another ProgramFiles is not found)", () => {
  // On Windows the OS sets ProgramFiles itself at process creation, so the child may see a real root here. The seam drops every case
  // variant of ProgramFiles and ProgramFiles(x86) before the search, so the real root is never searched and the test holds either way.
  // PATH has no bash.exe (noBashOnPath), and findGitBash searches only the Program Files roots and PATH, so a real Git on the runner
  // cannot satisfy the search either: the assertion holds on a machine with Git for Windows installed.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-seam-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    const seamRoot = path.join(base, "pf");
    const realRoot = path.join(base, "real-pf");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(seamRoot);
    fs.mkdirSync(path.join(realRoot, "Git", "bin"), { recursive: true });
    fs.writeFileSync(path.join(realRoot, "Git", "bin", "bash.exe"), "");
    const userFile = path.join(agentDir, "settings.json");
    fs.writeFileSync(userFile, `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] }, null, 2)}\n`);
    const env = childEnv(setupEnv({ agentDir, base, programFiles: seamRoot, platform: "win32" }), { ProgramFiles: realRoot });
    const r = spawnSync(process.execPath, [SETUP, "--no-addons", "--agent-dir", agentDir], { cwd, encoding: "utf8", env });
    const out = `${r.stdout}${r.stderr}`;
    assert.notEqual(r.status, 0, out);
    assert.match(out, /missing step: Git Bash not found/);
    assert.equal(JSON.parse(fs.readFileSync(userFile, "utf8")).shellPath, undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("windows: Git Bash missing but shellPath set is not a failure", () => {
  const r = runSetup({ bash: false, userSettings: { shellPath: "custom-bash" } });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /missing step/);
});

test("windows: --dry-run writes nothing and says what it would write", () => {
  const r = runSetup({ args: ["--dry-run"] });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.user, r.before);
  assert.match(r.out, /would write shellPath/);
});

test("windows: --remove and --preview write no shellPath", () => {
  for (const args of [["--remove"], ["--preview"]]) {
    const r = runSetup({ args });
    assert.equal(JSON.parse(r.user).shellPath, undefined, args.join(" "));
    assert.doesNotMatch(r.out, /shell:/, args.join(" "));
  }
});

test("non-windows platform: no shellPath written and no shell output, even with no Git Bash", () => {
  for (const bash of [true, false]) {
    const r = runSetup({ platform: "linux", bash });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(r.user).shellPath, undefined);
    assert.doesNotMatch(r.out, /shell:|Git Bash/);
  }
});

test("findGitBash: ProgramFiles first, then ProgramFiles(x86), then PATH; env names match case-insensitively", () => {
  const want = (...hits) => (p) => hits.includes(p);
  const env = { programfiles: "C:\\PF", "PROGRAMFILES(X86)": "C:\\PF86", Path: "C:\\tools;C:\\more" };
  const all = ["C:\\PF\\Git\\bin\\bash.exe", "C:\\PF86\\Git\\bin\\bash.exe", "C:\\tools\\bash.exe"];
  assert.equal(findGitBash({ env, platform: "win32", exists: want(...all) }), all[0]);
  assert.equal(findGitBash({ env, platform: "win32", exists: want(all[1], all[2]) }), all[1]);
  assert.equal(findGitBash({ env, platform: "win32", exists: want(all[2]) }), all[2]);
  assert.equal(findGitBash({ env, platform: "win32", exists: want() }), null);
});

test("findGitBash: the WSL launcher in the Windows directory is skipped", () => {
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\WINDOWS\\System32;C:\\Windows;C:\\Git\\usr\\bin" };
  const exists = (p) => /bash\.exe$/i.test(p);
  assert.equal(findGitBash({ env, platform: "win32", exists }), "C:\\Git\\usr\\bin\\bash.exe");
  assert.equal(findGitBash({ env: { PATH: "C:\\Windows\\System32" }, platform: "win32", exists }), null);
});

test("childEnv: one key per name case-insensitively, with the override values", () => {
  const base = { PROGRAMFILES: "real", "PROGRAMFILES(X86)": "real86", Path: "p" };
  const overrides = { PATH: "q", ProgramFiles: "temp", "ProgramFiles(x86)": "temp86" };
  const env = childEnv(base, overrides);
  for (const name of ["PATH", "ProgramFiles", "ProgramFiles(x86)"]) {
    const keys = Object.keys(env).filter((k) => k.toLowerCase() === name.toLowerCase());
    assert.equal(keys.length, 1, `${name}: ${keys.join(", ")}`);
    assert.equal(env[keys[0]], overrides[name]);
  }
  assert.equal(Object.keys(env).length, 3);
});

test("findGitBash: returns null off Windows", () => {
  assert.equal(findGitBash({ env: { ProgramFiles: "C:\\PF" }, platform: "linux", exists: () => true }), null);
});

test("windows: a dry run after shellPath was removed says would-write, closes as dry run complete, and leaves the file alone", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-dry-")));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    const programFiles = path.join(base, "pf");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.mkdirSync(programFiles);
    const bashExe = path.join(programFiles, "Git", "bin", "bash.exe");
    fs.mkdirSync(path.dirname(bashExe), { recursive: true });
    fs.writeFileSync(bashExe, "");
    const userFile = path.join(agentDir, "settings.json");
    fs.writeFileSync(userFile, `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] }, null, 2)}\n`);
    const env = setupEnv({ agentDir, base, programFiles, platform: "win32" });
    const run = (args) => spawnSync(process.execPath, [SETUP, "--no-addons", ...args, "--agent-dir", agentDir], { cwd, encoding: "utf8", env });
    const first = run([]);
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const settled = JSON.parse(fs.readFileSync(userFile, "utf8"));
    assert.equal(settled.shellPath, bashExe);
    delete settled.shellPath;
    fs.writeFileSync(userFile, `${JSON.stringify(settled, null, 2)}\n`);
    const before = fs.readFileSync(userFile, "utf8");
    const dry = run(["--dry-run"]);
    const out = `${dry.stdout}${dry.stderr}`;
    assert.equal(dry.status, 0, out);
    assert.match(out, /would write shellPath/);
    assert.doesNotMatch(out, /up to date/);
    assert.ok(out.trimEnd().endsWith("pi-foreman: dry run complete, nothing written."), out);
    assert.equal(fs.readFileSync(userFile, "utf8"), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
