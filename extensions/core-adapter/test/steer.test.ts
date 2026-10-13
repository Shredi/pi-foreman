import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STEER_HEADER, STEER_MAX_BYTES, SteerReader } from "../steer.ts";

function dir(t: { after(fn: () => void): void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-steer-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("steer.md newer than the last read is appended under the header, once per mtime", (t) => {
  const d = dir(t);
  const r = new SteerReader(() => [d]);
  assert.equal(r.append("woke"), "woke", "no steer.md");
  const f = path.join(d, "steer.md");
  fs.writeFileSync(f, "use B\n");
  fs.utimesSync(f, 1000, 1000);
  assert.equal(r.append("woke"), `woke\n\n${STEER_HEADER}\nuse B`);
  assert.equal(r.append("woke 2"), "woke 2", "same mtime: not repeated");
  fs.writeFileSync(f, "use C\n");
  fs.utimesSync(f, 2000, 2000);
  assert.equal(r.append("woke 3"), `woke 3\n\n${STEER_HEADER}\nuse C`);
});

test("steer.md is capped; no handoff dir is a no-op", (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, "steer.md"), "x".repeat(STEER_MAX_BYTES * 2));
  const out = new SteerReader(() => [d]).append("w");
  assert.ok(out.length < STEER_MAX_BYTES + 200);
  assert.match(out, /\[truncated\]$/);
  assert.equal(new SteerReader(() => []).append("w"), "w");
});
