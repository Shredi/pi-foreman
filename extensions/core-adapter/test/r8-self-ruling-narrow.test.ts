// R8 item 12: the self-ruling guard refuses only commands that can WRITE a ruling file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { childHandoffDirs } from "../owned.ts";
import { SELF_RULING_REASON, selfRulingMessage, selfRulingRefusal } from "../ruling.ts";

function rig() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r8sr-")));
  const up = path.join(root, "handoffs", "up");
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, "parent"), "other\n");
  fs.writeFileSync(path.join(up, "child"), "me\n");
  return { root, up, dirs: childHandoffDirs(path.join(root, "handoffs"), "me") };
}

test("r8 self ruling: the nine over-refused commands pass", () => {
  const r = rig();
  const h = r.up;
  const state = path.join(r.root, "state");
  for (const command of [
    `cat ${h}/ruling-pre-models.md ${h}/parent`,
    `ls -la ${h}; env | grep FOO; git log`,
    `grep -rlE "foo|bar" --include=*.ts .`,
    `cd extensions/core-adapter; ls; grep foo x ; grep bar y 2>/dev/null`,
    `ls ${state}/usage | tail`,
    `cd ${state}/usage; head -c 600 x.jsonl`,
    `grep foo ${h}/ci.log > .workflow/scratch/x.txt`,
    `cp ${h}/ci.log .workflow/scratch/`,
    `grep -E 'a|b' ${h}/log | cut -c1-3 | head`,
    `cat ${h}/ruling.md 2>&1 | head`,
  ]) assert.equal(selfRulingRefusal("bash", { command }, r.root, r.dirs), undefined, command);
});

test("r8 self ruling: real ruling writes stay refused and the message names the target", () => {
  const r = rig();
  const h = r.up;
  const cases = [
    `echo APPROVED > ${h}/ruling.md`,
    `cp x ${h}/ruling-2.md`,
    `cat x | tee ${h}/ruling.md`,
    `H=${h}; mv x "$H/ruling.md"`,
    `H=${h}; echo hi > "$H/anything"`,
    `cp ruling.md ${h}/`,
  ];
  for (const command of cases) {
    for (const tool of ["bash", "bg_run", "foreman_bg"]) assert.equal(selfRulingRefusal(tool, { command }, r.root, r.dirs), SELF_RULING_REASON, `${tool}: ${command}`);
  }
  const msg = selfRulingMessage("bash", { command: `cp x ${h}/ruling-2.md` }, r.root, r.dirs);
  assert.equal(msg, `pi-foreman: a session cannot write its own parent's ruling (target: ${h}/ruling-2.md).`.replace(/^pi-foreman: /, "").replace(/\.$/, ""));
});
