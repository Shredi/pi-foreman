// R8 item 14: paths.hubWorkflow makes the hub's `.workflow/` family readable (read only) for the foreman and its children.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { hubWorkflowDirs } from "../roundsurface.ts";

test("hubWorkflowDirs: string or list, relative, .. and root entries dropped, empty default", () => {
  assert.deepEqual(hubWorkflowDirs(undefined), []);
  assert.deepEqual(hubWorkflowDirs([]), []);
  // the expectation is the host's resolution of the input ("/h" is D:\h on a Windows runner), not a POSIX literal
  const wf = (p: string): string => path.join(path.resolve(p), ".workflow");
  assert.deepEqual(hubWorkflowDirs("/h"), [wf("/h")]);
  assert.deepEqual(hubWorkflowDirs(["/a", "rel", "/x/../y", "/", 5]), [wf("/a")]);
});

test("hubWorkflowDirs on an injected platform: the platform's own resolution, .. and root entries dropped", () => {
  for (const [platform, x] of [["linux", path.posix], ["win32", path.win32]] as const) {
    const wf = (p: string): string => x.join(x.resolve(p), ".workflow");
    assert.deepEqual(hubWorkflowDirs("/h", platform), [wf("/h")], platform);
    assert.deepEqual(hubWorkflowDirs(["/a", "rel", "/x/../y", "/", 5], platform), [wf("/a")], platform);
  }
  const drive = path.win32.join("D:", "h");
  assert.deepEqual(hubWorkflowDirs([drive, "D:rel", path.win32.parse(drive).root], "win32"), [path.win32.join(drive, ".workflow")]);
});
