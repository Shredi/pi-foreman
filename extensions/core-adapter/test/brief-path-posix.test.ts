// writeBrief (session.ts) returns the brief path with posix separators on every platform (R49, 0ef1652b): the text is
// sent to the child as `Brief from <opener>: read <path> and act on it`. The path still names the written file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeBrief } from "../session.ts";

test("brief path: writeBrief returns a forward-slash path that names the written brief-<n>.md", () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-brief-path-")));
  const first = writeBrief(dir, "one\n");
  const second = writeBrief(dir, "two\n");
  assert.equal(first, path.join(dir, "brief-1.md").split(path.sep).join("/"));
  assert.equal(second, path.join(dir, "brief-2.md").split(path.sep).join("/"));
  assert.ok(!first.includes("\\") && !second.includes("\\"), "no backslash in the returned path");
  assert.equal(path.resolve(first), path.resolve(dir, "brief-1.md"));
  assert.equal(fs.readFileSync(first, "utf8"), "one\n");
  assert.equal(fs.readFileSync(second, "utf8"), "two\n");
});
