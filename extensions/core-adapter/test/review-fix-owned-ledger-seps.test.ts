// Review fixes: literalOwnedDirs folds case on darwin/win32; planLedgerInit rejects every str.splitlines separator in a text.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { literalOwnedDirs } from "../owned.ts";
import { planLedgerInit } from "../ledgercall.ts";

test("literalOwnedDirs: a differently cased spelling of the root still carves out the scratch base (darwin, win32); linux is case-sensitive", () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-owned-case-")));
  try {
    const root = path.join(top, "Repo.worktrees");
    fs.mkdirSync(path.join(root, ".foreman", "scratch"), { recursive: true });
    fs.mkdirSync(path.join(root, "round1"));
    const spelled = path.join(top, "repo.worktrees");
    const base = path.join(spelled, ".foreman", "scratch");
    for (const platform of ["darwin", "win32"]) {
      const out = literalOwnedDirs([root], base, platform);
      assert.ok(!out.includes(root), `${platform}: the root is carved`);
      assert.ok(out.includes(path.join(root, "round1")), `${platform}: the sibling dir stays`);
    }
    // On a Windows host path is path.win32, whose relative() folds case itself, so the case-sensitive branch cannot be simulated.
    if (process.platform !== "win32") assert.deepEqual(literalOwnedDirs([root], base, "linux"), [root]);
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("planLedgerInit: every line separator in a text is refused, a plain space is not", () => {
  for (const cp of [0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]) {
    const bad = `a${String.fromCodePoint(cp)}b`;
    assert.ok("error" in planLedgerInit({ topic: "t", texts: [bad] }), `U+${cp.toString(16)}`);
  }
  assert.deepEqual(planLedgerInit({ topic: "t", texts: ["a b"] }), { topic: "t", texts: ["a b"] });
});
