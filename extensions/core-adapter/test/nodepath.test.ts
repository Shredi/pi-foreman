// nodepath.ts: the session-start record of the Node that runs Pi (bin/foreman's fallback when the PATH has no node).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { nodePathFile, recordNodePath } from "../nodepath.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

test("writes process.execPath once, then leaves an unchanged record alone", () => {
  const dir = mkTestTmp("nodepath-");
  try {
    assert.equal(recordNodePath(dir), true);
    const file = nodePathFile(dir);
    assert.equal(file, path.join(dir, "pi-foreman", "state", "node-path"));
    assert.equal(fs.readFileSync(file, "utf8"), `${process.execPath}\n`);
    const old = new Date(2020, 1, 1);
    fs.utimesSync(file, old, old);
    assert.equal(recordNodePath(dir), false, "same content: no write");
    assert.equal(fs.statSync(file).mtimeMs, old.getTime());
    assert.equal(recordNodePath(dir, "/other/node"), true, "changed: rewritten");
    assert.equal(fs.readFileSync(file, "utf8"), "/other/node\n");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["node-path"], "no temp file left");
  } finally {
    rmTestTmp(dir);
  }
});

test("never throws when the agent dir cannot be written", () => {
  const dir = mkTestTmp("nodepath-");
  try {
    fs.writeFileSync(path.join(dir, "pi-foreman"), "a file, not a dir");
    assert.equal(recordNodePath(dir), false);
  } finally {
    rmTestTmp(dir);
  }
});
