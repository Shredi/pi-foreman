// The parent's registry fields of a remote close attempt (`closeTriedAt`, `closeExpiredAt`, set by scripts/foreman_session.py)
// do not change how a notice is applied: a `closed` notice closes an `open` entry that has them, and every notice stamps
// `last.at`, which `close-remote --force` reads to see that the child answered after the attempt.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyRemoteNotice, parseRemoteNotice } from "../remotesession.ts";
import type { Registry, SessionEntry } from "../session.ts";

const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const origin = { machine: "alpha", sessionId: CHILD };
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "pf-attempt-"));

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return { label: "demo", child: CHILD, parent: "sess-1", status: "open", handoff: mirror, machine: "alpha", originMachine: "Alpha", remoteHandoff: "/h/x", handoffName: "x", mirror, remote: { platform: "linux" }, closeTriedAt: 1_700_000_000, closeExpiredAt: 1_700_000_100, ...over } as SessionEntry;
}
const regOf = (...s: SessionEntry[]): Registry => ({ version: 1, sessions: s });

test("a closed notice closes an open entry that has a tried time and the expiry mark", () => {
  const e = entry();
  const n = parseRemoteNotice("foreman:closed CLOSE: ready");
  assert.ok(n);
  assert.equal(applyRemoteNotice(regOf(e), origin, n)?.entry.status, "closed");
  assert.ok(e.last?.at);
});

test("a refused notice reopens a closing entry and stamps last.at", () => {
  const e = entry({ status: "closing" });
  const n = parseRemoteNotice("foreman:refused uncommitted-work");
  assert.ok(n);
  const r = applyRemoteNotice(regOf(e), origin, n);
  assert.equal(r?.entry.status, "open");
  assert.equal(typeof e.last?.at, "string");
});
