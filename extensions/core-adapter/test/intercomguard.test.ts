import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { intercomBlock, intercomDoctor, intercomSender, lastIntercomSender } from "../intercomguard.ts";

const MAIN = { isChild: false, allowRemote: false, allowOpenPane: false };

test("openProjectPaneIfMissing is refused unless intercom.allowOpenPane", () => {
  const input = { action: "send", cwd: "/w/other", openProjectPaneIfMissing: true, message: "hi" };
  assert.match(intercomBlock("intercom", input, MAIN) ?? "", /launch outside the role allowlist/);
  assert.equal(intercomBlock("intercom", input, { ...MAIN, allowOpenPane: true }), undefined);
  assert.equal(intercomBlock("intercom", { ...input, openProjectPaneIfMissing: false }, MAIN), undefined);
});

test("a name@machine target is refused unless intercom.allowRemote", () => {
  const input = { action: "send", to: "worker@laptop", message: "hi" };
  assert.match(intercomBlock("intercom", input, MAIN) ?? "", /name@machine/);
  assert.equal(intercomBlock("intercom", input, { ...MAIN, allowRemote: true }), undefined);
  assert.equal(intercomBlock("intercom", { action: "send", to: "worker", message: "hi" }, MAIN), undefined);
  assert.equal(intercomBlock("intercom", { action: "list" }, MAIN), undefined);
});

test("children are refused the intercom tool outright", () => {
  const child = { isChild: true, allowRemote: true, allowOpenPane: true };
  assert.match(intercomBlock("intercom", { action: "list" }, child) ?? "", /contact_supervisor/);
  assert.equal(intercomBlock("contact_supervisor", { reason: "need_decision" }, child), undefined);
});

test("other tools are untouched", () => {
  for (const t of ["bash", "read", "subagent", "contact_supervisor"]) {
    assert.equal(intercomBlock(t, { to: "a@b", openProjectPaneIfMissing: true }, MAIN), undefined, t);
  }
});

test("sender label: name, else id prefix; cross-machine marked; newest since the last user message", () => {
  assert.equal(intercomSender({ from: { id: "abcdef123456", name: "planner" }, message: {} }), "planner");
  assert.equal(intercomSender({ from: { id: "abcdef123456" }, message: {} }), "abcdef12");
  assert.match(intercomSender({ from: { name: "x" }, message: { crossMachine: { origin: {} } } }), /unverified cross-machine/);
  const im = (name: string) => ({ type: "custom_message", customType: "intercom_message", details: { from: { id: "id", name } } });
  const user = { type: "message", message: { role: "user" } };
  assert.equal(lastIntercomSender([im("old"), user, im("a"), im("b")]), "b");
  assert.equal(lastIntercomSender([im("old"), user]), null);
});

test("doctor: install state, trusted overrides in the intercom config, Herdr hint", () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pf-intercom-"));
  let lines = intercomDoctor(agent, [["npm:pi-intercom@0.16.1"]], {});
  assert.ok(lines.some((l) => l.startsWith("OK") && l.includes("pi-intercom")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.startsWith("WARN") || l.includes("Herdr")));
  fs.mkdirSync(path.join(agent, "intercom"));
  fs.writeFileSync(path.join(agent, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "always", brokerCommand: "x", crossMachine: {} }));
  lines = intercomDoctor(agent, [["npm:other@1.0.0"], undefined], { HERDR_ENV: "1" });
  assert.ok(lines.some((l) => l.startsWith("INFO pi-intercom not installed")));
  assert.ok(lines.some((l) => l.startsWith("WARN") && l.includes("brokerCommand, crossMachine")), lines.join("\n"));
  assert.ok(lines.includes("INFO Herdr detected; run `herdr integration install pi` for pane state"));
  fs.mkdirSync(path.join(agent, "extensions"));
  fs.writeFileSync(path.join(agent, "extensions", "herdr-agent-state.ts"), "");
  assert.ok(!intercomDoctor(agent, [], { HERDR_ENV: "1" }).some((l) => l.includes("Herdr")));
});

test("doctor warns on a shared stableId in the intercom config (review S6)", () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pf-intercom-"));
  fs.mkdirSync(path.join(agent, "intercom"));
  fs.writeFileSync(path.join(agent, "intercom", "config.json"), JSON.stringify({ stableId: "me" }));
  const warns = intercomDoctor(agent, [], {}).filter((l) => l.startsWith("WARN"));
  assert.equal(warns.length, 1, warns.join("\n"));
  assert.match(warns[0], /sets stableId: .*child sessions/);
});
