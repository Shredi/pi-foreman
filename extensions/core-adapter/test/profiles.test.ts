import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assignment, deviations, equivalentCommand, installedAddons, loadFeatures, planChanges, resolveSetupPython, safetyFloorViolations, shippedState, toggleable, loadDefaults,
} from "../profiles.mjs";

const leafPaths = (r: any, id: string) => r.changes.find((c: any) => c.feature === id)?.leaves.map((l: any) => l.path) ?? [];

test("idle-cache wildcard expands over zero, one and two providers", () => {
  const none = planChanges({ version: 1, providers: {} }, { disable: ["idle-cache"] });
  assert.deepEqual(none.errors, []);
  assert.deepEqual(leafPaths(none, "idle-cache"), []);
  assert.match(none.changes.find((c: any) => c.feature === "idle-cache").notes[0], /no provider present/);
  assert.deepEqual(none.config.providers, {});

  const one = planChanges({ version: 1, providers: { a: {} } }, { disable: ["idle-cache"] });
  assert.deepEqual(leafPaths(one, "idle-cache"), ["providers.a.cache.keepalive.enabled"]);
  assert.equal(one.config.providers.a.cache.keepalive.enabled, false);

  const two = planChanges({ version: 1, providers: { a: {}, b: { cache: { ttlSeconds: 300 } } } }, { disable: ["idle-cache"] });
  assert.deepEqual(leafPaths(two, "idle-cache"), ["providers.a.cache.keepalive.enabled", "providers.b.cache.keepalive.enabled"]);
  assert.equal(two.config.providers.b.cache.ttlSeconds, 300);
  assert.equal(two.config.providers.b.cache.keepalive.enabled, false);
});

test("planChanges: input untouched, shipped state needs no write, profile key set, order profile then enable then disable", () => {
  const input = { version: 1, providers: {} };
  const r = planChanges(input, { profile: "orchestration", enable: ["pr-ops"], disable: ["codemode"] });
  assert.deepEqual(input, { version: 1, providers: {} });
  assert.equal(r.config.profile, "orchestration");
  assert.equal(r.config.tools, undefined); // enable beats the profile's off, and on is the shipped state: nothing to write
  assert.equal(r.config.roles.foreman.codemode, false);
  assert.equal(r.config.herdr.blockedShim, false);
  assert.equal(r.config.ladder.reviewerClimb, undefined);
  const std = planChanges({ version: 1 }, { profile: "standard" });
  assert.deepEqual(std.changes, []);
  assert.deepEqual(std.config, { version: 1, profile: "standard" });
});

test("planChanges errors: unknown, non-toggleable, conflicting ids and unknown profile", () => {
  const r = planChanges({}, { enable: ["nope", "setup", "codemode"], disable: ["codemode"] });
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.some((e: string) => /unknown feature id nope/.test(e)));
  assert.ok(r.errors.some((e: string) => /setup is not toggleable.*docs\/features\.md/.test(e)));
  assert.ok(r.errors.some((e: string) => /codemode is in both/.test(e)));
  assert.match(planChanges({}, { profile: "zzz" }).errors[0], /unknown profile zzz; valid: orchestration, standard, full/);
});

test("full switches relaxations on, standard afterwards turns them back off", () => {
  const full = planChanges({ version: 1 }, { profile: "full" });
  assert.deepEqual(full.relaxations, ["git-tools", "children-may-push", "workflow-scripts", "remote-intercom"]);
  assert.equal(full.config.tools.git, true);
  const back = planChanges(full.config, { profile: "standard" });
  assert.deepEqual(back.relaxations, []);
  assert.equal(back.config.tools.git, false);
  assert.equal(back.config.safety.children.mayPush, false);
  assert.equal(back.config.profile, "standard");
});

test("assignment is the full map: named features plus shipped states", () => {
  const std = assignment("standard") as Record<string, string>;
  const orch = assignment("orchestration") as Record<string, string>;
  const ids = toggleable(loadFeatures()).map((f: any) => f.id);
  assert.deepEqual(Object.keys(std), ids);
  assert.deepEqual(Object.keys(orch), ids);
  assert.equal(std["git-tools"], "off");
  assert.equal(std.retro, "on");
  assert.equal(orch["pr-ops"], "off");
  assert.equal(orch.codemode, "on");
  assert.equal(Object.values(assignment("full") as object).every((v) => v === "on"), true);
  assert.equal(assignment("nope"), null);
});

