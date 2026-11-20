// Revision of the restart round: the bridge notice names no isolation folder when isolation is off; the close flow marks the
// worktree retry (`worktreePending`) of a local child it sent a close to, and no other entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BRIDGE_PROVIDER, bridgeAuthNotice } from "../bridgeiso.ts";
import { closeChildren } from "../closechildren.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";

test("the bridge login notice with isolation off names plain `claude auth login` and no folder", () => {
  const text = bridgeAuthNotice(BRIDGE_PROVIDER, 401, null) ?? "";
  assert.ok(text.includes("claude auth login"), text);
  assert.ok(!text.includes("CLAUDE_CONFIG_DIR"), text);
});

test("the close flow marks the local child it closed for the worktree retry, not a child it did not send to", async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "pf-wtmark-"));
  const mk = (child: string): SessionEntry => ({ label: child, child, parent: "p", handoff: "/h", status: "open", backend: "hc", hc: { address: "t7" }, briefs: 0, lastError: null, last: null }) as unknown as SessionEntry;
  const A = "0a1b2c3d-0000-4000-8000-0123456789ab";
  const B = "0a1b2c3d-0000-4000-8000-0123456789ac";
  writeRegistry(dir, { version: 1, sessions: [mk(A), { ...mk(B), parent: "other" }] });
  await closeChildren({ agentDir: dir, opener: "p", waitMs: 0, send: async () => "sent", sleep: async () => undefined, runRemote: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) as never });
  const reg = readRegistry(dir);
  assert.equal(reg.sessions.find((e) => e.child === A)?.worktreePending, true);
  assert.equal(reg.sessions.find((e) => e.child === B)?.worktreePending, undefined);
});
