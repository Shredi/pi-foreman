// A reload across versions can leave a stale module so that startSession throws (`(intermediate value) is not iterable`): the owner gets a restart notice and every tool is refused with that reason.
import assert from "node:assert/strict";
import { test } from "node:test";
import { r11Rig } from "./_r11rig.ts";
import { PROBE_CODE } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";

test("a failed startSession notifies 'Restart Pi' and refuses tools with it, without starting again", async (t) => {
  const notes: string[] = [];
  let probes = 0;
  const spawner: typeof defaultSpawner = async (command, args, options) => {
    if (!args.includes(PROBE_CODE)) return defaultSpawner(command, args, options);
    probes++;
    throw new TypeError("(intermediate value) is not iterable");
  };
  const r = await r11Rig(t, {}, { deps: { spawner }, ctx: { ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } } });
  assert.ok(notes.some((n) => n.includes("Restart Pi") && n.includes("is not iterable")), notes.join("\n"));
  const seen = probes;
  assert.ok(seen > 0);
  const res = await r.call("bash", { command: "ls" });
  assert.ok(res && res.block, "the call is refused");
  assert.match(String(res.reason), /Restart Pi/);
  assert.doesNotMatch(String(res.reason), /no session to decide it in/);
  assert.equal(probes, seen, "no second start");
});
