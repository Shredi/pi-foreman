// The RangeError backstop of parseShell (shellast.ts): a stack overflow while parsing or walking ends the line as the one unreadable segment marked `tooDeep` (judge-first), never a
// partial segment list. The long-expression test of shellast-deep.test.ts no longer overflows, so this one runs the parse in a child node with a small `--stack-size` and
// burns the stack down to the band where the parse itself runs out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "parse-small-stack.mjs");

type Outcome = { segments?: number; opaque?: string | null; tooDeep?: boolean; threw?: string; overflowedOutside?: boolean };

test("parseShell: a stack overflow inside the parse ends the line as one tooDeep parse_error segment, never a partial list", () => {
  const outcomes: Outcome[] = [];
  // the stack a node child starts with differs by version and flags: a few small sizes, each scanned over the band where the parse runs out
  for (const size of [85, 100, 120]) {
    const run = spawnSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith("--stack-size")), `--stack-size=${size}`, fixture], { encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    outcomes.push(...(JSON.parse(run.stdout) as Outcome[]));
  }
  const stopped = outcomes.filter((o) => o.tooDeep);
  assert.ok(stopped.length > 0, "the scan reached the backstop at least once");
  for (const o of stopped) assert.deepEqual(o, { segments: 1, opaque: "parse_error", tooDeep: true });
  // every other outcome that reached the end is the full read of the line (five segments); the rest ran out of stack before parseShell was called or in the handler itself
  for (const o of outcomes.filter((x) => x.segments !== undefined && !x.tooDeep)) assert.deepEqual(o, { segments: 5, opaque: null, tooDeep: false });
});
