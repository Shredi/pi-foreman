// R9 item 12: NEGATIVE corpus from r8-item12-dropped (7900346). The indirect write forms whose target name is built by the shell
// ($D/$N) are NOT closed by the self-ruling guard (0a8b2bc). Each asserts the CURRENT decision (open = undefined); a future fix flips it visibly.
// R16 item 4a: the CLOSED (R13) rows and the literal control row live in test/retired/self-ruling-rows.json with their outcome now.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-neg-")));
  const hand = path.join(root, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  return { root, dirs: childHandoffDirs(hand, "me") };
}

const OPEN: Array<[string, string]> = [
  ["interpreter script args", `node w.js $D $N`],
];

for (const [name, command] of OPEN) {
  test(`expected-open (R9): ${name} with a shell-built target is not refused`, async () => {
    const { root, dirs } = rig();
    assert.equal(await selfRulingRefusal("bash", { command }, root, dirs), undefined, command);
  });
}
