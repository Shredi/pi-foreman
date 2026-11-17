// r9 item 2: the Windows CI fixtures (ids 136, 338, 611, 1168, 1177, 1185, 1373, 1376, 1533) put an unquoted native path into a
// child bash line, which Git Bash runs drive-relative (`C:\w\proj` -> `C:wproj`). The fixtures spell the path with bashPath() (`C:/w/proj`).
// (The permission overlay the shapes were run against is gone; the bashPath helper pin stays.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { bashPath } from "./_bashpath.ts";

const wCwd = "C:\\w\\proj";
const fwd = (p: string): string => bashPath(p, "win32");

test("bashPath(\"C:\\\\w\\\\proj\", \"win32\") is C:/w/proj; off win32 the path is unchanged", () => {
  assert.equal(fwd(wCwd), "C:/w/proj");
  assert.equal(bashPath("/w/proj", "linux"), "/w/proj");
  assert.equal(bashPath(wCwd, "darwin"), wCwd, "no rewrite off win32");
});
