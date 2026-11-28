// `foreman doctor` (doctor-cli.ts): the exit codes, a clean run, FAIL cases, the usage errors, and the parity of its lines with `/foreman doctor`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSubagents } from "../config.ts";
import { doctorLines, main, realDeps, USAGE } from "../doctor-cli.ts";
import type { DoctorDeps } from "../doctor-cli.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig } from "./_r11rig.ts";

type T = Parameters<typeof r11Rig>[0];
type Cmd = { handler: (args: string, ctx: unknown) => Promise<void> };

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doctorcli-")));
const NEEDS_PI = "needs a running Pi: run /foreman doctor";

function rig(over: Partial<DoctorDeps> = {}) {
  const root = tmp();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const base = realDeps({ ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir });
  const deps: DoctorDeps = { ...base, agentDir, cwd, npmRoot: async () => null, pressureRun: async () => undefined, ...over };
  const run = async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, (s) => void (out += s), (s) => void (err += s), () => deps);
    return { code, out, err };
  };
  /** settings.json with the subagents block setup would write: the in-sync state. */
  const writeSyncedSettings = async (): Promise<void> => {
    const py = await deps.resolve(null);
    const g = await generateSubagents({ python: py.ok ? py.info.executable : null, pkgRoot: deps.pkgRoot, agentDir, projectDir: cwd, trusted: false, spawner: defaultSpawner });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: g }));
  };
  return { deps, agentDir, cwd, run, writeSyncedSettings, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a clean run exits 0, prints the heading, OK lines and the needs-a-running-Pi line, and no FAIL", async () => {
  const h = rig();
  try {
    await h.writeSyncedSettings();
    const r = await h.run();
    assert.equal(r.err, "");
    assert.equal(r.code, 0, r.out);
    const lines = r.out.split("\n");
    assert.equal(lines[0], "pi-foreman doctor");
    assert.ok(lines.some((l) => l.startsWith("OK   ")), r.out);
    assert.ok(lines.some((l) => l.startsWith("INFO ") && l.includes(NEEDS_PI)), r.out);
    assert.ok(!lines.some((l) => l.startsWith("FAIL")), r.out);
    for (const l of lines) if (l.includes(NEEDS_PI)) assert.ok(l.startsWith("INFO "), l);
  } finally {
    h.done();
  }
});

test("a settings.json whose subagents block is out of sync is a FAIL line and exit 1", async () => {
  const h = rig();
  try {
    fs.writeFileSync(path.join(h.agentDir, "settings.json"), JSON.stringify({ subagents: { agentOverrides: { nobody: { model: "x/y" } } } }));
    const r = await h.run();
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^FAIL subagents block in settings\.json differs from generate-subagents — fix: /m);
    assert.match(r.out, new RegExp(NEEDS_PI));
  } finally {
    h.done();
  }
});

test("no Python found: the Python FAIL line, the lines that need none, exit 1, no stack trace", async () => {
  const h = rig({ resolve: async () => ({ ok: false, rejected: ["injected (no python here)"] }) });
  try {
    const r = await h.run();
    assert.equal(r.code, 1, r.out + r.err);
    assert.equal(r.err, "");
    assert.match(r.out, /^FAIL no Python ≥ 3\.13 \(tried: injected \(no python here\)\) — fix: /m);
    assert.match(r.out, /^OK +core scripts at /m);
    assert.match(r.out, /^OK +bundled packages present under /m);
    assert.match(r.out, new RegExp(NEEDS_PI));
    assert.doesNotMatch(r.out + r.err, /\n\s+at .*\.ts:\d+/);
  } finally {
    h.done();
  }
});

test("usage: --help prints the usage and exits 0; warm and any other argument exit 2 on stderr", async () => {
  const h = rig();
  try {
    const help = await h.run("--help");
    assert.deepEqual([help.code, help.out, help.err], [0, `${USAGE}\n`, ""]);
    assert.equal((await h.run("-h")).code, 0);
    const warm = await h.run("warm");
    assert.equal(warm.code, 2);
    assert.equal(warm.out, "");
    assert.match(warm.err, /^usage: foreman doctor\n/);
    assert.match(warm.err, /run \/foreman doctor warm in Pi/);
    for (const argv of [["--json"], ["status"], ["warm", "x"]]) {
      const r = await h.run(...argv);
      assert.deepEqual([r.code, r.out, r.err.startsWith(`${USAGE}\n`)], [2, "", true], argv.join(" "));
    }
  } finally {
    h.done();
  }
});

test("parity: every line the shell form prints for the same agent dir and project is a line of /foreman doctor, in the same order", async (t: T) => {
  // The Python input both forms get: the env as the process had it before a session started. index.ts captures PI_FOREMAN_PYTHON at import,
  // and its session_start writes the resolved interpreter into process.env (patchShellEnv), which the shell form would then read as its hint.
  const startEnv = { ...process.env };
  const commands = new Map<string, Cmd>();
  const notes: string[] = [];
  const c = await r11Rig(t, {}, {
    piExtra: { registerCommand: (n: string, cmd: Cmd) => void commands.set(n, cmd) },
    ctx: { ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
  });
  await commands.get("foreman")!.handler("doctor", c.ctx);
  const slash = notes[notes.length - 1].split("\n");
  const base = realDeps({ ...startEnv, HOME: path.dirname(c.agentDir), PI_CODING_AGENT_DIR: c.agentDir });
  const shell = await doctorLines({ ...base, agentDir: c.agentDir, cwd: c.project, npmRoot: async () => null, pressureRun: async () => undefined, now: Date.now });
  // the shell form's own lines, and the two that depend on a session: the running Pi's version and the provider's roles (what is dormant)
  const own = (l: string): boolean => l.includes(NEEDS_PI) || l.startsWith("INFO config read without a provider") || l.startsWith("INFO pi-background-tasks peer range") || l.startsWith("INFO dormant:");
  const shared = shell.filter((l) => !own(l));
  assert.ok(shared.length > 10, shell.join("\n"));
  let at = -1;
  for (const l of shared) {
    const i = slash.indexOf(l, at + 1);
    assert.ok(i > at, `not in the slash output after line ${at}: ${l}\n--- slash\n${slash.join("\n")}`);
    at = i;
  }
});
