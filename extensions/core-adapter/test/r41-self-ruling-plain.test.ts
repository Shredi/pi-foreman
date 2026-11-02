// R41 item 23: the plain literal-path rows of the retired r16 self-ruling rig (retired/r16-self-ruling-retired.test.ts, removed with the
// old auto reviewer). A session writing its own parent's ruling stays a deny: the gate's review allows (stub), and the self_ruling guard
// that runs after the gate refuses. The old rig's "no model call" count is not asserted: the gate asks its review first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const rig = await r11Rig({ after }, {}, reviewAllowOpts());
const up = rig.handoff("up", "child");
const own = rig.handoff("own", "child");
const S = path.join(rig.project, "scratch");
fs.mkdirSync(S, { recursive: true });
for (const [f, t] of [[path.join(up, "ruling.md"), "APPROVED\n"], [path.join(own, "ruling-2.md"), "APPROVED\n"]]) fs.writeFileSync(f, t);

const LINES = [
  "echo A > {up}/ruling.md",
  "echo A | tee {up}/ruling.md",
  "cp {S}/x {up}/ruling.md",
  "sed -i s/FAIL/APPROVED/ {up}/ruling.md",
  "echo A | dd of={up}/ruling.md",
  'sh -c "echo A > {up}/ruling.md"',
  "python3 -c \"open('{up}/ruling.md','w')\"",
  "exec 3> {up}/ruling.md",
  "truncate -s 0 {up}/ruling.md",
  "mv {own}/ruling-2.md {S}/y",
];

for (const line of LINES) {
  test(`self-ruling plain path stays a deny through the gate: ${line.split("\n")[0]}`, async () => {
    const n0 = rig.trace().length;
    const res = await rig.call("bash", { command: line.replace(/\{up\}/g, inBash(up)).replace(/\{own\}/g, inBash(own)).replace(/\{S\}/g, inBash(S)) });
    const recs = rig.trace().slice(n0);
    assert.equal(res?.block, true, JSON.stringify(recs));
    // ruling-10: the mv into the project is a foreman shell write the edit mode refuses before the gate, so it never reaches the self_ruling guard
    if (line.startsWith("mv ")) return assert.ok(recs.some((x) => x.event === "shell_write_refused" && x.kind === "mv"), JSON.stringify(recs));
    assert.ok(recs.some((x) => x.event === "guard" && (x.guard === "self_ruling" || (x.guard === "gate" && x.decision === "blocked"))), JSON.stringify(recs));
  });
}
