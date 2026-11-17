// The PowerShell resume block run for real, in PowerShell 7 and Windows PowerShell 5.1 (each when present): the block is dot-sourced, the prompt wrapper
// runs the check, a fake node.cmd first on PATH logs its arguments and exits with a set code. Windows only (the Windows CI runner); skipped elsewhere.
// The test redefines `__PiForemanResume` after dot-sourcing (it is looked up by name when the prompt runs), because a test process has redirected input and the
// real one returns at once then; one case keeps the real one and asserts no call.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);
const BOM = String.fromCharCode(0xfeff); // Windows PowerShell 5.1 reads a script without a BOM as ANSI
const win = process.platform === "win32";
const has = (exe) => win && spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "1"], { encoding: "utf8" }).status === 0;
const EXES = ["pwsh", "powershell"].filter(has);

const NODE_CMD = [
  "@echo off",
  "if \"%~1\"==\"--version\" (echo %PF_FAKE_VER%& exit /b 0)",
  "echo %*>> \"%PF_LOG%\"",
  "echo fake-node-output",
  "if defined PF_FAKE_DETACH start \"\" /b ping -n 8 127.0.0.1 >nul",
  "exit /b %PF_FAKE_RC%",
  "",
].join("\r\n");

function world(exe) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-resume-pwsh-")));
  const bin = path.join(base, "bin");
  const agent = path.join(base, "agent");
  const panes = path.join(agent, "pi-foreman", "state", "panes");
  const empty = path.join(base, "empty");
  for (const d of [bin, panes, empty]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "node.cmd"), NODE_CMD);
  const cli = path.join(base, "paneresume-cli.ts");
  fs.writeFileSync(cli, "// fake\n");
  const blockFile = path.join(base, "block.ps1");
  fs.writeFileSync(blockFile, `${BOM}${renderResumeBlock({ bin: path.join(base, "bin", "foreman"), flavor: "powershell", cli })}\r\n`);
  const note = path.join(panes, "t1.json");
  const log = path.join(base, "calls.log");
  const run = (lines, extra = {}) => {
    const script = path.join(base, `case-${Math.random().toString(36).slice(2)}.ps1`);
    fs.writeFileSync(script, `${BOM}${lines.join("\r\n")}\r\n`);
    const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      encoding: "utf8", input: "", timeout: 90_000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, HC_TERMINAL_ID: "t1", PI_CODING_AGENT_DIR: agent, TEMP: base, TMP: base, PF_LOG: log, PF_FAKE_VER: "v22.6.0", PF_FAKE_RC: "0", PF_EMPTY: empty, PF_BLOCK: blockFile, PF_NOTE: note, ...extra },
    });
    const kv = {};
    for (const l of `${r.stdout}`.split(/\r?\n/)) {
      const m = /^(\w+)=(.*)$/.exec(l);
      if (m) kv[m[1]] = m[2];
    }
    return { kv, out: `${r.stdout}${r.stderr}`, status: r.status };
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : []);
  return { base, run, calls, note, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// every case: an original prompt, the block, then the seam; `P` runs the real wrapper
const HEAD = [
  "function prompt { $global:seenOk = $?; $global:seenRc = $LASTEXITCODE; 'ORIG> ' }",
  ". $env:PF_BLOCK",
  "function __PiForemanResume { __PiForemanResumeCheck }",
  "Write-Output ('pid=' + $PID)",
  "function Count { if (Test-Path $env:PF_LOG) { @(Get-Content $env:PF_LOG).Count } else { 0 } }",
];
const NOTE = "Set-Content -LiteralPath $env:PF_NOTE -Value '{}'";

for (const exe of EXES) {
  test(`${exe}: no note, no call; a note gives one call with --shell-pid <PID>; a second prompt gives none; a touched note gives one again`, () => {
    const w = world(exe);
    try {
      const r = w.run([...HEAD, "$null = prompt", "Write-Output ('none=' + (Count))", NOTE, "$null = prompt", "Write-Output ('one=' + (Count))", "$null = prompt", "Write-Output ('still=' + (Count))",
        "(Get-Item -LiteralPath $env:PF_NOTE).LastWriteTimeUtc = [DateTime]::UtcNow.AddSeconds(5)", "$null = prompt", "Write-Output ('again=' + (Count))"]);
      assert.equal(r.status, 0, r.out);
      assert.deepEqual([r.kv.none, r.kv.one, r.kv.still, r.kv.again], ["0", "1", "1", "2"], r.out);
      const first = w.calls()[0];
      assert.ok(first.includes(`--shell-pid ${r.kv.pid}`) && first.includes("--experimental-strip-types") && first.includes("paneresume-cli.ts"), first);
    } finally {
      w.cleanup();
    }
  });

  test(`${exe}: the real __PiForemanResume returns at once when stdin is redirected`, () => {
    const w = world(exe);
    try {
      const r = w.run(["function prompt { 'ORIG> ' }", ". $env:PF_BLOCK", NOTE, "$null = prompt", "Write-Output ('calls=' + $(if (Test-Path $env:PF_LOG) { 1 } else { 0 }))"]);
      assert.equal(r.kv.calls, "0", r.out);
    } finally {
      w.cleanup();
    }
  });

  test(`${exe}: exit 75 checks again at the next prompt; node missing checks again once it is back; an old node is silent`, () => {
    const w = world(exe);
    try {
      const a = w.run([...HEAD, NOTE, "$null = prompt", "$null = prompt", "Write-Output ('n=' + (Count))"], { PF_FAKE_RC: "75" });
      assert.equal(a.kv.n, "2", a.out);
      fs.rmSync(path.join(w.base, "calls.log"), { force: true });
      const b = w.run([...HEAD, NOTE, "$saved = $env:PATH", "$env:PATH = $env:PF_EMPTY", "$null = prompt", "Write-Output ('missing=' + (Count))", "$env:PATH = $saved", "$null = prompt", "Write-Output ('back=' + (Count))"]);
      assert.deepEqual([b.kv.missing, b.kv.back], ["0", "1"], b.out);
      fs.rmSync(path.join(w.base, "calls.log"), { force: true });
      const c = w.run([...HEAD, NOTE, "$null = prompt", "Write-Output ('old=' + (Count))"], { PF_FAKE_VER: "v20.0.0" });
      assert.equal(c.kv.old, "0", c.out);
    } finally {
      w.cleanup();
    }
  });

  test(`${exe}: the prompt string is the original's (nothing captured), the child's output goes to the console; $LASTEXITCODE and a false $? are kept`, () => {
    const w = world(exe);
    try {
      const r = w.run([...HEAD, NOTE, "$global:LASTEXITCODE = 0", "cmd /c exit 7", "$text = prompt", "Write-Output ('text=' + $text)", "Write-Output ('rc=' + $global:seenRc + '/' + $LASTEXITCODE)", "Write-Output ('ok=' + $global:seenOk)", "Write-Output ('calls=' + (Count))"], { PF_FAKE_RC: "3" });
      assert.equal(r.kv.text, "ORIG> ", r.out);
      assert.equal(r.kv.calls, "1", "the check ran");
      assert.ok(r.out.includes("fake-node-output"), "the child's output reached the console");
      assert.equal(r.kv.rc, "7/7", "LASTEXITCODE before and after the prompt");
      assert.equal(r.kv.ok, "False", "the original prompt saw the false $?");
      const t = w.run([...HEAD, "$null = 1", "$text = prompt", "Write-Output ('ok=' + $global:seenOk)"]);
      assert.equal(t.kv.ok, "True", t.out);
    } finally {
      w.cleanup();
    }
  });

  test(`${exe}: a node that leaves a detached child behind still returns at once`, () => {
    const w = world(exe);
    try {
      const r = w.run([...HEAD, NOTE, "$sw = [Diagnostics.Stopwatch]::StartNew()", "$null = prompt", "Write-Output ('ms=' + $sw.ElapsedMilliseconds)", "Write-Output ('calls=' + (Count))"], { PF_FAKE_DETACH: "1" });
      assert.equal(r.kv.calls, "1", r.out);
      assert.ok(Number(r.kv.ms) < 6000, `returned after ${r.kv.ms} ms`);
    } finally {
      w.cleanup();
    }
  });

  test(`${exe}: the block loaded twice wraps the prompt once`, () => {
    const w = world(exe);
    try {
      const r = w.run([...HEAD, ". $env:PF_BLOCK", "function __PiForemanResume { __PiForemanResumeCheck }", NOTE, "$text = prompt", "Write-Output ('text=' + $text)", "Write-Output ('calls=' + (Count))"]);
      assert.equal(r.kv.text, "ORIG> ", r.out);
      assert.equal(r.kv.calls, "1");
    } finally {
      w.cleanup();
    }
  });
}

test("a PowerShell edition was found on the Windows runner", { skip: !win }, () => {
  assert.ok(EXES.length > 0, "neither pwsh nor powershell started");
});
