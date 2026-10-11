import { test } from "node:test";
import assert from "node:assert/strict";
import { claimCore } from "../registry.ts";
import overlay from "./fixtures/overlay-handshake.ts";

function startSession(): string[][] {
  const handlers: Record<string, (e: unknown, ctx: unknown) => unknown> = {};
  const notes: string[][] = [];
  overlay({ on: (name: string, fn: (e: unknown, ctx: unknown) => unknown) => (handlers[name] = fn) } as never);
  handlers.session_start({}, { ui: { notify: (m: string, l: string) => notes.push([m, l]) } });
  return notes;
}

test("overlay handshake: core key absent gives one documented notify, no throw", () => {
  const notes = startSession();
  assert.equal(notes.length, 1);
  assert.equal(notes[0][0], "pi-foreman core adapter not loaded; install it with pi install git:github.com/Shredi/pi-foreman");
  assert.equal(notes[0][1], "warning");
});

test("overlay handshake: core key present gives no notify", () => {
  const claim = claimCore(process.cwd());
  assert.ok(claim.active);
  try {
    assert.deepEqual(startSession(), []);
  } finally {
    if (claim.active) claim.release();
  }
});
