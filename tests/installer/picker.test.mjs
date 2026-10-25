import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";

const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-picker-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, agentDir, cwd, log: `${base}-calls.jsonl` };
}

// The picker is forced (stdin is a pipe here) and CI is removed from the environment.
function run(env, args, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SETUP, ...args, "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, CI: undefined, PI_FOREMAN_PICKER: "force", PI_CODING_AGENT_DIR: env.agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA, ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function installs(env) {
  try {
    return fs.readFileSync(env.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).args).filter((a) => a[0] === "install" || a[0] === "remove");
  } catch {
    return [];
  }
}

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

const foremanFile = (env) => path.join(env.agentDir, "foreman.json");
const lines = (...l) => `${l.join("\n")}\n`;

// Prompt order: profile; "Adjust features?"; one flip prompt per area group (tools, models, review, ceremony, retro, ops, ui and the
// safety relaxations; a flip is followed by a second prompt for the same group); one y/N per add-on (polish, background-tasks); apply.
const SESSION = lines("1", "y", "1", "", "", "", "", "", "", "", "", "n", "y", "y");

test("the picker takes a profile, a flipped toggle and an add-on, then applies on confirm", () => {
  const env = fresh();
  const r = run(env, [], SESSION);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Profiles:\n {2}1\) orchestration/);
  assert.match(r.out, /\[x\] 1\) codemode|1\) \[x\] codemode/);
  assert.match(r.out, /safety relaxations:\n {2}WARNING/);
  assert.match(r.out, /Add-on polish: Compact Claude Code-style/);
  assert.match(r.out, /note: PI_BG_FEATURES=process is read when Pi starts/);
  assert.match(r.out, /^--- \/dev\/null/m);
  assert.match(r.out, /would run: pi install npm:pi-background-tasks@2\.6\.10/);
  assert.match(r.out, /equivalent: foreman setup --profile orchestration --disable codemode --addon background-tasks/);
  const cfg = JSON.parse(fs.readFileSync(foremanFile(env), "utf8"));
  assert.equal(cfg.profile, "orchestration");
  assert.equal(cfg.roles.foreman.codemode, false);
  assert.equal(cfg.tools.pr, false);
  assert.deepEqual(installs(env), [["install", "npm:pi-background-tasks@2.6.10"]]);
  assert.match(r.out, /PI_BG_FEATURES=process permanently in your shell profile/);
});

test("the printed equivalent flag line reproduces the same foreman.json", () => {
  const picked = fresh();
  const r = run(picked, [], SESSION);
  assert.equal(r.code, 0, r.out);
  const line = /equivalent: foreman setup (.*)/.exec(r.out)[1];
  const flagged = fresh();
  const f = run(flagged, line.split(" "), "");
  assert.equal(f.code, 0, f.out);
  assert.equal(fs.readFileSync(foremanFile(flagged), "utf8"), fs.readFileSync(foremanFile(picked), "utf8"));
  assert.deepEqual(installs(flagged), installs(picked));
  // the diff shown by the picker is the diff the flag run prints
  const diff = (out) => {
    const all = out.split("\n");
    const start = all.indexOf("+++ b/foreman.json");
    let end = start + 1;
    while (end < all.length && all[end].startsWith("+")) end++;
    return all.slice(start, end).join("\n");
  };
  assert.match(diff(r.out), /^\+\+\+ b\/foreman\.json/);
  assert.equal(diff(f.out), diff(r.out));
});

test("answering no, EOF or an unknown choice then EOF writes nothing", () => {
  for (const input of [lines("1", "n", "n", "n", "n"), lines("2", "n", "n", "n", "n", "n"), lines("1", "y"), "", lines("9")]) {
    const env = fresh();
    const before = snapshot(env.base);
    const r = run(env, [], input);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /nothing written/);
    assert.deepEqual(snapshot(env.base), before);
    assert.deepEqual(installs(env), []);
    assert.equal(fs.existsSync(foremanFile(env)), false);
  }
});

test("the picker opens again with --pick, preselects the recorded profile and keeps it on Enter", () => {
  const env = fresh();
  assert.equal(run(env, ["--profile", "orchestration"], "").code, 0);
  // a recorded profile and no --pick: no picker
  const quiet = run(env, [], "");
  assert.doesNotMatch(quiet.out, /Profiles:/);
  const r = run(env, ["--pick"], lines("", "n", "n", "n", "y"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Profile \[1\]:/);
  assert.match(r.out, /foreman\.json: no change/);
  assert.match(r.out, /equivalent: foreman setup --profile orchestration\n/);
  assert.match(r.out, /foreman\.json: up to date \(profile orchestration\)/);
});

test("PI_FOREMAN_PICKER=off keeps a first run non-interactive", () => {
  const env = fresh();
  const r = run(env, [], lines("1"), { PI_FOREMAN_PICKER: "off" });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Profiles:/);
  assert.match(r.out, /features: no profile chosen yet/);
});
