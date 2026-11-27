// The RangeError backstop of parseShell (shellast.ts): a stack overflow while parsing or walking ends the line as the one unreadable segment marked `tooDeep` (judge-first), never a
// partial segment list. The long-expression test of shellast-deep.test.ts no longer overflows, so this one runs the parse in a child node with a small `--stack-size` and
// burns the stack down to the band where the parse itself runs out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseShell } from "../shellast.ts";

// a loaded full-suite run slows each child far beyond its 1 s of own work; the limit is a hang guard, not a speed claim
const CHILD_TIMEOUT_MS = 120_000;
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "parse-small-stack.mjs");

// The frame sizes of the parse differ by engine tier: optimised code inlines the parse into one big frame, so the stack runs out at its entry and never inside it, and a loaded machine tiers up
// at other moments. The child runs interpreter-only, so every frame has the same size on every run and machine (`--jitless` cannot be used: node strips the TypeScript with WebAssembly).
const NO_JIT = ["--no-turbofan", "--no-maglev", "--no-sparkplug"];

type Outcome = { segments?: number; opaque?: string | null; tooDeep?: boolean; threw?: string; inBody?: boolean; top?: string; overflowedOutside?: boolean };

test("parseShell: a stack overflow inside the parse ends the line as one tooDeep parse_error segment, never a partial list", { timeout: 5 * CHILD_TIMEOUT_MS }, () => {
  const outcomes: Outcome[] = [];
  const notes: string[] = [];
  // the stack a node child starts with differs by version and flags: a few small sizes, each scanned over the band where the parse runs out
  for (const size of [70, 85, 100, 120]) {
    const run = spawnSync(process.execPath, [...process.execArgv.filter((a) => !a.startsWith("--stack-size")), ...NO_JIT, `--stack-size=${size}`, fixture], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS });
    // a child killed by the timeout (error ETIMEDOUT) is a loaded machine; a child ended by a signal or a nonzero status is a crash: both fail, with the cause named
    const cause = run.error ? `spawn error ${(run.error as NodeJS.ErrnoException).code ?? run.error.message} (timeout ${CHILD_TIMEOUT_MS} ms)` : run.signal ? `killed by ${run.signal}` : `status ${run.status}`;
    assert.equal(run.status, 0, `--stack-size=${size}: ${cause}; stderr: ${run.stderr}`);
    const out = JSON.parse(run.stdout) as { total: number; scannedTo: number; fullAt: number; results: Outcome[] };
    notes.push(`size ${size}: total ${out.total}, headroom scanned 0..${out.scannedTo}, first full read at ${out.fullAt}, ${out.results.filter((o) => o.tooDeep).length} tooDeep`);
    outcomes.push(...out.results);
  }
  // `threw` is an error that left parseShell. `inBody` marks one that came out of the guarded parse or walk (a hole in the guard); the others were thrown by the call itself or by the backstop's own
  // few frames, when the caller had no stack left for them: no guard can answer those
  const kinds = { tooDeep: 0, full: 0, threw: 0, threwFromBody: 0, overflowedOutside: 0 };
  for (const o of outcomes) kinds[o.tooDeep ? "tooDeep" : o.threw ? (o.inBody || o.threw !== "RangeError" ? "threwFromBody" : "threw") : o.overflowedOutside ? "overflowedOutside" : "full"]++;
  const summary = `${JSON.stringify(kinds)}; ${notes.join("; ")}`;
  assert.equal(kinds.threwFromBody, 0, `no overflow escapes the guarded parse or walk: ${JSON.stringify(outcomes.filter((o) => o.threw && (o.inBody || o.threw !== "RangeError")).slice(0, 5))}; ${summary}`);
  const stopped = outcomes.filter((o) => o.tooDeep);
  assert.ok(stopped.length > 0, `the scan reached the backstop at least once: ${summary}`);
  for (const o of stopped) assert.deepEqual(o, { segments: 1, opaque: "parse_error", tooDeep: true });
  // every other outcome that reached the end is the full read of the line (five segments); the rest ran out of stack before parseShell was called or in the handler itself
  for (const o of outcomes.filter((x) => x.segments !== undefined && !x.tooDeep)) assert.deepEqual(o, { segments: 5, opaque: null, tooDeep: false });
});

test("parseShell: a RangeError thrown by the parse step ends the line as one tooDeep parse_error segment", () => {
  const segs = parseShell("echo hi", { platform: "linux", parse: () => { throw new RangeError("Maximum call stack size exceeded"); } });
  assert.deepEqual(segs.map((x) => ({ segments: segs.length, opaque: x.opaque, tooDeep: !!x.tooDeep })), [{ segments: 1, opaque: "parse_error", tooDeep: true }]);
});

test("parseShell: the regexp engine's stack overflow (a SyntaxError) is tooDeep too, anywhere in the parse", () => {
  const regexp = () => { throw new SyntaxError("Invalid regular expression: /[\\\\/]/: Stack overflow"); };
  const segs = parseShell("echo hi", { platform: "linux", parse: regexp });
  assert.deepEqual(segs.map((x) => ({ segments: segs.length, opaque: x.opaque, tooDeep: !!x.tooDeep })), [{ segments: 1, opaque: "parse_error", tooDeep: true }]);
});

test("parseShell: a real stack overflow inside the parse step is tooDeep on any stack size", () => {
  const down = (n: number): number => down(n + 1) + 1;
  const segs = parseShell("echo hi", { platform: "linux", parse: () => down(0) as never });
  assert.deepEqual(segs.map((x) => ({ segments: segs.length, opaque: x.opaque, tooDeep: !!x.tooDeep })), [{ segments: 1, opaque: "parse_error", tooDeep: true }]);
});

test("parseShell: a SyntaxError that is no stack overflow, raised inside the walk, still propagates", () => {
  const env = new Proxy({} as Record<string, string>, { get(): never { throw new SyntaxError("Unexpected token"); } });
  assert.throws(() => parseShell("echo $FOREMAN_SCRATCH/x", { platform: "linux", env }), SyntaxError);
});
