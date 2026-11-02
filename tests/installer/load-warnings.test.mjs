import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withBuiltinToolSearchOff } from "../../setup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// the names Pi's resource loader (1.4.0) wants in peerDependencies, not dependencies
const HOST_PROVIDED = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core", "@mariozechner/pi-ai", "@mariozechner/pi-coding-agent", "@mariozechner/pi-tui", "@sinclair/typebox", "typebox"];

test("package.json: no host-provided Pi package in dependencies, pi-tui is a '*' peer", () => {
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(deps.filter((d) => HOST_PROVIDED.includes(d)), []);
  assert.equal(pkg.peerDependencies["@earendil-works/pi-tui"], "*");
  assert.ok(pkg.devDependencies["@earendil-works/pi-tui"], "dev installs keep pi-tui for setup --preview and the tests");
});

test("withBuiltinToolSearchOff: adds the disable entry once and respects an existing one", () => {
  assert.deepEqual(withBuiltinToolSearchOff({ packages: ["x"] }), { packages: ["x"], extensions: ["-builtin:tool-search"] });
  assert.deepEqual(withBuiltinToolSearchOff({ extensions: ["+a.ts"] }).extensions, ["+a.ts", "-builtin:tool-search"]);
  for (const e of ["-builtin:tool-search", "+builtin:tool-search", "!builtin:tool-search", "builtin:tool-search"]) {
    assert.equal(withBuiltinToolSearchOff({ extensions: [e] }), null, e);
  }
});
