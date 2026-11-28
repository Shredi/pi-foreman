// D218: a reviewer launch with no named ledger path puts its launched hint only on the items its `items` field names,
// not on every item its task text cites.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

const ledger = `# B\n\n${Array.from({ length: 4 }, (_, i) => `- [ ] ${i + 1}. beta item ${i + 1}`).join("\n")}\n- [ ] V. verify\n`;

test("the hint of a review launch with items [1, \"V\"] lands on items 1 and V only", { skip }, async (t) => {
  const a = await r11Rig(t, { default: "standard" }, reviewAllowOpts());
  const fb = path.join(a.project, ".workflow", "LEDGER-b.md");
  await a.toolDoing("write", { path: fb }, () => fs.writeFileSync(fb, ledger));
  const input = { agent: "reviewer", task: "review items 1, 2, 3 and V of the change", items: [1, "V"] };
  const l = await a.launch(input);
  assert.equal(l.res, undefined, l.res?.reason);
  await a.started(l.id, input, "run-gi1");
  const end = Date.now() + 10_000;
  while (!fs.readFileSync(fb, "utf8").includes("run-gi1") && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  const lines = fs.readFileSync(fb, "utf8").split("\n");
  const under = (id: string): boolean => {
    const at = lines.findIndex((x) => x.includes(`${id}. `));
    return at >= 0 && (lines[at + 1] ?? "").includes("run-gi1");
  };
  assert.ok(under("1") && under("V"), lines.join("\n"));
  assert.ok(!under("2") && !under("3"), lines.join("\n"));
});
