// tools.prGithubHosts in `foreman setup`: the --github-hosts flag, the host step of both pickers, and the one rule (hostsToWrite) that decides the write.
import { test, after } from "node:test";
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
const PROBE = path.join(HERE, "fixtures", "host-step-probe.mjs");
const FOREMAN = "git:github.com/Shredi/pi-foreman";
const GHE = "ghe.example.test";

const EMPTY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-ai-data-"));
after(() => fs.rmSync(EMPTY_DATA, { recursive: true, force: true }));

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-hosts-")));
  const agentDir = path.join(base, "agent");
  const cwd = path.join(base, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: [FOREMAN] })}\n`);
  return { base, agentDir, cwd, log: `${base}-calls.jsonl` };
}

// Non-interactive unless `picker` is set (then the readline picker is forced and `input` feeds it).
function run(env, args, { input, picker = false } = {}) {
  // add-ons install by default; the non-picker runs here are about hosts, so they opt out
  const r = spawnSync(process.execPath, [SETUP, ...args, ...(picker || args.includes("--addon") ? [] : ["--no-addons"]), "--agent-dir", env.agentDir], {
    cwd: env.cwd,
    encoding: "utf8",
    input,
    env: {
      ...process.env, CI: undefined, PI_FOREMAN_PICKER: picker ? "force" : "off", PI_CODING_AGENT_DIR: env.agentDir,
      PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: env.log, PI_FOREMAN_PI_AI_DATA: EMPTY_DATA,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const foremanFile = (env) => path.join(env.agentDir, "foreman.json");
const userJson = (env) => JSON.parse(fs.readFileSync(foremanFile(env), "utf8"));
const hostsOf = (env) => userJson(env).tools?.prGithubHosts;
const writeUser = (env, cfg) => fs.writeFileSync(foremanFile(env), `${JSON.stringify({ version: 1, providers: {}, ...cfg }, null, 2)}\n`);
const lines = (...l) => `${l.join("\n")}\n`;
const backups = (env) => fs.readdirSync(env.agentDir).filter((f) => f.startsWith("foreman.json.bak-"));

function writeOverlay(env, hosts) {
  const dir = path.join(env.agentDir, "npm", "node_modules", "org-overlay");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "org-overlay", version: "1.0.0", pi: { foreman: { config: "foreman.json" } } }));
  fs.writeFileSync(path.join(dir, "foreman.json"), JSON.stringify({ version: 1, tools: { prGithubHosts: hosts } }));
}

// Prompt order as in picker.test.mjs, with the add-on answers: profile, adjust, two add-ons, apply.
const PICK = ["", "n", "n", "n", "n", "n", "y"];

test("(e) --github-hosts writes the list lowercased and deduped; a bad value exits non-zero", () => {
  const env = fresh();
  const r = run(env, ["--github-hosts", `${GHE.toUpperCase()},${GHE}`]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(hostsOf(env), [GHE]);
  for (const bad of ["bad_host", "-x.test", "a..b", "a:99999999", ""]) {
    const e = fresh();
    const b = run(e, ["--github-hosts", bad]);
    assert.notEqual(b.code, 0, `${bad}: ${b.out}`);
    assert.equal(fs.existsSync(foremanFile(e)), false);
  }
  const tooMany = fresh();
  const many = run(tooMany, ["--github-hosts", Array.from({ length: 21 }, (_, i) => `h${i}.test`).join(",")]);
  assert.notEqual(many.code, 0);
  assert.match(many.out, /more than 20/);
});

test("(e)(q) --github-hosts is refused with --remove, --preview and --pick", () => {
  const env = fresh();
  assert.match(run(env, ["--remove", "--github-hosts", GHE]).out, /--github-hosts cannot be combined with --remove/);
  assert.match(run(env, ["--preview", "--github-hosts", GHE]).out, /--preview cannot be combined with .*--github-hosts/);
  const pick = run(env, ["--pick", "--github-hosts", GHE], { picker: true });
  assert.notEqual(pick.code, 0);
  assert.match(pick.out, /--pick cannot be combined with --github-hosts/);
  assert.equal(fs.existsSync(foremanFile(env)), false);
  assert.match(run(env, ["--help"]).out, /--github-hosts/);
});

test("(f) a fresh install without the flag writes github.com, with or without other flags", () => {
  const plain = fresh();
  assert.equal(run(plain, []).code, 0);
  assert.deepEqual(hostsOf(plain), ["github.com"]);
  const profiled = fresh();
  assert.equal(run(profiled, ["--profile", "orchestration"]).code, 0);
  assert.deepEqual(hostsOf(profiled), ["github.com"]);
  const dry = fresh();
  const d = run(dry, ["--dry-run"]);
  assert.match(d.out, /\+ {4}"prGithubHosts": \[/);
  assert.equal(fs.existsSync(foremanFile(dry)), false);
});

test("(p) --github-hosts alone on an existing file writes the list through the normal path, with a backup", () => {
  const env = fresh();
  writeUser(env, { fanout: { max: 2 } });
  const r = run(env, ["--github-hosts", `github.com,${GHE}`]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(hostsOf(env), ["github.com", GHE]);
  assert.equal(userJson(env).fanout.max, 2);
  assert.equal(backups(env).length, 1);
  // the same list again changes nothing
  const again = run(env, ["--github-hosts", `github.com,${GHE}`]);
  assert.match(again.out, /present, left alone/);
  assert.equal(backups(env).length, 1);
});

test("(i) a no-flag re-run on an existing file without the key leaves it byte-identical and prints the hint", () => {
  const env = fresh();
  writeUser(env, { fanout: { max: 2 } });
  const before = fs.readFileSync(foremanFile(env), "utf8");
  const r = run(env, []);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(foremanFile(env), "utf8"), before);
  assert.match(r.out, /GitHub hosts not set: run foreman setup --github-hosts github\.com \(or foreman setup --pick\)/);
  assert.equal(backups(env).length, 0);
});

test("(i) an invalid stored list is left alone with a hint naming the reason", () => {
  const env = fresh();
  writeUser(env, { tools: { prGithubHosts: [] } });
  const before = fs.readFileSync(foremanFile(env), "utf8");
  const r = run(env, []);
  assert.equal(fs.readFileSync(foremanFile(env), "utf8"), before);
  assert.match(r.out, /tools\.prGithubHosts is invalid: the list is empty; run foreman setup --github-hosts <hosts> \(or foreman setup --pick\)/);
});

test("(d)(k) the readline host step runs on the picker's own interface and writes the answer", () => {
  const env = fresh();
  const r = run(env, [], { picker: true, input: lines(...PICK, `github.com, ${GHE}`) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GitHub hosts \(comma-separated\) \[github\.com\]:/);
  assert.deepEqual(hostsOf(env), ["github.com", GHE]);
});

test("(j) a changed list in the host step prints the GitHub hosts line with --github-hosts", () => {
  const env = fresh();
  const r = run(env, [], { picker: true, input: lines(...PICK, GHE) });
  assert.match(r.out, new RegExp(`GitHub hosts: ${GHE} \\(equivalent: foreman setup \\.\\.\\. --github-hosts ${GHE}\\)`));
  assert.deepEqual(hostsOf(env), [GHE]);
  // the kept prefill on a fresh install was in the summary already: no line
  const kept = fresh();
  const k = run(kept, [], { picker: true, input: lines(...PICK, "") });
  assert.doesNotMatch(k.out, /GitHub hosts: /);
  assert.deepEqual(hostsOf(kept), ["github.com"]);
});

test("(d) an invalid answer re-asks, and EOF at the host prompt keeps the prefill", () => {
  const env = fresh();
  const r = run(env, [], { picker: true, input: lines(...PICK, "bad_host!", GHE) });
  assert.match(r.out, /"bad_host!" is not a valid host name/);
  assert.deepEqual(hostsOf(env), [GHE]);
  const eof = fresh();
  assert.equal(run(eof, [], { picker: true, input: lines(...PICK) }).code, 0);
  assert.deepEqual(hostsOf(eof), ["github.com"]);
});

test("(g) a re-run with --pick shows the stored list as the prefill and keeps it without rewriting", () => {
  const env = fresh();
  assert.equal(run(env, ["--profile", "orchestration", "--github-hosts", `${GHE},github.com`]).code, 0);
  const before = fs.readFileSync(foremanFile(env), "utf8");
  const r = run(env, ["--pick"], { picker: true, input: lines(...PICK, "") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`GitHub hosts \\(comma-separated\\) \\[${GHE},github\\.com\\]:`));
  assert.doesNotMatch(r.out, /GitHub hosts: /);
  assert.equal(fs.readFileSync(foremanFile(env), "utf8"), before);
  assert.equal(backups(env).length, 0);
});

test("(h)(n) an overlay's list is the prefill and is never copied into the user file", () => {
  const env = fresh();
  writeOverlay(env, [GHE]);
  writeUser(env, { profile: "orchestration" });
  const r = run(env, ["--pick"], { picker: true, input: lines(...PICK, "") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`\\[${GHE}\\]:`));
  assert.doesNotMatch(r.out, /prGithubHosts/);
  assert.equal(userJson(env).tools?.prGithubHosts, undefined);
  // a fresh install under an overlay writes none either
  const first = fresh();
  writeOverlay(first, [GHE]);
  assert.equal(run(first, []).code, 0);
  assert.equal(fs.existsSync(foremanFile(first)) ? hostsOf(first) : undefined, undefined);
});

test("(o) --pick on an existing file with the key unset, keeping the prefill, prints the line and writes github.com", () => {
  const env = fresh();
  writeUser(env, { profile: "orchestration" });
  const r = run(env, ["--pick"], { picker: true, input: lines(...PICK, "") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GitHub hosts: github\.com \(equivalent: foreman setup \.\.\. --github-hosts github\.com\)/m);
  assert.deepEqual(hostsOf(env), ["github.com"]);
});

test("(r) an invalid overlay value with no answer on a fresh install writes no list", () => {
  const env = fresh();
  writeOverlay(env, []);
  const r = run(env, ["--profile", "orchestration"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(hostsOf(env), undefined);
});

test("(s) a kept mixed-case user value is not rewritten", () => {
  const env = fresh();
  assert.equal(run(env, ["--profile", "orchestration"]).code, 0);
  const cfg = userJson(env);
  cfg.tools.prGithubHosts = ["GHE.Example.test"];
  fs.writeFileSync(foremanFile(env), `${JSON.stringify(cfg, null, 2)}\n`);
  const before = fs.readFileSync(foremanFile(env), "utf8");
  const r = run(env, ["--pick"], { picker: true, input: lines(...PICK, "") });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(foremanFile(env), "utf8"), before);
  const flagged = run(env, ["--github-hosts", "ghe.example.test"]);
  assert.match(flagged.out, /present, left alone/);
  assert.equal(fs.readFileSync(foremanFile(env), "utf8"), before);
});

// ---- the picker functions through runPicker with fake inquirer prompts

const { runPicker } = await import(pathToFileURL(SETUP).href);
const CTX = { currentText: null, currentConfig: {}, recorded: null, installed: [], project: false };

function fakePrompts({ checkboxes, inputs }) {
  const calls = { checkbox: [], input: [] };
  return {
    calls,
    select: async () => "orchestration",
    confirm: async ({ message }) => message === "Apply?",
    checkbox: async (o) => {
      calls.checkbox.push(o);
      return checkboxes.shift()(o);
    },
    input: async (o) => {
      calls.input.push(o);
      return inputs.shift();
    },
  };
}

async function pick(prompts, option) {
  const log = console.log;
  console.log = () => {};
  try {
    return await runPicker(CTX, { tty: true, load: async () => prompts }, option);
  } finally {
    console.log = log;
  }
}

test("(l)(a) runPicker returns today's shape without the option and githubHosts with it", async () => {
  const without = await pick(fakePrompts({ checkboxes: [], inputs: [] }));
  assert.deepEqual(Object.keys(without).sort(), ["addons", "disable", "enable", "profile"]);
  const prompts = fakePrompts({ checkboxes: [(o) => o.choices.map((c) => c.value)], inputs: [GHE.toUpperCase(), "github.com", ""] });
  const withHosts = await pick(prompts, { githubHosts: { prefill: ["github.com"], pending: ["github.com"] } });
  assert.deepEqual(withHosts.githubHosts, ["github.com", GHE]);
  assert.deepEqual(prompts.calls.checkbox[0].choices, [{ name: "github.com", value: "github.com", checked: true }]);
  assert.equal(prompts.calls.input.length, 3);
});

test("(l)(b) removing every entry re-asks and cannot finish with 0 hosts", async () => {
  const prompts = fakePrompts({ checkboxes: [() => [], () => ["github.com"]], inputs: ["", ""] });
  const r = await pick(prompts, { githubHosts: { prefill: ["github.com"], pending: null } });
  assert.deepEqual(r.githubHosts, ["github.com"]);
  assert.equal(prompts.calls.checkbox.length, 2);
  // removing every entry and adding one is fine
  const swap = fakePrompts({ checkboxes: [() => []], inputs: [GHE, ""] });
  assert.deepEqual((await pick(swap, { githubHosts: { prefill: ["github.com"], pending: null } })).githubHosts, [GHE]);
});

test("(l)(c) a bad name re-asks the add-host input and a 21st host is refused", async () => {
  const bad = fakePrompts({ checkboxes: [(o) => o.choices.map((c) => c.value)], inputs: ["bad host", "-x.test", GHE, ""] });
  assert.deepEqual((await pick(bad, { githubHosts: { prefill: ["github.com"], pending: null } })).githubHosts, ["github.com", GHE]);
  const prefill = Array.from({ length: 20 }, (_, i) => `h${i}.test`);
  const full = fakePrompts({ checkboxes: [(o) => o.choices.map((c) => c.value)], inputs: ["extra.test", ""] });
  assert.equal((await pick(full, { githubHosts: { prefill, pending: null } })).githubHosts.length, 20);
});

test("(l) Apply? no skips the host step", async () => {
  const prompts = { ...fakePrompts({ checkboxes: [], inputs: [] }), confirm: async () => false };
  assert.equal(await pick(prompts, { githubHosts: { prefill: ["github.com"], pending: null } }), null);
});

// ---- (m) Ctrl-C at the readline host prompt (a probe with a pseudo terminal on stdin)

test("(m) Ctrl-C at the readline host prompt gives null, a real EOF keeps the prefill", () => {
  const run1 = (mode) => spawnSync(process.execPath, [PROBE, mode], { encoding: "utf8", timeout: 30_000 });
  const ctrlC = run1("ctrl-c");
  assert.equal(ctrlC.status, 0, `${ctrlC.stdout}${ctrlC.stderr}`);
  assert.match(ctrlC.stdout, /^RESULT null$/m);
  const eof = run1("eof");
  assert.equal(eof.status, 0, `${eof.stdout}${eof.stderr}`);
  assert.match(eof.stdout, /^RESULT .*"githubHosts":\["github\.com"\]/m);
});
