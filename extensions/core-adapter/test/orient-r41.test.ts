// R41 Ruling: the orientation names the Pi install root (resolved from the running pi's package dir, never a literal path), the extension types path
// under it, the global npm root, the bundled package roots and the whole-filesystem scan ban.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { BUNDLED_PACKAGE_ROOTS, buildOrientation, PI_TYPES_REL, rootsLines } from "../orient.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const input = { files: ["a/x.ts"], agentsMd: null, readmeMd: null, packageJson: null, reads: { warn: 4, every: 8 }, maxLines: 120 };

test("orientation: names the install root, the types path under it, the npm root, the bundled roots and the scan ban", () => {
  const roots = { installRoot: "/opt/pi/coding-agent", npmRoot: "/opt/npm/lib/node_modules", pkgRoot: "/opt/pf" };
  const text = buildOrientation({ ...input, roots });
  assert.ok(text.includes("`/opt/pi/coding-agent`"));
  assert.ok(text.includes(path.join("/opt/pi/coding-agent", ...PI_TYPES_REL.split("/"))));
  assert.ok(text.includes("`/opt/npm/lib/node_modules`"));
  assert.ok(text.includes("`/opt/pf`"));
  for (const r of BUNDLED_PACKAGE_ROOTS) assert.ok(text.includes(`\`${r}\``), r);
  assert.match(text, /Whole-filesystem scans .* are always denied/);
});

test("orientation: the install root comes from the running pi's package dir, and the output holds no literal home path", () => {
  const install = getPackageDir();
  assert.ok(install && path.isAbsolute(install));
  assert.ok(fs.existsSync(path.join(install, ...PI_TYPES_REL.split("/"))), "the types path under the resolved root exists");
  const lines = rootsLines({ installRoot: install, npmRoot: null, pkgRoot: null });
  assert.ok(lines[0].includes(install));
  // unresolved roots say so and name no path
  const bare = buildOrientation(input);
  assert.match(bare, /not resolved in this session/);
  assert.ok(!bare.includes(os.homedir()));
  assert.ok(!buildOrientation({ ...input, roots: { installRoot: null, npmRoot: null, pkgRoot: null } }).includes(os.homedir()));
});

test("orientation: no source or role prompt carries a literal home path", () => {
  const files = ["extensions/core-adapter/orient.ts", "extensions/core-adapter/childbrief.ts", ...fs.readdirSync(path.join(PKG, "agents")).map((f) => `agents/${f}`)];
  for (const f of files) {
    const text = fs.readFileSync(path.join(PKG, f), "utf8");
    assert.ok(!text.includes(os.homedir()) && !/\/Users\/|\/home\/[a-z]/.test(text), f);
  }
});
