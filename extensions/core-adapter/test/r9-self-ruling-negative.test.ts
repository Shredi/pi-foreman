// R9 item 12: NEGATIVE corpus from r8-item12-dropped (7900346). The indirect write forms whose target name is built by the shell
// ($D/$N) are NOT closed by the self-ruling guard (0a8b2bc). Each asserts the CURRENT decision (open = undefined); a future fix flips it visibly.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-neg-")));
  const hand = path.join(root, ".workflow", "handoffs");
  const H = path.join(hand, "up");
  fs.mkdirSync(H, { recursive: true });
  fs.writeFileSync(path.join(H, "parent"), "other\n");
  fs.writeFileSync(path.join(H, "child"), "me\n");
  return { root, H, dirs: childHandoffDirs(hand, "me") };
}

const OPEN: Array<[string, string]> = [
  ["git pager env", `GIT_PAGER="dd of=$D/$N" git show HEAD`],
  ["git external-diff env", `GIT_EXTERNAL_DIFF="dd of=$D/$N" git diff`],
  ["lessopen env", `LESSOPEN="|dd of=$D/$N" less x`],
  ["interpreter script args", `node w.js $D $N`],
  ["sed w", `sed -n "w $D/$N" x`],
  ["sort -uo", `sort -uo $D/$N x`],
  ["git diff --output=", `git diff --output=$D/$N`],
];

for (const [name, command] of OPEN) {
  test(`expected-open (R9): ${name} with a shell-built target is not refused`, () => {
    const { root, dirs } = rig();
    assert.equal(selfRulingRefusal("bash", { command }, root, dirs), undefined, command);
  });
}

test("expected-open (R9) control: the same form naming the file literally stays refused", () => {
  const { root, H, dirs } = rig();
  assert.equal(selfRulingRefusal("bash", { command: `sort -uo ${H}/ruling.md x` }, root, dirs), SELF_RULING_REASON);
});
