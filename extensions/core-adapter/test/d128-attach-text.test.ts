// Item 128 (non-footer part): the pending checkpoint text and the remote plan/ask wake name where the owner answers: the session's pane, `hc attach` for a remote one.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./_r46world.ts";

test("a checkpoint with no owner pane stays pending and says the owner answers in the session's pane (hc attach for a remote session)", async (t) => {
  const w = world(t, { handoff: true, parent: true });
  const a = await w.adapter("startup");
  assert.equal(await a.review("PASS"), null);
  (a.ctx as { hasUI: boolean }).hasUI = false;
  const r = await a.checkpoint();
  assert.equal(r.decision, "pending");
  assert.match(r.text, /answers a checkpoint in this session's pane only \(a session on another machine: `hc attach <machine>\/<t>`/);
  assert.match(r.text, /a file or message does not answer it/);
});
