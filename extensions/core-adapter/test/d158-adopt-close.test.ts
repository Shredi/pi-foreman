// D158: after `foreman session adopt` rewrites the handoff `parent` file, a close from the new parent is accepted and one from the old parent is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { closeFrom, intercomClose, parentIntercomId } from "../close.ts";
import { trackedTmp } from "./_tmpbase.ts";

test("close after adoption: the new parent closes, the old parent is refused (the parent file is re-read)", () => {
  const dir = fs.realpathSync.native(trackedTmp("pf-adopt-close-"));
  const env = { PI_FOREMAN_HANDOFF_DIR: dir, PI_FOREMAN_PARENT_INTERCOM: "old-parent" };
  const msg = (id: string) => ({ from: { id, name: "p" }, message: { content: { text: "foreman:close" } } });
  const all = closeFrom({});
  fs.writeFileSync(path.join(dir, "parent"), "old-parent\n");
  assert.equal((intercomClose(msg("old-parent"), parentIntercomId(env), all) as { kind: string }).kind, "close");
  fs.writeFileSync(path.join(dir, "parent"), "new-parent\n"); // what adopt writes
  assert.equal((intercomClose(msg("new-parent"), parentIntercomId(env), all) as { kind: string }).kind, "close");
  assert.deepEqual(intercomClose(msg("old-parent"), parentIntercomId(env), all), { kind: "refused", reason: "the sender is not the parent recorded at spawn", sender: "old-parent" });
});
