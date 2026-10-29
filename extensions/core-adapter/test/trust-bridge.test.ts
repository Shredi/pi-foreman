// R41 item 19: the bridge project-config trust record is written only by `/foreman trust bridge` behind a confirm dialog; silent while the
// hash matches, untrusted again when the file changes; no CLI subcommand.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { bridgeConfigHash, bridgeTrusted, bridgeTrustPath, trustBridgeCommand } from "../bridgetrust.ts";
import { projectBridgeConfigRisks } from "../bridgeiso.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function world(t: import("node:test").TestContext) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-trbr-")));
  t.after(() => rmTestTmp(d));
  const agent = path.join(d, "agent");
  const project = path.join(d, "project");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.mkdirSync(agent);
  const cfg = path.join(project, ".pi", "claude-bridge.json");
  fs.writeFileSync(cfg, JSON.stringify({ askClaude: { enabled: true } }));
  return { agent, project, cfg };
}
const ui = (answer: boolean, calls: string[] = []) => ({ hasUI: true, mode: "tui", confirm: async (title: string, msg: string) => (calls.push(`${title}\n${msg}`), answer) });

test("trust: no record, nothing trusted; the risk notice source still reports the file", (t) => {
  const w = world(t);
  assert.equal(bridgeTrusted(w.agent, w.project), false);
  assert.equal(fs.existsSync(bridgeTrustPath(w.agent)), false);
  assert.ok(projectBridgeConfigRisks(w.project).length > 0);
});

test("trust: the command writes the record only after a yes; a no or a missing UI writes nothing", async (t) => {
  const w = world(t);
  const calls: string[] = [];
  assert.match(await trustBridgeCommand(w.agent, w.project, ["AskClaude"], ui(false, calls)), /nothing was written/);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /AskClaude/);
  assert.equal(fs.existsSync(bridgeTrustPath(w.agent)), false);
  assert.match(await trustBridgeCommand(w.agent, w.project, [], { hasUI: false, mode: "print", confirm: async () => true }), /interactive/);
  assert.equal(fs.existsSync(bridgeTrustPath(w.agent)), false);
  assert.match(await trustBridgeCommand(w.agent, w.project, ["AskClaude"], ui(true)), /trusted/);
  assert.equal(bridgeTrusted(w.agent, w.project), true);
  const rec = JSON.parse(fs.readFileSync(bridgeTrustPath(w.agent), "utf8"));
  assert.equal(rec.version, 1);
  assert.equal(Object.values(rec.projects)[0], bridgeConfigHash(w.project));
});

test("trust: silent while the hash matches, untrusted again when the file differs, no dialog when already trusted", async (t) => {
  const w = world(t);
  await trustBridgeCommand(w.agent, w.project, ["AskClaude"], ui(true));
  assert.equal(bridgeTrusted(w.agent, w.project), true);
  const calls: string[] = [];
  assert.match(await trustBridgeCommand(w.agent, w.project, [], ui(false, calls)), /already trusted/);
  assert.equal(calls.length, 0);
  fs.writeFileSync(w.cfg, JSON.stringify({ askClaude: { enabled: true }, provider: { strictMcpConfig: false } }));
  assert.equal(bridgeTrusted(w.agent, w.project), false);
  fs.rmSync(w.cfg);
  assert.equal(bridgeTrusted(w.agent, w.project), false);
  assert.match(await trustBridgeCommand(w.agent, w.project, [], ui(true)), /nothing to trust/);
});

test("trust: a forged or malformed record trusts nothing", (t) => {
  const w = world(t);
  fs.mkdirSync(path.dirname(bridgeTrustPath(w.agent)), { recursive: true });
  for (const body of ["not json", "[]", JSON.stringify({ version: 2, projects: {} }), JSON.stringify({ version: 1, projects: { [w.project]: "deadbeef" } })]) {
    fs.writeFileSync(bridgeTrustPath(w.agent), body);
    assert.equal(bridgeTrusted(w.agent, w.project), false, body);
  }
});

test("trust: no CLI subcommand writes the record", () => {
  for (const f of ["scripts/foreman_session.py", "scripts/foreman_trust.py", "scripts/foreman_config.py"]) {
    const text = fs.readFileSync(path.join(PKG, f), "utf8");
    assert.ok(!/bridge-trust/.test(text) && !/trust\s+bridge/.test(text), f);
  }
});
