// A resumed pane: the restarted Pi reports to Herdr itself (the Herdr Pi integration runs inside it), so buildSpawnEnv must keep the HERDR_* variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnEnv } from "../paneresume-core.ts";

test("buildSpawnEnv keeps HERDR_PANE_ID and the other HERDR_* variables", () => {
  const base = { HERDR_ENV: "1", HERDR_PANE_ID: "p_1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w_1", PI_FOREMAN_HANDOFF_DIR: "/x", PATH: "/bin" };
  const env = buildSpawnEnv(base, null, 1000);
  for (const k of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "PATH"]) assert.equal(env[k], base[k as keyof typeof base], k);
  assert.equal("PI_FOREMAN_HANDOFF_DIR" in env, false);
});
