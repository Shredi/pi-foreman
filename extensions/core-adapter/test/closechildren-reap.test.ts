// D120: a local child that turns `closed` in the close flow gets its kept terminal reaped (the `reap` verb), bounded; a remote one does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { closeChildren } from "../closechildren.ts";
import { readRegistry, writeRegistry } from "../session.ts";
import type { SessionEntry } from "../session.ts";
import { trackedTmp } from "./_tmpbase.ts";

const root = fs.realpathSync.native(trackedTmp("pf-closereap-"));
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const local = (): SessionEntry => ({ label: "demo", child: CHILD, parent: "p", handoff: "/h", status: "open", backend: "hc", hc: { address: "t7" }, briefs: 0, lastError: null, last: null }) as unknown as SessionEntry;

test("a local child that reports closed: the reap verb runs once", async () => {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: [local()] });
  const ran: string[][] = [];
  const lines = await closeChildren({
    agentDir: dir, opener: "p", waitMs: 3000,
    send: async () => {
      const reg = readRegistry(dir);
      reg.sessions[0].status = "closed";
      writeRegistry(dir, reg);
      return "sent";
    },
    sleep: async () => undefined,
    runRemote: async (args) => (ran.push(args), { code: 0, stdout: "", stderr: "", timedOut: false } as never),
  });
  assert.deepEqual(ran, [["reap"]]);
  assert.match(lines[0], /: closed/);
});

test("a local child that does not close: no reap", async () => {
  const dir = fs.mkdtempSync(path.join(root, "agent-"));
  writeRegistry(dir, { version: 1, sessions: [local()] });
  const ran: string[][] = [];
  await closeChildren({
    agentDir: dir, opener: "p", waitMs: 0, send: async () => "sent", sleep: async () => undefined,
    runRemote: async (args) => (ran.push(args), { code: 0, stdout: "", stderr: "", timedOut: false } as never),
  });
  assert.deepEqual(ran, []);
});
