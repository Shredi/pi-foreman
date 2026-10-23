// R31a: a test rig started from inside a Herdr pane must not write that pane into its presence file (the stale
// record would later compete with the live session for the pane in the sidebar).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";

test("r11Rig scrubs HERDR_PANE_ID: the presence file names no pane", async (t) => {
  const saved = { pane: process.env.HERDR_PANE_ID, env: process.env.HERDR_ENV };
  process.env.HERDR_PANE_ID = "w9:p9";
  process.env.HERDR_ENV = "1";
  try {
    await t.test("rig", async (st) => {
      const rig = await r11Rig(st, {});
      const dir = path.join(rig.agentDir, "pi-foreman", "state", "live");
      const files = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
      assert.ok(files.length > 0, "the rig wrote a presence file");
      for (const f of files) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).paneId, null);
    });
  } finally {
    for (const [k, v] of [["HERDR_PANE_ID", saved.pane], ["HERDR_ENV", saved.env]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("test:node runs without HERDR_* in the environment", () => {
  if (!process.execArgv.some((a) => a.includes("_hermetic-env"))) return; // started without the preload
  assert.deepEqual(Object.keys(process.env).filter((k) => k.startsWith("HERDR_")), []);
});
