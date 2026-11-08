import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { optionalAddonsDoctor, onPath } from "../bg.ts";

function dirs() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pf-opt-addons-"));
  return { agentDir: path.join(base, "agent"), cwd: path.join(base, "project"), base };
}
function install(root: string, pkg: string) {
  fs.mkdirSync(path.join(root, "npm", "node_modules", pkg), { recursive: true });
  fs.writeFileSync(path.join(root, "npm", "node_modules", pkg, "package.json"), "{}");
}

test("optionalAddonsDoctor reports absent add-ons as INFO only", () => {
  const d = dirs();
  assert.deepEqual(optionalAddonsDoctor(d, [], { PATH: "" }, "linux"), ["INFO quiver: absent", "INFO memory: absent"]);
});

test("optionalAddonsDoctor adds the qmd line when memory is present and qmd is not on PATH", () => {
  const d = dirs();
  install(d.agentDir, "pi-quiver");
  install(d.agentDir, "pi-memory");
  const bin = path.join(d.base, "bin");
  fs.mkdirSync(bin);
  const lines = optionalAddonsDoctor(d, [], { PATH: bin }, process.platform);
  assert.equal(lines[0], "INFO quiver: present");
  assert.equal(lines[1], "INFO memory: present");
  assert.match(lines[2], /qmd not on PATH.*memory_search is unavailable/);
  fs.writeFileSync(path.join(bin, "qmd"), "");
  assert.equal(optionalAddonsDoctor(d, [], { PATH: bin }, process.platform).length, 2);
});

test("onPath honours Windows extensions and the platform's separator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-onpath-"));
  fs.writeFileSync(path.join(dir, "qmd.cmd"), "");
  assert.equal(onPath("qmd", dir, "win32"), true);
  assert.equal(onPath("qmd", dir, "linux"), false);
  assert.equal(onPath("qmd", undefined, "linux"), false);
});
