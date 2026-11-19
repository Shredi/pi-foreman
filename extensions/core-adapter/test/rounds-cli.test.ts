// `foreman rounds` (rounds-cli.ts): the filters, the text and JSON output, the usage errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionFileOf } from "../findings.ts";
import { main, USAGE } from "../rounds-cli.ts";
import type { RoundsDeps } from "../rounds-cli.ts";
import { workspaceKey } from "../workspacekey.ts";

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roundscli-")));
const rev = (run: string, workspace: string, branch: string, over: Record<string, unknown> = {}) => ({ type: "review", session: "s1", gate: "item", primary: true, runId: run, verdict: "PASS", workspace, branch, ts: "2026-01-01T00:00:00Z", ...over });

function rig(rows: Record<string, unknown>[], over: Partial<RoundsDeps> = {}) {
  const agentDir = tmp();
  const file = sessionFileOf(agentDir, "s1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const deps: RoundsDeps = { agentDir, cwd: agentDir, now: () => Date.parse("2026-01-31T00:00:00Z"), workspaceOverride: async () => undefined, ...over };
  const run = async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(argv, (s) => void (out += s), (s) => void (err += s), () => deps);
    return { code, out, err };
  };
  return { agentDir, run, done: () => fs.rmSync(agentDir, { recursive: true, force: true }) };
}

test("rounds prints one line per change; --json prints the objects", async () => {
  const h = rig([rev("r1", "p-1", "feat", { verdict: "FAIL" }), rev("r2", "p-1", "feat", { gate: "pre-pr" }), { type: "pr", session: "s1", workspace: "p-1", branch: "feat", number: 301, ts: "2026-01-01T00:01:00Z" }, rev("r3", "p-2", "other")]);
  try {
    const text = await h.run();
    assert.equal(text.code, 0);
    assert.equal(text.out, "p-1 feat: Review rounds: 2 (1 fail, 1 pass), PR #301\np-2 other: Review rounds: 1 (0 fail, 1 pass)\n");
    const json = JSON.parse((await h.run("--json")).out);
    assert.deepEqual(json.map((c: { workspace: string; branch: string; pr: number | null; rounds: number; fail: number; pass: number }) => [c.workspace, c.branch, c.pr, c.rounds, c.fail, c.pass]), [["p-1", "feat", 301, 2, 1, 1], ["p-2", "other", null, 1, 0, 1]]);
    assert.equal(json[0].line, "Review rounds: 2 (1 fail, 1 pass), PR #301");
  } finally {
    h.done();
  }
});

test("rounds filters by workspace, branch, PR and since", async () => {
  const h = rig([rev("r1", "p-1", "feat", { ts: "2025-12-01T00:00:00Z" }), rev("r2", "p-1", "feat"), rev("r3", "p-2", "other"), { type: "pr", session: "s1", workspace: "p-1", branch: "feat", number: 7, ts: "2026-01-02T00:00:00Z" }]);
  try {
    assert.equal((await h.run("--workspace", "p-2")).out, "p-2 other: Review rounds: 1 (0 fail, 1 pass)\n");
    assert.equal((await h.run("--branch", "feat", "--json")).out.includes('"p-2"'), false);
    assert.equal(JSON.parse((await h.run("--pr", "7", "--json")).out).length, 1);
    assert.equal((await h.run("--pr", "8")).out, "no review rounds\n");
    assert.equal(JSON.parse((await h.run("--workspace", "p-1", "--since", "30d", "--json")).out)[0].rounds, 1);
    assert.equal(JSON.parse((await h.run("--workspace", "p-1", "--json")).out)[0].rounds, 2);
  } finally {
    h.done();
  }
});

test("--workspace here is the key of the main checkout, with the config override", async () => {
  const repo = tmp();
  try {
    execFileSync("git", ["-C", repo, "init", "-q"]);
    const key = workspaceKey(repo);
    const h = rig([rev("r1", key, "feat"), rev("r2", "custom-key", "feat"), rev("r3", "p-2", "x")], { cwd: repo });
    try {
      assert.equal(JSON.parse((await h.run("--workspace", "here", "--json")).out)[0].workspace, key);
      const withOverride = rig([rev("r2", "custom-key", "feat")], { cwd: repo, workspaceOverride: async () => "custom-key" });
      try {
        assert.equal(JSON.parse((await withOverride.run("--workspace", "here", "--json")).out).length, 1);
      } finally {
        withOverride.done();
      }
    } finally {
      h.done();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an empty or missing store prints no entries; --json prints []", async () => {
  const h = rig([]);
  try {
    assert.deepEqual(await h.run(), { code: 0, out: "no review rounds\n", err: "" });
    assert.equal((await h.run("--json")).out, "[]\n");
  } finally {
    h.done();
  }
});

test("bad arguments print the usage and exit 2", async () => {
  const h = rig([]);
  try {
    for (const argv of [["nope"], ["--pr"], ["--pr", "x"], ["--pr", "0"], ["--workspace"], ["--branch"], ["--since"]]) {
      const r = await h.run(...argv);
      assert.equal(r.code, 2, argv.join(" "));
      assert.equal(r.err, `${USAGE}\n`);
    }
    const bad = await h.run("--since", "soon");
    assert.equal(bad.code, 2);
    assert.match(bad.err, /bad --since soon/);
  } finally {
    h.done();
  }
});
