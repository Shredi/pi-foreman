// The Git Bash resume block run in Git Bash itself (Windows only; skipped elsewhere and when Git Bash is not installed): the block parses, sourcing it
// keeps `$?` and starts nothing without a terminal id or a tty, and the shell can read its Windows pid from /proc/$$/winpid. The tty path (the countdown,
// key reading under mintty) has no pty on a CI runner and is covered by the live test noted in docs/herdr.md.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);
const { findGitBash } = await import(pathToFileURL(path.join(ROOT, "setup.mjs")).href);
const win = process.platform === "win32";
const bash = win ? findGitBash() : null;
const skip = !bash;

const sh = (args, extra = {}) => spawnSync(bash, args, { encoding: "utf8", input: "", timeout: 60_000, env: { ...process.env, ...extra } });

test("the gitbash block parses (bash -n)", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-"));
  const file = path.join(dir, "block.sh");
  fs.writeFileSync(file, `${renderResumeBlock({ bin: path.join(dir, "bin", "foreman"), flavor: "gitbash" })}\n`);
  const r = sh(["-n", file.replace(/\\/g, "/")]);
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sourced: with no HC_TERMINAL_ID, and with one but no tty and no note, $? is kept and nothing starts", { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-gitbash-"));
  const log = path.join(dir, "calls.log").replace(/\\/g, "/");
  const fake = path.join(dir, "foreman").replace(/\\/g, "/");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  const file = path.join(dir, "block.sh");
  fs.writeFileSync(file, `${renderResumeBlock({ bin: fake, flavor: "gitbash" })}\n`);
  const script = `source '${file.replace(/\\/g, "/")}'; false; __pi_foreman_resume; echo rc=$?`;
  const a = sh(["-c", script], { HC_TERMINAL_ID: "" });
  assert.match(a.stdout, /rc=1/, a.stderr);
  const agent = path.join(dir, "agent");
  fs.mkdirSync(path.join(agent, "pi-foreman", "state", "panes"), { recursive: true });
  const b = sh(["-c", script], { HC_TERMINAL_ID: "t1", PI_CODING_AGENT_DIR: agent });
  assert.match(b.stdout, /rc=1/, b.stderr);
  fs.writeFileSync(path.join(agent, "pi-foreman", "state", "panes", "t1.json"), "{}");
  const c = sh(["-c", script], { HC_TERMINAL_ID: "t1", PI_CODING_AGENT_DIR: agent });
  assert.match(c.stdout, /rc=1/, c.stderr);
  assert.equal(fs.existsSync(log), false, "no tty: the command was not started");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Git Bash gives its Windows pid through /proc/$$/winpid", { skip }, () => {
  const r = sh(["-c", "cat /proc/$$/winpid"]);
  assert.match(r.stdout.trim(), /^\d+$/, r.stderr);
});
