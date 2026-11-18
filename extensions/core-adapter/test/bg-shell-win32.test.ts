// remote-windows-2 item 4: Pi's `shellPath` setting (the project's `.pi/settings.json` over the agent dir's) feeds the win32 shell resolution at index.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellPathSetting } from "../bg.ts";

test("shellPathSetting: project .pi/settings.json wins over the agent dir", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-shellpath-"));
  const agent = path.join(d, "agent");
  const proj = path.join(d, "proj");
  fs.mkdirSync(agent);
  fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
  assert.equal(shellPathSetting(agent, proj), undefined);
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ shellPath: "A" }));
  assert.equal(shellPathSetting(agent, proj), "A");
  fs.writeFileSync(path.join(proj, ".pi", "settings.json"), JSON.stringify({ shellPath: "P" }));
  assert.equal(shellPathSetting(agent, proj), "P");
});
