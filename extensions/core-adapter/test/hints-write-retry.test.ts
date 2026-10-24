// Ledger hint writes (hints.ts writeHint) when the rename over the ledger is refused while another process holds the file
// (Windows: EPERM, EACCES, EBUSY). The rename is injected: a retry that succeeds lands the hint; a rename that keeps failing
// leaves the ledger and the temp dir as they were and reports the code and the attempts through onFail (the adapter turns
// that into a `hint_write_failed` trace record); any other error is not retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { HintLog, writeHint } from "../hints.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const LEDGER = "# L\n\n- [ ] 1. a\n- [ ] V. verify\n";
const NOW = new Date("2026-10-24T12:00:00Z");

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: refused`), { code });

/** A temp dir holding one ledger; the caller removes the dir. */
function ledgerDir(): { dir: string; ledger: string } {
  const dir = mkTestTmp("hint-write-");
  const ledger = path.join(dir, "LEDGER-t.md");
  fs.writeFileSync(ledger, LEDGER, "utf8");
  return { dir, ledger };
}

test("hint write: the default rename lands the hint under the cited item", () => {
  const { dir, ledger } = ledgerDir();
  try {
    assert.deepEqual(writeHint(ledger, ["1"], "ledger mark", undefined, { now: NOW }), ["1"]);
    assert.equal(fs.readFileSync(ledger, "utf8"), "# L\n\n- [ ] 1. a\n  > 2026-10-24 ledger mark\n- [ ] V. verify\n");
    assert.deepEqual(fs.readdirSync(dir), ["LEDGER-t.md"]);
  } finally {
    rmTestTmp(dir);
  }
});

test("hint write: a rename refused twice with EPERM lands the hint on the third attempt", () => {
  const { dir, ledger } = ledgerDir();
  try {
    const failures: unknown[] = [];
    const log = new HintLog();
    let calls = 0;
    const rename = (from: string, to: string): void => {
      if (++calls <= 2) throw errno("EPERM");
      fs.renameSync(from, to);
    };
    assert.deepEqual(writeHint(ledger, ["1"], "ledger mark", log, { now: NOW, rename, onFail: (f) => failures.push(f) }), ["1"]);
    assert.equal(calls, 3);
    assert.deepEqual(failures, []);
    assert.equal(fs.readFileSync(ledger, "utf8"), "# L\n\n- [ ] 1. a\n  > 2026-10-24 ledger mark\n- [ ] V. verify\n");
    assert.deepEqual(log.last(1), ["1: 2026-10-24 ledger mark"]);
    assert.deepEqual(fs.readdirSync(dir), ["LEDGER-t.md"]);
  } finally {
    rmTestTmp(dir);
  }
});

test("hint write: a rename that keeps failing with EBUSY gives up, keeps the ledger, removes the temp file and reports code and attempts", () => {
  const { dir, ledger } = ledgerDir();
  try {
    const failures: unknown[] = [];
    const log = new HintLog();
    let calls = 0;
    const rename = (): void => {
      calls++;
      throw errno("EBUSY");
    };
    assert.deepEqual(writeHint(ledger, ["1"], "ledger mark", log, { now: NOW, rename, onFail: (f) => failures.push(f) }), []);
    assert.equal(calls, 8);
    assert.deepEqual(failures, [{ code: "EBUSY", attempts: 8 }]);
    assert.equal(fs.readFileSync(ledger, "utf8"), LEDGER);
    assert.deepEqual(fs.readdirSync(dir), ["LEDGER-t.md"]);
    assert.deepEqual(log.last(5), []);
  } finally {
    rmTestTmp(dir);
  }
});

test("hint write: a non-retryable rename error is not retried and is reported", () => {
  const { dir, ledger } = ledgerDir();
  try {
    const failures: unknown[] = [];
    let calls = 0;
    const rename = (): void => {
      calls++;
      throw errno("ENOENT");
    };
    assert.deepEqual(writeHint(ledger, ["1"], "ledger mark", undefined, { now: NOW, rename, onFail: (f) => failures.push(f) }), []);
    assert.equal(calls, 1);
    assert.deepEqual(failures, [{ code: "ENOENT", attempts: 1 }]);
    assert.equal(fs.readFileSync(ledger, "utf8"), LEDGER);
    assert.deepEqual(fs.readdirSync(dir), ["LEDGER-t.md"]);
  } finally {
    rmTestTmp(dir);
  }
});
