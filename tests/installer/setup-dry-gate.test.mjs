import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");

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

test("dry run against an agent dir with the old permission keys exits 0, prints the gate migration and writes nothing", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dry-gate-")));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dry-gate-data-"));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
    fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ review: { childDefer: "owner" }, providers: { x: { review: { model: "x/m" } } } }));
    const before = snapshot(base);
    const r = spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), "--dry-run", "--agent-dir", agentDir], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: dataDir },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /permNeedRecord/);
    assert.match(out, /review\.childDefer: moved to gate\.childAsk/);
    assert.match(out, /providers\.x\.review\.model: moved to providers\.x\.roles\.review\.model/);
    assert.deepEqual(snapshot(base), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Reaches `if (needRecord || permNeedRecord)` in the dry branch: that line is only evaluated when the recorded subagents hash already matches, so a real install comes first.
test("dry run against a recorded install with the old permission keys still present exits 0 and does not read an undefined permNeedRecord", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-dry-gate-recorded-")));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dry-gate-recorded-data-"));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: dataDir };
    const setup = (args) => spawnSync(process.execPath, [path.join(ROOT, "setup.mjs"), ...args, "--agent-dir", agentDir], { cwd, encoding: "utf8", env });
    const first = setup([]);
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    const managed = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-foreman", "managed.json"), "utf8"));
    assert.match(Object.values(managed.entries)[0].subagentsHash, /^[0-9a-f]{64}$/);
    const foreman = path.join(agentDir, "foreman.json");
    const cfg = JSON.parse(fs.readFileSync(foreman, "utf8"));
    fs.writeFileSync(foreman, JSON.stringify({ ...cfg, review: { ...cfg.review, childDefer: "owner" } }));
    const r = setup(["--dry-run"]);
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.doesNotMatch(out, /is not defined/);
    assert.match(out, /review\.childDefer: moved to gate\.childAsk/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
