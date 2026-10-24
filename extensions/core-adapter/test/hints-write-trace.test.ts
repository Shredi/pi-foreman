// A ledger hint the rename keeps refusing reaches the trace as a `hint_write_failed` record with its `code` and `attempts`.
// The onFail callback mirrors the adapter's hintOpts (index.ts): it emits through the session trace writer, which sanitises
// every record (trace.ts), so this also covers the field allowance for `code` and `attempts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeHint } from "../hints.ts";
import { openTrace } from "../trace.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const LEDGER = "# L\n\n- [ ] 1. a\n- [ ] V. verify\n";

test("hint write give-up: the trace gets a hint_write_failed record with code and attempts", () => {
  const dir = mkTestTmp("hint-write-trace-");
  try {
    const ledger = path.join(dir, "LEDGER-t.md");
    fs.writeFileSync(ledger, LEDGER, "utf8");
    const trace = openTrace({ enabled: true, dir, stateDir: dir, sessionId: "t1" });
    assert.ok(trace);
    const rename = (): void => {
      throw Object.assign(new Error("EBUSY: refused"), { code: "EBUSY" });
    };
    const onFail = (f: { code: string; attempts: number }): void => trace.emit({ event: "hint_write_failed", code: f.code, attempts: f.attempts });
    assert.deepEqual(writeHint(ledger, ["1"], "ledger mark", undefined, { rename, onFail }), []);
    const recs = fs.readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].event, "hint_write_failed");
    assert.equal(recs[0].code, "EBUSY");
    assert.equal(recs[0].attempts, 8);
    assert.equal(fs.readFileSync(ledger, "utf8"), LEDGER);
  } finally {
    rmTestTmp(dir);
  }
});
