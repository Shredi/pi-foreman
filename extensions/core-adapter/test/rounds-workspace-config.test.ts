// `foreman rounds --workspace here` through the real config path: the key equals workspaceKey's (and Python's) for each retro.workspaceKey value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionFileOf } from "../findings.ts";
import { main, realDeps } from "../rounds-cli.ts";
import { mainCheckout, workspaceKey } from "../workspacekey.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");
const HAVE_PY = spawnSync(PY, ["-I", "-c", "pass"]).status === 0;
const VALUES: unknown[] = [" ﻿ ", " my key ", "", "   ", 42, ["k"], null];

test("rounds --workspace here: the key of each retro.workspaceKey value is workspaceKey's, as Python's", { skip: !HAVE_PY }, async () => {
  const root = mainCheckout(process.cwd());
  for (const value of VALUES) {
    const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roundscfg-")));
    try {
      fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ retro: { workspaceKey: value } }));
      const want = workspaceKey(root, value);
      const py = spawnSync(PY, ["-I", "-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(PKG, "scripts"))}); import foreman_backlog as bl\nprint(bl.workspace_key(sys.argv[1], {"retro": {"workspaceKey": json.loads(sys.argv[2])}}))`, root, JSON.stringify(value)], { encoding: "utf8" });
      assert.equal(py.status, 0, py.stderr);
      assert.equal(want, py.stdout.trim(), JSON.stringify(value));
      const file = sessionFileOf(agentDir, "s1");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: "review", session: "s1", gate: "item", primary: true, runId: "r1", verdict: "PASS", workspace: want, branch: "b", ts: "2026-01-01T00:00:00Z" }) + "\n");
      const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
      let out = "";
      const code = await main(["--workspace", "here", "--json"], (s) => void (out += s), () => undefined, () => realDeps(env));
      assert.equal(code, 0);
      assert.equal(JSON.parse(out).length, 1, `${JSON.stringify(value)} -> ${want}`);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
  }
});
