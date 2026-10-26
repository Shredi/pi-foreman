import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "../../setup.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = fs.realpathSync(path.resolve(HERE, "..", ".."));
const SETUP = path.join(ROOT, "setup.mjs");
const FAKE_PI = path.join(HERE, "fixtures", "fake-pi.mjs");

test("unifiedDiff marks only the changed lines, with two lines of context", () => {
  const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
  const lines = before.split("\n");
  lines.splice(1, 0, "inserted-top");
  lines[25] = "changed-low";
  const out = unifiedDiff("x.json", `${before}\n`, `${lines.join("\n")}\n`).split("\n");
  assert.deepEqual(out.slice(0, 2), ["--- a/x.json", "+++ b/x.json"]);
  assert.deepEqual(out.filter((l) => /^[+-][^+-]/.test(l)), ["+inserted-top", "-l24", "+changed-low"]);
  assert.equal(out.filter((l) => l.startsWith("@@")).length, 2);
  assert.match(out[2], /^@@ -1,3 \+1,4 @@$/);
});

test("unifiedDiff for a new file uses /dev/null", () => {
  assert.deepEqual(unifiedDiff("n.json", null, "a\nb\n").split("\n"), ["--- /dev/null", "+++ b/n.json", "@@ -0,0 +1,2 @@", "+a", "+b"]);
});

test("--dry-run --profile orchestration diffs only the toggle leaves and the profile line", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-diff-")));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pf-diff-data-"));
  try {
    const agentDir = path.join(base, "agent");
    const cwd = path.join(base, "project");
    fs.mkdirSync(agentDir);
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(agentDir, "settings.json"), `${JSON.stringify({ packages: ["git:github.com/Shredi/pi-foreman"] })}\n`);
    fs.writeFileSync(path.join(agentDir, "foreman.json"), `${JSON.stringify({ version: 1, providers: {}, ladder: { reviewerClimb: { enabled: true } } }, null, 2)}\n`);
    const r = spawnSync(process.execPath, [SETUP, "--dry-run", "--profile", "orchestration", "--agent-dir", agentDir], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_FOREMAN_PI_BIN: FAKE_PI, FAKE_PI_LOG: `${base}-calls.jsonl`, PI_FOREMAN_PI_AI_DATA: empty, PI_FOREMAN_PICKER: "off" },
    });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    const start = out.indexOf("--- a/foreman.json");
    assert.ok(start >= 0, out);
    const block = out.slice(start).split("\n");
    const end = block.findIndex((l, i) => i > 1 && /^(--- |\S)/.test(l) && !/^[-+@ ]/.test(l));
    const diff = block.slice(2, end < 0 ? undefined : end);
    const changed = diff.filter((l) => /^[+-]/.test(l));
    assert.ok(changed.includes('+  "profile": "orchestration",'), changed.join("\n"));
    assert.ok(changed.length < 60, `diff should be small, got ${changed.length} changed lines`);
    assert.equal(changed.filter((l) => l.startsWith("-")).length <= 10, true, changed.join("\n"));
    assert.ok(diff.findIndex((l) => l.includes('"version": 1')) < diff.findIndex((l) => l.includes('"profile"')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
