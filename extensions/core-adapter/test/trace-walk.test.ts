import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readTraceFiles, type WalkFs } from "./_trace-walk.ts";

const ent = (name: string, dir = false) => ({ name, isDirectory: () => dir }) as unknown as fs.Dirent;
const enoent = () => Object.assign(new Error("gone"), { code: "ENOENT" });

test("readTraceFiles skips a file that vanishes between readdir and read, and rethrows other errors", () => {
  const io: WalkFs = {
    readdir: () => [ent("trace-a.jsonl"), ent("trace-gone.jsonl"), ent("pressure.json.x1.tmp")],
    read: (p) => {
      if (p.endsWith("trace-gone.jsonl")) throw enoent();
      if (p.endsWith(".tmp")) throw enoent();
      return "A";
    },
  };
  assert.deepEqual(readTraceFiles("/x", io), ["A"]);
  assert.throws(() => readTraceFiles("/x", { ...io, read: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
});

test("readTraceFiles ignores non-trace files such as a pressure tmp file", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-tracewalk-"));
  try {
    fs.mkdirSync(path.join(d, "state"));
    fs.writeFileSync(path.join(d, "state", "trace-s.jsonl"), "T");
    fs.writeFileSync(path.join(d, "state", "pressure.json.abc.tmp"), "{}");
    assert.deepEqual(readTraceFiles(d), ["T"]);
    assert.deepEqual(readTraceFiles(path.join(d, "missing")), []);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
