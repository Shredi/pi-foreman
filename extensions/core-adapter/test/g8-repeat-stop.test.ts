// rw4 item 7 side effect: a floor denial now names the tool and the matched fragment, and the repeat stop of a child (R12 item 4, R41) must still count
// the same refusal by the floor's own sentence: a child that reads a secret path with `read` and then with a shell `cat` is stopped on the second try.
// In-process, no child process (the rig of _g8rig.ts). Test text names a secret path as data; nothing runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REPEAT_REFUSAL_ERROR } from "../launchwait.ts";
import { r11RigNoSpawn } from "./_g8rig.ts";

const KEY = "~/.ssh/id_rsa";

test("a child's secret-path read and then a shell cat of the same path is the same refusal: the second try stops the run", async (t) => {
  const savedExit = process.exitCode;
  t.after(() => void (process.exitCode = savedExit));
  const rig = await r11RigNoSpawn(t, { child: true });
  const first = await rig.call("read", { path: KEY });
  assert.equal(first?.block, true);
  assert.match(first?.reason ?? "", /is a secret or key path/);
  assert.match(first?.reason ?? "", /\(tool: read; matched: /, "the denial still names the tool and the fragment");
  assert.doesNotMatch(first?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  const second = await rig.call("bash", { command: `cat ${KEY}` });
  assert.equal(second?.block, true);
  assert.match(second?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR), "the second refusal of the same floor sentence stops the run");
  assert.equal(process.exitCode, 1);
});

test("the same secret path through the same tool twice still stops the run, and two different paths do not", async (t) => {
  const savedExit = process.exitCode;
  t.after(() => void (process.exitCode = savedExit));
  const rig = await r11RigNoSpawn(t, { child: true });
  assert.doesNotMatch((await rig.call("bash", { command: "cat ~/.ssh/id_rsa" }))?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.doesNotMatch((await rig.call("bash", { command: "cat ~/.ssh/id_ed25519" }))?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
  assert.match((await rig.call("bash", { command: "cat ~/.ssh/id_rsa" }))?.reason ?? "", new RegExp(REPEAT_REFUSAL_ERROR));
});
