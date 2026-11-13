// applyRemoteNotice matches the cleaned origin machine against the stored name: control characters (C0, DEL, C1) are removed on both sides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyRemoteNotice } from "../remotesession.ts";
import type { Registry, SessionEntry } from "../session.ts";

const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const NOW = new Date("2026-10-25T12:00:00Z");
const notice = { kind: "refused" as const, reason: "no" };

function reg(originMachine: unknown): Registry {
  const e = { label: "demo", child: CHILD, parent: "sess-1", status: "open", machine: "alpha", originMachine, mirror: "", handoff: "" } as unknown as SessionEntry;
  return { version: 1, sessions: [e] };
}
const apply = (r: Registry, machine: string, sessionId = CHILD) => applyRemoteNotice(r, { machine, sessionId }, notice, undefined, NOW);

test("an origin machine with control characters matches the cleaned stored name", () => {
  assert.ok(apply(reg("winbox"), "win\u001bbox\n"));
  assert.ok(apply(reg("winbox"), "WIN\u007fbox\u009b"));
  assert.ok(apply(reg("win[2Jbox"), "win\u001b[2Jbox"), "the characters are removed, not replaced by a space");
});

test("a stored name that still carries control characters (an older row) matches its cleaned form", () => {
  assert.ok(apply(reg("win\u001bbox\n"), "winbox"));
  assert.ok(apply(reg("win\u001bbox"), "win\u0007box"));
});

test("a different session id still does not match", () => {
  assert.equal(apply(reg("winbox"), "win\u001bbox", "other-child"), null);
});

test("a different name still does not match", () => {
  assert.equal(apply(reg("winbox"), "win\u001bbox2"), null);
  assert.equal(apply(reg("winbox"), "win box"), null, "a space is not a removed control character");
});

test("a name of control characters only matches nothing", () => {
  assert.equal(apply(reg("\u001b\u0007"), "\u001b\u0007"), null);
  assert.equal(apply(reg(""), "\u001b"), null);
  assert.equal(apply(reg("winbox"), "\u001b\n"), null);
  assert.equal(apply(reg(null), "winbox"), null);
});