test("shippedState reads the defaults, or the declared state; the safety floor holds", () => {
  const defaults = loadDefaults();
  const byId = (id: string) => toggleable(loadFeatures()).find((f: any) => f.id === id);
  assert.equal(shippedState(byId("git-tools"), defaults), "off");
  assert.equal(shippedState(byId("retro"), defaults), "on");
  assert.equal(shippedState(byId("idle-cache"), defaults), "on");
  assert.deepEqual(safetyFloorViolations(loadFeatures()), []);
  const bad = { features: [{ id: "x", toggle: { on: { "safety.permissions.deny": [] }, off: { "roles.foreman.mcp": null } } }] };
  assert.deepEqual(safetyFloorViolations(bad).map((v: any) => v.leaf), ["safety.permissions.deny", "roles.foreman.mcp"]);
});

test("deviations: absent leaf equals shipped, absent provider gives no row, unknown profile gives an empty list", () => {
  assert.deepEqual(deviations({ providers: { a: {} } }, "standard"), []);
  assert.deepEqual(deviations({}, "orchestration").map((r: any) => r.id).sort(), ["footer-ui", "herdr", "idle-downshift", "pr-ops", "retro", "trace"]);
  assert.deepEqual(deviations({ tools: { pr: false } }, "standard"), [{ id: "pr-ops", expected: "on", actual: "off" }]);
  assert.deepEqual(deviations({ providers: { a: { cache: { keepalive: { enabled: false } } } } }, "standard"), [{ id: "idle-cache", expected: "on", actual: "off" }]);
  assert.deepEqual(deviations({ providers: { a: {} } }, "orchestration").find((r: any) => r.id === "idle-cache"), { id: "idle-cache", expected: "off", actual: "on" });
  assert.equal(deviations({ providers: {} }, "orchestration").some((r: any) => r.id === "idle-cache"), false);
  assert.deepEqual(deviations({ tools: { pr: false } }, "unknown-profile"), []);
  assert.deepEqual(deviations({ tools: { pr: false } }, null), []);
});

test("installedAddons matches npm:<pkg> and npm:<pkg>@<ver> in both settings files", () => {
  assert.deepEqual(installedAddons(["npm:pi-polish"], []), [{ id: "polish", source: "npm:pi-polish", scope: "global" }]);
  assert.deepEqual(installedAddons([], [{ source: "npm:pi-background-tasks@2.6.10" }]), [{ id: "background-tasks", source: "npm:pi-background-tasks@2.6.10", scope: "project" }]);
  const both = installedAddons(["npm:pi-polish@0.1.1"], ["npm:pi-polish@0.1.2"]);
  assert.deepEqual(both.map((a: any) => a.scope), ["global", "project"]);
  assert.deepEqual(installedAddons(["npm:pi-polish-extra@1.0.0", "git:github.com/x/pi-polish", "npm:other"], undefined as any), []);
});

test("equivalentCommand builds the flag line", () => {
  assert.equal(equivalentCommand({ profile: "standard", enable: ["a", "b"], disable: ["c"], addons: ["polish"] }), "foreman setup --profile standard --enable a,b --disable c --addon polish");
  assert.equal(equivalentCommand({ project: true }), "foreman setup --project");
});

test("resolveSetupPython: python.path wins, then PI_FOREMAN_PYTHON; the probe line is parsed", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-profiles-py-"));
  try {
    const fake = (name: string, version: string) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho ${version}\necho ${file}\n`, { mode: 0o755 });
      return file;
    };
    const viaEnv = fake("envpy", "3.99");
    const saved = process.env.PI_FOREMAN_PYTHON;
    try {
      process.env.PI_FOREMAN_PYTHON = viaEnv;
      assert.deepEqual(resolveSetupPython(dir), { executable: viaEnv, version: [3, 99], source: "PI_FOREMAN_PYTHON" });
      const viaCfg = fake("cfgpy", "3.14");
      fs.writeFileSync(path.join(dir, "foreman.json"), JSON.stringify({ version: 1, python: { path: viaCfg } }));
      assert.deepEqual(resolveSetupPython(dir), { executable: viaCfg, version: [3, 14], source: "python.path" });
      fs.writeFileSync(path.join(dir, "foreman.json"), JSON.stringify({ version: 1, python: { path: fake("oldpy", "3.9") } }));
      assert.equal(resolveSetupPython(dir).source, "PI_FOREMAN_PYTHON");
    } finally {
      if (saved === undefined) delete process.env.PI_FOREMAN_PYTHON;
      else process.env.PI_FOREMAN_PYTHON = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
