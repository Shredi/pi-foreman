// windowsResumeContext().gitBash: a scoop Git install is found through GIT_INSTALL_ROOT or the `shellPath` setting, without Git on PATH or in Program Files.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { windowsResumeContext } = await import(pathToFileURL(path.join(ROOT, "setup.mjs")).href);

const base = { PI_FOREMAN_HOME: "x", PI_FOREMAN_TEST_PS_EDITIONS: "powershell" };
const setup = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-detect-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(dir, "git", "bin"), { recursive: true });
  const bash = path.join(dir, "git", "bin", "bash.exe");
  fs.writeFileSync(bash, "");
  return { dir, home, bash };
};

test("GIT_INSTALL_ROOT alone (name matched case-insensitively) means Git Bash is there", () => {
  const { dir, home } = setup();
  try {
    assert.equal(windowsResumeContext(home, { env: { ...base, git_install_root: path.join(dir, "git") } }).gitBash, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a shellPath naming an existing file alone means Git Bash is there", () => {
  const { dir, home, bash } = setup();
  try {
    assert.equal(windowsResumeContext(home, { env: base, shellPath: bash }).gitBash, true);
    assert.equal(windowsResumeContext(home, { env: base, shellPath: path.join(dir, "missing.exe") }).gitBash, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("neither, and no .bashrc: no Git Bash", () => {
  const { dir, home } = setup();
  try {
    assert.equal(windowsResumeContext(home, { env: { ...base, GIT_INSTALL_ROOT: path.join(dir, "nowhere") } }).gitBash, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
