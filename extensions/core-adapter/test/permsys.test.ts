import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { permFileState, psGlobalConfigPath, resolvePermissionSystem, sha256 } from "../permsys.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-permsys-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "proj");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

test("resolvePermissionSystem finds the agent-dir install, a local settings entry, or nothing", () => {
  assert.equal(resolvePermissionSystem({ agentDir, cwd, pkgRoot: root }), null);
  const pkg = path.join(root, "elsewhere", "ps");
  fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system", pi: { extensions: ["./src/index.ts"] } }));
  fs.writeFileSync(path.join(pkg, "src", "index.ts"), "export default () => {};\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [path.relative(agentDir, pkg)] }));
  assert.equal(resolvePermissionSystem({ agentDir, cwd, pkgRoot: root }), fs.realpathSync(path.join(pkg, "src", "index.ts")));
});

test("permFileState: missing, ok, stale (hash recorded) and edited (hash differs)", () => {
  const wanted = { permission: { "*": "ask" } };
  assert.equal(permFileState(agentDir, wanted).state, "missing");
  const file = psGlobalConfigPath(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(wanted));
  assert.equal(permFileState(agentDir, wanted).state, "ok");
  fs.mkdirSync(path.join(agentDir, "pi-foreman"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-foreman", "managed.json"), JSON.stringify({ files: { [file]: sha256(wanted) } }));
  assert.equal(permFileState(agentDir, { permission: { "*": "deny" } }).state, "stale");
  fs.writeFileSync(file, JSON.stringify({ permission: { "*": "allow" } }));
  assert.equal(permFileState(agentDir, wanted).state, "edited");
  fs.rmSync(root, { recursive: true, force: true });
});
