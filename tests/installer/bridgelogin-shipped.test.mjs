// Every relative module setup.mjs imports statically ships in the npm package (a packed install must not lack bridgelogin.mjs, profiles.mjs or a later one).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));

test("npm pack lists every relative .mjs module setup.mjs imports statically", (t) => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (r.error || r.status !== 0) {
    t.skip(`npm pack unavailable: ${r.error?.message ?? r.stderr}`);
    return;
  }
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path.split("\\").join("/")));
  const source = fs.readFileSync(path.join(ROOT, "setup.mjs"), "utf8");
  const imports = [...source.matchAll(/^(?:import|\}) .*?from\s+"(\.\/[^"]+\.mjs)";?\s*$/gm)].map((m) => m[1].slice(2));
  assert.ok(imports.includes("extensions/core-adapter/profiles.mjs"), "the parse finds the profiles.mjs import");
  assert.ok(imports.includes("extensions/core-adapter/bridgelogin.mjs"), "the parse finds the bridgelogin.mjs import");
  for (const rel of imports) assert.ok(packed.has(rel), `${rel} is in the packed file list`);
});
