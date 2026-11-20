// withFileLock (statefile.ts) and the `pr` row writer (findings.ts) against the Python findings store: one lock file, one session file name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendPrRow, sessionFileOf } from "../findings.ts";
import { withFileLock } from "../statefile.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
const PRELUDE = `import sys, time, json; sys.path.insert(0, ${JSON.stringify(path.join(PKG, "scripts"))}); import foreman_config as bl, foreman_findings as ff\n`;

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "flock-"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function python(code: string, ...args: string[]) {
  return spawn(PY, ["-I", "-c", PRELUDE + code, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}

function exited(p: ReturnType<typeof python>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

function line(p: ReturnType<typeof python>, text: string): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    p.stdout!.on("data", (d) => {
      buf += d;
      if (buf.includes(text)) resolve();
    });
  });
}

test("withFileLock runs fn under <file>.lock and removes the lock", () => {
  const dir = tmp();
  try {
    const lock = path.join(dir, "s.jsonl.lock");
    const seen = withFileLock(lock, () => fs.existsSync(lock));
    assert.equal(seen, true);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock gives up after the wait and leaves the other holder's lock", () => {
  const dir = tmp();
  try {
    const lock = path.join(dir, "s.jsonl.lock");
    fs.writeFileSync(lock, "other");
    const t0 = Date.now();
    assert.throws(() => withFileLock(lock, () => "never", 300), /locked: s\.jsonl\.lock/);
    assert.ok(Date.now() - t0 >= 280);
    assert.equal(fs.readFileSync(lock, "utf8"), "other");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock breaks a lock older than the stale limit", () => {
  const dir = tmp();
  try {
    const lock = path.join(dir, "s.jsonl.lock");
    fs.writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    assert.equal(withFileLock(lock, () => "ran"), "ran");
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withFileLock releases the lock when fn throws", () => {
  const dir = tmp();
  try {
    const lock = path.join(dir, "s.jsonl.lock");
    assert.throws(() => withFileLock(lock, () => { throw new Error("boom"); }), /boom/);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(withFileLock(lock, () => 1), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TS writer waits while the Python lock is held", async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "s.jsonl");
    const holder = python("with bl.locked(sys.argv[1]):\n    print('held', flush=True)\n    time.sleep(1.0)\nprint('released', flush=True)\n", file);
    await line(holder, "held");
    const t0 = Date.now();
    withFileLock(`${file}.lock`, () => fs.appendFileSync(file, "ts\n"));
    assert.ok(Date.now() - t0 >= 600, "waited for the Python holder");
    assert.equal(fs.readFileSync(file, "utf8"), "ts\n");
    assert.equal((await exited(holder)).code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Python writer waits while the TS lock is held", async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "s.jsonl");
    let py: ReturnType<typeof python> | undefined;
    let seenWhileHeld = "";
    withFileLock(`${file}.lock`, () => {
      py = python("ff._append_lines(sys.argv[1], [{'type': 'py'}])\nprint('wrote', flush=True)\n", file);
      sleepSync(700);
      seenWhileHeld = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      fs.appendFileSync(file, '{"type":"ts"}\n');
    });
    assert.equal(seenWhileHeld, "");
    const r = await exited(py!);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).type), ["ts", "py"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("TS and Python name the same session file", () => {
  const dir = tmp();
  try {
    for (const session of ["abc-123", "with space/and..slash", "x".repeat(80), "", "../../evil", "a.b_c-d"]) {
      const r = spawnSync(PY, ["-I", "-c", PRELUDE + "print(ff._session_id(sys.argv[1]))", session], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(path.basename(sessionFileOf(dir, session)), `${r.stdout.trim()}.jsonl`, JSON.stringify(session));
      assert.equal(path.dirname(sessionFileOf(dir, session)), path.join(dir, "pi-foreman", "state", "findings"));
    }
    // the directory is the one Python reads
    const r = spawnSync(PY, ["-I", "-c", PRELUDE + "print(ff.findings_dir(sys.argv[1]))", dir], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), path.dirname(sessionFileOf(dir, "s")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const row = (over: Record<string, unknown> = {}) => ({ session: "s1", workspace: "proj-1a2b3c4d", repo: "acme/widgets", branch: "feature/x", number: 7, head: "abc", ts: "2026-01-01T00:00:00.000Z", ...over });

test("appendPrRow writes one pr row per PR number and repository", () => {
  const dir = tmp();
  try {
    assert.equal(appendPrRow(dir, row()), true);
    assert.equal(appendPrRow(dir, row({ ts: "2026-01-01T00:05:00.000Z" })), false);
    assert.equal(appendPrRow(dir, row({ number: 8 })), true);
    assert.equal(appendPrRow(dir, row({ repo: "acme/other" })), true);
    const rows = fs.readFileSync(sessionFileOf(dir, "s1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.type, r.repo, r.number]), [["pr", "acme/widgets", 7], ["pr", "acme/widgets", 8], ["pr", "acme/other", 7]]);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["branch", "head", "number", "repo", "session", "ts", "type", "workspace"]);
    assert.equal(fs.existsSync(`${sessionFileOf(dir, "s1")}.lock`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendPrRow keeps a null branch and workspace as null", () => {
  const dir = tmp();
  try {
    appendPrRow(dir, row({ branch: null, workspace: null, head: null }));
    const [r] = fs.readFileSync(sessionFileOf(dir, "s1"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual([r.branch, r.workspace, r.head], [null, null, null]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendPrRow throws on a lock that stays held (the caller treats it as best effort)", () => {
  const dir = tmp();
  try {
    const file = sessionFileOf(dir, "s1");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "other");
    const t0 = Date.now();
    assert.throws(() => appendPrRow(dir, row()), /locked/);
    assert.ok(Date.now() - t0 >= 4500);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
