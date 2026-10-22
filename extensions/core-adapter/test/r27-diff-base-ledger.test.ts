// R27 item 5: a new ledger written through `write` is the round boundary: the next builder launch records its HEAD as the
// reviewer's diff base. Without the ledger write the base stays the first builder's HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
const HUB = (sig: string) => `package api\n\nfunc Send(${sig}) error {\n\treturn nil\n}\n`;

/** Builder (base A), a committed signature change (HEAD B), an optional ledger write, a second builder, then the reviewer's task. */
async function reviewerTask(t: Parameters<typeof r11Rig>[0], ledgerWrite: boolean): Promise<{ task: string; first: string; second: string }> {
  const a = await r11Rig(t, { default: "standard", revisionRounds: { standard: 1 } });
  git(a.project, "init", "-q");
  const hub = path.join(a.project, "hub.go");
  fs.writeFileSync(hub, HUB("msg []byte"));
  git(a.project, "add", "-A");
  git(a.project, "commit", "-q", "-m", "base");
  const first = git(a.project, "rev-parse", "HEAD");
  await a.launch({ agent: "builder", task: "build it" });
  fs.writeFileSync(hub, HUB("seq uint64, msg []byte"));
  git(a.project, "commit", "-q", "-am", "change");
  const second = git(a.project, "rev-parse", "HEAD");
  if (ledgerWrite) {
    const ledger = path.join(a.project, ".workflow", "LEDGER-r27.md");
    fs.writeFileSync(ledger, "# Round 27\n");
    await a.wrote(ledger);
  }
  // an uncommitted change on top: the diff against the recorded base shows it
  fs.writeFileSync(hub, HUB("seq uint64, ack bool, msg []byte"));
  await a.launch({ agent: "builder", task: "build more" });
  const reviewer = { agent: "reviewer", task: "review items 1" };
  await a.launch(reviewer);
  return { task: reviewer.task, first: first.slice(0, 12), second: second.slice(0, 12) };
}

test("a new ledger written through write resets the diff base: the next builder launch records the new HEAD", async (t) => {
  const { task, second } = await reviewerTask(t, true);
  assert.ok(task.includes(`against ${second}`), task);
});

test("without the ledger write the diff base stays the first builder's HEAD", async (t) => {
  const { task, first } = await reviewerTask(t, false);
  assert.ok(task.includes(`against ${first}`), task);
});
