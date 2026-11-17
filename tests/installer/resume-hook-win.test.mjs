// The resume block on Windows (setup/resume-hook.mjs, setup.mjs): the PowerShell and Git Bash blocks, the profile targets per edition, the encodings
// of a profile, CRLF, the execution-policy line, and `foreman setup` with PI_FOREMAN_PLATFORM=win32 over a temp home. Every case runs on every OS; no
// real profile is touched, no PowerShell is started (PI_FOREMAN_HOME is set, the editions and policy come from the test seams). Also pins that the
// POSIX blocks are byte-identical to the render of before this change.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
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
const { RESUME_START, applyResumeHook, renderResumeBlock, resumeTargets, stripResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BIN = "C:\\Users\\dev\\pi-foreman\\bin\\foreman";
const CLI = "C:\\Users\\dev\\pi-foreman\\extensions\\core-adapter\\paneresume-cli.ts";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-win-")));
const profile = (home, edition) => path.join(home, "Documents", edition === "pwsh" ? "PowerShell" : "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const apply = (home, o = {}) => applyResumeHook({ home, bin: BIN, cli: CLI, platform: "win32", editions: ["pwsh", "powershell"], ...o });

test("D14: the zsh, bash and fish blocks are byte-identical to the render before the Windows change", () => {
  const bin = "/opt/f oo/it's/foreman";
  assert.equal(sha(renderResumeBlock({ bin, flavor: "zsh" })), "84d3ab7c52444258bb1ae697053b5761c0e193fda7e756bd332ae92c251a839d");
  assert.equal(sha(renderResumeBlock({ bin, flavor: "bash" })), "0885648d75d2dbc1a610ccee33391f531b7625a4a06089f6db8648642ab09871");
  assert.equal(sha(renderResumeBlock({ bin, flavor: "fish" })), "90a9d363e3639fa58073bdce11402a1c02d10859e4b2df5f6c2a7d158aa2c880");
});

test("the powershell block: markers, quote doubling, the prompt wrapper, no cmd.exe; the default cli sits next to bin's package", () => {
  const block = renderResumeBlock({ bin: BIN, flavor: "powershell", cli: "C:\\Users\\O'Neil\\x\\paneresume-cli.ts" });
  assert.ok(block.startsWith(RESUME_START) && block.endsWith("# <<< pi-foreman resume <<<"));
  assert.ok(block.includes("$cli = 'C:\\Users\\O''Neil\\x\\paneresume-cli.ts'"), "single quotes are doubled");
  for (const needle of ["function __PiForemanResumeCheck", "function __PiForemanResume ", "[Console]::IsInputRedirected", "function prompt", "$global:LASTEXITCODE = $__rc", "Start-Process -NoNewWindow -PassThru", "$p.WaitForExit()", "[version]'22.6'", "-eq 75", "HC_TERMINAL_ID"]) assert.ok(block.includes(needle), needle);
  assert.ok(!/-Wait\b/.test(block), "-Wait would wait for Pi's detached children");
  assert.ok(!/cmd(\.exe)?\b/i.test(block));
  assert.ok(renderResumeBlock({ bin: BIN, flavor: "powershell" }).includes("$cli = 'C:\\Users\\dev\\pi-foreman\\extensions\\core-adapter\\paneresume-cli.ts'"));
});

test("the gitbash block is the bash block with the Windows pid, cygpath for the agent dir and a mixed-spelling path; bash -n accepts it", () => {
  const block = renderResumeBlock({ bin: BIN, flavor: "gitbash" });
  assert.ok(block.includes("'C:/Users/dev/pi-foreman/bin/foreman' pane-resume --shell-pid \"$(cat /proc/$$/winpid 2>/dev/null || echo $$)\""));
  assert.ok(block.includes("cygpath -u \"$PI_CODING_AGENT_DIR\""));
  assert.ok(block.includes("pi-foreman-resume.$$"), "the marker keeps $$");
  const bash = renderResumeBlock({ bin: "/x/foreman", flavor: "bash" });
  assert.ok(!bash.includes("winpid") && !bash.includes("cygpath"));
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) {
    const dir = tmp();
    const file = path.join(dir, "block.sh");
    fs.writeFileSync(file, `${block}\n`);
    const r = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("win32 targets: the profile of each edition under Documents, Git Bash's rc files with gitBash; $SHELL is ignored; posix targets unchanged", () => {
  const home = tmp();
  const t = resumeTargets({ home, shell: "/bin/zsh", platform: "win32", editions: ["pwsh", "powershell"] });
  assert.deepEqual(t.map((x) => [x.flavor, x.edition, path.relative(home, x.file)]), [
    ["powershell", "pwsh", path.join("Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1")],
    ["powershell", "powershell", path.join("Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")],
  ]);
  assert.deepEqual(resumeTargets({ home, platform: "win32", editions: ["powershell"], documents: path.join(home, "OneDrive", "Documents") }).map((x) => path.relative(home, x.file)), [path.join("OneDrive", "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1")]);
  assert.deepEqual(resumeTargets({ home, platform: "win32", editions: [], gitBash: true }).map((x) => [x.flavor, path.basename(x.file)]), [["gitbash", ".bashrc"]]);
  fs.writeFileSync(path.join(home, ".profile"), "# p\n");
  fs.writeFileSync(path.join(home, ".bash_login"), "# l\n");
  assert.deepEqual(resumeTargets({ home, platform: "win32", editions: [], gitBash: true }).map((x) => path.basename(x.file)), [".bashrc", ".bash_login"]);
  assert.deepEqual(resumeTargets({ home, platform: "win32", editions: ["nope"] }), []);
  assert.deepEqual(resumeTargets({ home, shell: "/bin/zsh" }).map((x) => path.basename(x.file)), [".zshrc"], "no platform: today's rule");
  assert.deepEqual(resumeTargets({ home, shell: "/bin/zsh", platform: "linux" }).map((x) => path.basename(x.file)), [".zshrc"]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a new profile is UTF-8 with a BOM and the block; a re-run is 'already in'; removal leaves the BOM and the rest", () => {
  const home = tmp();
  const lines = apply(home);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /wrote the pi-foreman resume block to .*PowerShell[\\/]Microsoft\.PowerShell_profile\.ps1; open a new shell/);
  const file = profile(home, "pwsh");
  const buf = fs.readFileSync(file);
  assert.ok(buf.subarray(0, 3).equals(BOM8));
  assert.ok(!buf.subarray(3, 6).equals(BOM8));
  assert.ok(buf.toString("utf8").includes(RESUME_START));
  assert.match(apply(home)[0], /already in/);
  assert.ok(fs.readFileSync(file).equals(buf));
  const gone = apply(home, { remove: true });
  assert.match(gone[0], /removed the pi-foreman block/);
  assert.equal(fs.readFileSync(file, "utf8").includes(RESUME_START), false);
  assert.deepEqual(apply(home, { remove: true }), [], "nothing left to remove");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a UTF-8 BOM file keeps its BOM; a UTF-16LE file stays UTF-16LE; both come back byte for byte after a removal", () => {
  const home = tmp();
  const f8 = profile(home, "pwsh");
  fs.mkdirSync(path.dirname(f8), { recursive: true });
  const orig8 = Buffer.concat([BOM8, Buffer.from("# mine é\n", "utf8")]);
  fs.writeFileSync(f8, orig8);
  const f16 = profile(home, "powershell");
  fs.mkdirSync(path.dirname(f16), { recursive: true });
  const orig16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# mine é\r\n", "utf16le")]);
  fs.writeFileSync(f16, orig16);
  apply(home);
  const w8 = fs.readFileSync(f8);
  assert.ok(w8.subarray(0, 3).equals(BOM8) && !w8.subarray(3, 6).equals(BOM8));
  assert.ok(w8.toString("utf8").includes("# mine é\n"));
  const w16 = fs.readFileSync(f16);
  assert.ok(w16.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])));
  const t16 = w16.subarray(2).toString("utf16le");
  assert.ok(t16.includes(RESUME_START) && t16.startsWith("# mine é\r\n"));
  assert.ok(!/[^\r]\n/.test(t16), "CRLF throughout");
  assert.match(apply(home)[1], /already in/);
  apply(home, { remove: true });
  assert.ok(fs.readFileSync(f8).equals(orig8));
  assert.ok(fs.readFileSync(f16).equals(orig16));
  fs.rmSync(home, { recursive: true, force: true });
});

test("a UTF-16BE profile is skipped with a hand-add line and not changed", () => {
  const home = tmp();
  const f = profile(home, "pwsh");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const orig = Buffer.from([0xfe, 0xff, 0x00, 0x23]);
  fs.writeFileSync(f, orig);
  const lines = apply(home, { editions: ["pwsh"] });
  assert.match(lines[0], /not changed \(it is UTF-16 big-endian\); add the block by hand/);
  assert.ok(fs.readFileSync(f).equals(orig));
  assert.deepEqual(apply(home, { editions: ["pwsh"], remove: true }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a BOM-less file with an ANSI byte survives write, re-run and removal byte for byte (ASCII block)", () => {
  const home = tmp();
  for (const edition of ["pwsh", "powershell"]) {
    const f = profile(home, edition);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const orig = Buffer.from([0x23, 0x20, 0xe9, 0x0a, 0x61, 0x0a]); // "# é\na\n" in cp1252
    fs.writeFileSync(f, orig);
    apply(home, { editions: [edition] });
    const written = fs.readFileSync(f);
    assert.ok(written.subarray(0, orig.length).equals(orig), `${edition}: the ANSI byte is kept`);
    assert.ok(!written.subarray(0, 3).equals(BOM8), "no BOM added");
    assert.match(apply(home, { editions: [edition] })[0], /already in/);
    assert.ok(fs.readFileSync(f).equals(written));
    apply(home, { editions: [edition], remove: true });
    assert.ok(fs.readFileSync(f).equals(orig), `${edition}: removal restores the bytes`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("a non-ASCII block: a new file gets BOM + UTF-8; a BOM-less file is skipped for 5.1, appended as UTF-8 for 7 when valid UTF-8, skipped when not", () => {
  const home = tmp();
  const o = { bin: "C:\\Users\\Jörg\\pi\\bin\\foreman", cli: "C:\\Users\\Jörg\\pi\\extensions\\core-adapter\\paneresume-cli.ts" };
  const fresh = applyResumeHook({ home, platform: "win32", editions: ["powershell"], ...o });
  assert.match(fresh[0], /wrote/);
  const fb = fs.readFileSync(profile(home, "powershell"));
  assert.ok(fb.subarray(0, 3).equals(BOM8) && fb.toString("utf8").includes("Jörg"));
  const dir = tmp();
  const f51 = profile(dir, "powershell");
  fs.mkdirSync(path.dirname(f51), { recursive: true });
  fs.writeFileSync(f51, "# plain\n");
  const s51 = applyResumeHook({ home: dir, platform: "win32", editions: ["powershell"], ...o });
  assert.match(s51[0], /not changed \(the block holds non-ASCII characters and Windows PowerShell 5\.1 reads a file without a byte order mark as ANSI\)/);
  assert.equal(fs.readFileSync(f51, "utf8"), "# plain\n");
  const f7 = profile(dir, "pwsh");
  fs.mkdirSync(path.dirname(f7), { recursive: true });
  fs.writeFileSync(f7, "# plain ü\n");
  const s7 = applyResumeHook({ home: dir, platform: "win32", editions: ["pwsh"], ...o });
  assert.match(s7[0], /wrote/);
  const b7 = fs.readFileSync(f7);
  assert.ok(!b7.subarray(0, 3).equals(BOM8), "no BOM added");
  assert.ok(b7.toString("utf8").startsWith("# plain ü\n") && b7.toString("utf8").includes("Jörg"));
  assert.match(applyResumeHook({ home: dir, platform: "win32", editions: ["pwsh"], ...o })[0], /already in/);
  applyResumeHook({ home: dir, platform: "win32", editions: ["pwsh"], remove: true, ...o });
  assert.equal(fs.readFileSync(f7, "utf8"), "# plain ü\n");
  const bad = tmp();
  const fbad = profile(bad, "pwsh");
  fs.mkdirSync(path.dirname(fbad), { recursive: true });
  const invalid = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
  fs.writeFileSync(fbad, invalid);
  assert.match(applyResumeHook({ home: bad, platform: "win32", editions: ["pwsh"], ...o })[0], /the file is not valid UTF-8\); add the block by hand/);
  assert.ok(fs.readFileSync(fbad).equals(invalid));
  for (const d of [home, dir, bad]) fs.rmSync(d, { recursive: true, force: true });
});

test("a CRLF profile gets the block with CRLF; merge, re-run and strip are idempotent", () => {
  const home = tmp();
  const f = profile(home, "pwsh");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "Set-Alias x y\r\nfunction a { }\r\n");
  apply(home, { editions: ["pwsh"] });
  const text = fs.readFileSync(f, "latin1");
  assert.ok(text.startsWith("Set-Alias x y\r\nfunction a { }\r\n\r\n# >>>"), "one blank CRLF line before the block");
  assert.ok(!/[^\r]\n/.test(text), "no bare LF");
  assert.ok(text.endsWith("<<<\r\n"));
  assert.match(apply(home, { editions: ["pwsh"] })[0], /already in/);
  apply(home, { editions: ["pwsh"], remove: true });
  assert.equal(fs.readFileSync(f, "latin1"), "Set-Alias x y\r\nfunction a { }\r\n");
  assert.equal(stripResumeBlock(`a\r\n\r\n${renderResumeBlock({ bin: BIN, flavor: "powershell", cli: CLI }).replace(/\n/g, "\r\n")}\r\n`), "a\r\n");
  fs.rmSync(home, { recursive: true, force: true });
});

test("a changed block is replaced in place with the text around it kept", () => {
  const home = tmp();
  const f = profile(home, "powershell");
  apply(home, { editions: ["powershell"] });
  const good = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, good.replace("$ver = $null", "$ver = 'stale'").replace(/^\uFEFF/, "\uFEFFbefore\n") + "after\n");
  apply(home, { editions: ["powershell"] });
  const text = fs.readFileSync(f, "utf8");
  assert.equal(text.split(RESUME_START).length - 1, 1);
  assert.ok(!text.includes("stale") && text.startsWith("\uFEFFbefore\n") && text.endsWith("after\n"));
  fs.rmSync(home, { recursive: true, force: true });
});

test("a dry run writes nothing and names the policy; Restricted, AllSigned and Undefined give the policy line, RemoteSigned and Bypass do not; removal prints none", () => {
  const home = tmp();
  for (const e of ["pwsh", "powershell"]) {
    fs.mkdirSync(path.dirname(profile(home, e)), { recursive: true });
    fs.writeFileSync(profile(home, e), "# p\n");
  }
  const dry = apply(home, { dry: true, policy: { pwsh: "Restricted", powershell: "RemoteSigned" } });
  assert.match(dry[0], /would write the pi-foreman resume block to .*; the PowerShell 7 profile does not load under execution policy Restricted, allow it with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned/);
  assert.doesNotMatch(dry[1], /execution policy/);
  assert.equal(fs.readFileSync(profile(home, "pwsh"), "utf8"), "# p\n");
  const real = apply(home, { policy: { pwsh: "AllSigned", powershell: "Undefined" } });
  assert.match(real[0], /wrote .*does not load under execution policy AllSigned/);
  assert.match(real[1], /Windows PowerShell 5\.1 profile does not load under execution policy Restricted/, "Undefined resolves to Restricted");
  for (const p of ["RemoteSigned", "Bypass", "Unrestricted"]) assert.doesNotMatch(apply(home, { policy: { pwsh: p } })[0], /execution policy/);
  assert.ok(fs.existsSync(profile(home, "pwsh")), "the block was written under a blocking policy");
  assert.doesNotMatch(apply(home, { remove: true, policy: { pwsh: "Restricted" } }).join("\n"), /execution policy/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("Git Bash: the gitbash block goes to ~/.bashrc and the first login file; a re-run and a removal work as for bash", () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, ".bash_profile"), "# login\n");
  const lines = apply(home, { editions: [], gitBash: true });
  assert.equal(lines.length, 2);
  for (const f of [".bashrc", ".bash_profile"]) assert.ok(fs.readFileSync(path.join(home, f), "utf8").includes("/proc/$$/winpid"), f);
  assert.match(apply(home, { editions: [], gitBash: true })[0], /already in/);
  apply(home, { editions: [], gitBash: true, remove: true });
  assert.equal(fs.readFileSync(path.join(home, ".bash_profile"), "utf8"), "# login\n");
  const none = apply(home, { editions: [], gitBash: false });
  assert.match(none[0], /no PowerShell profile or Git Bash found/);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------- foreman setup on win32 over a temp home

function fresh() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-win-setup-")));
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
      PI_FOREMAN_PI_AI_DATA: path.join(env.base, "no-models"), PI_FOREMAN_HOME: env.home, SHELL: "/bin/zsh", PI_FOREMAN_PLATFORM: "win32",
      PI_FOREMAN_TEST_PS_EDITIONS: "pwsh,powershell", PI_FOREMAN_TEST_PS_POLICY: "", PI_BG_FEATURES: undefined, ...extra,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("setup on win32 writes the PowerShell block of each edition and the Git Bash block, names each file, and ignores $SHELL", () => {
  const env = fresh();
  fs.writeFileSync(path.join(env.home, ".bashrc"), "# rc\n");
  const r = run(env, ["--no-addons"]);
  assert.equal(r.code, 0, r.out);
  for (const e of ["pwsh", "powershell"]) {
    assert.ok(fs.readFileSync(profile(env.home, e), "utf8").includes(RESUME_START), e);
    assert.match(r.out, new RegExp(`wrote the pi-foreman resume block to .*${e === "pwsh" ? "PowerShell" : "WindowsPowerShell"}`.replace(/\\/g, "\\\\")));
  }
  const rc = fs.readFileSync(path.join(env.home, ".bashrc"), "utf8");
  assert.ok(rc.startsWith("# rc\n") && rc.includes("/proc/$$/winpid") && rc.includes(`'${path.join(ROOT, "bin", "foreman").replace(/\\/g, "/")}'`));
  assert.equal(fs.existsSync(path.join(env.home, ".zshrc")), false, "$SHELL is ignored on win32");
  const ps = fs.readFileSync(profile(env.home, "pwsh"), "utf8");
  assert.ok(ps.includes(`$cli = '${path.join(ROOT, "extensions", "core-adapter", "paneresume-cli.ts").replace(/'/g, "''")}'`));
  const again = run(env, ["--no-addons"]);
  assert.match(again.out, /resume hook: already in .*Microsoft\.PowerShell_profile\.ps1/);
  assert.equal(fs.readFileSync(profile(env.home, "pwsh"), "utf8"), ps);
});

test("setup on win32: a dry run and --no-env write nothing; --no-resume-hook and --remove take the blocks out", () => {
  const dry = fresh();
  const d = run(dry, ["--dry-run", "--no-addons"], { PI_FOREMAN_TEST_PS_POLICY: "pwsh=Restricted" });
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /resume hook: not written to .*PowerShell.*: PowerShell 7 blocks profile scripts \(policy Restricted\); to enable: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, then run foreman setup again/);
  assert.deepEqual(fs.readdirSync(dry.home), []);
  const custom = fresh();
  const c = run(custom, ["--no-addons"], { PI_FOREMAN_HOME: undefined, HOME: custom.home, USERPROFILE: custom.home });
  assert.match(c.out, /wrote the pi-foreman resume block to .*Microsoft\.PowerShell_profile\.ps1/, "a custom agent dir writes the block now (D34)");
  assert.ok(fs.readFileSync(profile(custom.home, "pwsh"), "utf8").includes(`'${custom.agentDir}'`));
  const noEnv = fresh();
  const n = run(noEnv, ["--no-addons", "--no-env"]);
  assert.match(n.out, /resume hook: not written \(--no-env\)/);
  assert.deepEqual(fs.readdirSync(noEnv.home), []);
  const env = fresh();
  fs.writeFileSync(path.join(env.home, ".bashrc"), "# rc\n");
  assert.equal(run(env, ["--no-addons"]).code, 0);
  const off = run(env, ["--no-addons", "--no-resume-hook"]);
  assert.equal(off.code, 0, off.out);
  assert.match(off.out, /removed the pi-foreman block from .*Microsoft\.PowerShell_profile\.ps1/);
  assert.equal(fs.readFileSync(path.join(env.home, ".bashrc"), "utf8"), "# rc\n");
  assert.equal(fs.readFileSync(profile(env.home, "pwsh"), "utf8").includes(RESUME_START), false);
  assert.equal(run(env, ["--no-addons"]).code, 0);
  const rm = run(env, ["--remove"]);
  assert.equal(rm.code, 0, rm.out);
  assert.equal(fs.readFileSync(profile(env.home, "powershell"), "utf8").includes(RESUME_START), false);
  assert.equal(fs.readFileSync(path.join(env.home, ".bashrc"), "utf8"), "# rc\n");
});

test("setup on win32: a redirected Documents folder and a missing pwsh do not stop a removal from stripping the blocks", () => {
  const env = fresh();
  const docs = path.join(env.base, "OneDrive", "Documents");
  const at = (e) => path.join(docs, e === "pwsh" ? "PowerShell" : "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
  assert.equal(run(env, ["--no-addons"], { PI_FOREMAN_TEST_PS_DOCUMENTS: docs }).code, 0);
  for (const e of ["pwsh", "powershell"]) assert.ok(fs.readFileSync(at(e), "utf8").includes(RESUME_START), e);
  assert.equal(fs.existsSync(path.join(env.home, "Documents")), false);
  const off = run(env, ["--no-addons", "--no-resume-hook"], { PI_FOREMAN_TEST_PS_DOCUMENTS: docs, PI_FOREMAN_TEST_PS_EDITIONS: "powershell" });
  assert.equal(off.code, 0, off.out);
  for (const e of ["pwsh", "powershell"]) assert.equal(fs.readFileSync(at(e), "utf8").includes(RESUME_START), false, e);
  assert.equal(run(env, ["--no-addons"], { PI_FOREMAN_TEST_PS_DOCUMENTS: docs }).code, 0);
  const rm = run(env, ["--remove"], { PI_FOREMAN_TEST_PS_DOCUMENTS: docs, PI_FOREMAN_TEST_PS_EDITIONS: "powershell" });
  assert.equal(rm.code, 0, rm.out);
  for (const e of ["pwsh", "powershell"]) assert.equal(fs.readFileSync(at(e), "utf8").includes(RESUME_START), false, e);
});

test("A3: a blocking policy creates no new profile and prints how to enable it; an existing profile still gets the block; an unknown policy writes", () => {
  const LINE = /resume hook: not written to .*: (PowerShell 7|Windows PowerShell 5\.1) blocks profile scripts \(policy (Restricted|AllSigned)\); to enable: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned, then run foreman setup again/;
  const home = tmp();
  const r = apply(home, { policy: { pwsh: "Restricted", powershell: "AllSigned" } });
  assert.equal(r.length, 2);
  for (const l of r) assert.match(l, LINE);
  for (const e of ["pwsh", "powershell"]) assert.equal(fs.existsSync(profile(home, e)), false, e);
  const dry = apply(home, { dry: true, policy: { pwsh: "Restricted", powershell: "AllSigned" } });
  assert.deepEqual(dry, r);
  assert.equal(fs.existsSync(path.join(home, "Documents")), false);
  fs.mkdirSync(path.dirname(profile(home, "powershell")), { recursive: true });
  fs.writeFileSync(profile(home, "powershell"), "# mine\n");
  const mixed = apply(home, { policy: { pwsh: "RemoteSigned", powershell: "Restricted" } });
  assert.match(mixed[0], /wrote the pi-foreman resume block/);
  assert.match(mixed[1], /wrote .*does not load under execution policy Restricted/);
  assert.ok(fs.existsSync(profile(home, "pwsh")));
  assert.ok(fs.readFileSync(profile(home, "powershell"), "utf8").includes(RESUME_START));
  const home2 = tmp();
  assert.match(apply(home2, { policy: {} }).join("\n"), /wrote the pi-foreman resume block/);
  assert.ok(fs.existsSync(profile(home2, "pwsh")));
  for (const h of [home, home2]) fs.rmSync(h, { recursive: true, force: true });
});
