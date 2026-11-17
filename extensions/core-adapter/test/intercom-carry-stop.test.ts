// PR 2 of the intercom round: a parent's intercom message does not lift a child's [review_loop] stop (a brief does, pinned in r58-loop-guard.test.ts);
// a message sent by the child to the parent and one coming in from the parent leave it as it is.
import "./_hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { world } from "./_r46world.ts";
import { loopRefused, stopLoop } from "./_loopstop.ts";

const parented = { ceremony: { default: "standard" }, handoff: true, parent: true };

test("an intercom message from the parent, and the child's send to it, do not lift the stop; a brief then does", async (t) => {
  const w = world(t, parented);
  const a = await w.adapter("startup");
  await stopLoop(a);
  assert.ok(loopRefused(await a.launch("builder")));
  const input = { action: "send", to: "parent-session", message: "Question: how do we go on?" };
  await a.checkCall("intercom", input);
  await a.fire("tool_result", { toolName: "intercom", toolCallId: "s1", input, details: { delivered: true }, content: [{ type: "text", text: "Message sent to parent-session" }], isError: false });
  await a.fire("message_end", { message: { role: "custom", customType: "intercom_message", details: { from: { id: "parent-session", name: "main" }, bodyText: "Answer: try again", message: { content: { text: "**From main**\n\nAnswer: try again" } } }, content: "Answer: try again" } });
  assert.ok(loopRefused(await a.launch("builder")), "a message lifts nothing");
  assert.equal((await w.traceEvents()).filter((r) => r.event === "cap_reset").length, 0);
  fs.writeFileSync(path.join(w.handoff, "brief-1.md"), "go on differently\n");
  assert.equal(await a.launch("builder"), undefined, "a brief lifts it");
  assert.equal((await w.traceEvents()).filter((r) => r.event === "cap_reset" && r.by === "brief").length, 1);
});

test("a send to the parent changes no live-file field and writes no ask or seen file", async (t) => {
  const w = world(t, parented);
  const a = await w.adapter("startup");
  const snap = () => {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.json$|^\.ask$|^\.seen$|^ask/.test(e.name)) out[p] = fs.readFileSync(p, "utf8").replace(/"(heartbeatAt|updatedAt)":"[^"]*"/g, "");
      }
    };
    walk(path.join(process.env.PI_CODING_AGENT_DIR ?? "", "pi-foreman"));
    return out;
  };
  const before = snap();
  const input = { action: "send", to: "parent-session", message: "Question: which?" };
  await a.checkCall("intercom", input);
  await a.fire("tool_result", { toolName: "intercom", toolCallId: "s1", input, details: { delivered: true }, content: [{ type: "text", text: "Message sent to parent-session" }], isError: false });
  assert.deepEqual(snap(), before);
  assert.equal(fs.existsSync(path.join(w.handoff, ".ask")), false);
});
