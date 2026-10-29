import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PACKAGE_ROOTS, buildOrientation } from "../orient.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const input = { files: ["a/x.ts"], agentsMd: null, readmeMd: null, packageJson: null, reads: { warn: 4, every: 8 }, maxLines: 120 };

test("orient: one line names the bundled package roots", () => {
  const lines = buildOrientation(input).split("\n").filter((l) => l.startsWith("Bundled package roots"));
  assert.equal(lines.length, 1);
  for (const r of ["node_modules/pi-subagents", "node_modules/pi-intercom"]) assert.ok(lines[0].includes(`\`${r}\``), r);
});

test("orient: the named roots are the package.json dependencies", () => {
  const deps = Object.keys(JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")).dependencies).map((d) => `node_modules/${d}`);
  assert.deepEqual([...BUNDLED_PACKAGE_ROOTS].sort(), deps.sort());
});
