// R46 item 8: a child's npm ci / npm install asks unless the launch set `install: true` (carried in the binding into MatchCtx.install).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, npmCiWorktreeLabel, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { bindLaunch, readBinding, recordUsageLaunch, BINDINGS_ENV } from "../usage.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/nonexistent/agent", "/nonexistent/pkg");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-install-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const home = path.join(root, "home");
const foreman = path.join(root, "foreman");
const lock = path.join(foreman, "bench", "pi-lock");
const round = path.join(root, "foreman.worktrees", "r46");
const leaf = path.join(root, "worktrees", "foreman", "pi-worktree-abc-0");
const other = path.join(root, "other");
for (const d of [home, lock, round, leaf, other]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(leaf, ".git"), "gitdir: /nowhere\n");
fs.writeFileSync(path.join(leaf, "package.json"), "{}");

const posix = process.platform !== "win32";
const run = (command: string, cwd: string, extra: Partial<MatchCtx> = {}): { kind: string; reason: string } => {
  const d = checkToolCall(rules, "bash", { command }, { cwd, home, platform: process.platform, role: "child", roundRoots: [round], foremanRoot: foreman, ...extra }) as { kind?: string; reason?: string } | null;
  return { kind: d?.kind ?? "pass", reason: d?.reason ?? "" };
};
const SITES: [string, string][] = [
  ["owned root", round],
  ["bench/pi-lock", lock],
  ...(posix ? ([["pi-subagents leaf", leaf]] as [string, string][]) : []),
];

for (const [name, cwd] of SITES) {
  for (const cmd of ["npm ci", "npm install"]) {
    test(`${cmd} in ${name} asks without install and names the install flag`, () => {
      const d = run(cmd, cwd, name === "pi-subagents leaf" ? { roundRoots: [] } : {});
      assert.equal(d.kind, "ask");
      assert.match(d.reason, /`install: true`/);
    });
    test(`${cmd} in ${name} passes with install`, () => {
      if (name === "pi-subagents leaf" && cmd === "npm install") return; // only a bare npm ci is pre-allowed in a leaf
      assert.equal(run(cmd, cwd, { install: true, ...(name === "pi-subagents leaf" ? { roundRoots: [] } : {}) }).kind, "pass");
    });
  }
}

test("install does not widen the pre-allow: -g, a foreign prefix and a non-owned cwd still ask", () => {
  for (const cmd of ["npm install -g", "npm ci --prefix /elsewhere", "npm install left-pad", "npm ci && git fetch origin"]) assert.equal(run(cmd, round, { install: true }).kind, "ask", cmd);
  assert.equal(run("npm ci", other, { install: true }).kind, "ask");
});

test("install: false or absent keeps the label function unchanged (the gate is the guard)", { skip: !posix }, () => {
  assert.equal(npmCiWorktreeLabel("npm ci", { cwd: round, home, platform: process.platform, role: "child", roundRoots: [round] }), "npm-ci-worktree");
});

// builder and finalizer launches carry install in the binding; the child reads it back
for (const role of ["builder", "finalizer"]) {
  test(`${role} launch binding carries install and the child reads it`, () => {
    const reg = new Map();
    const b = recordUsageLaunch(reg, { foremanSession: "s", workspace: "/w", role, model: null });
    b.install = true;
    const input: Record<string, unknown> = {};
    bindLaunch(input, b);
    const got = readBinding({ [BINDINGS_ENV]: JSON.stringify(input.extensionBindings) });
    assert.equal(got?.role, role);
    assert.equal(got?.install, true);
    const none = readBinding({ [BINDINGS_ENV]: JSON.stringify({ "pi-foreman/1": { foremanSession: "s", role, launchId: "l", install: "yes" } }) });
    assert.equal(none?.install, undefined);
  });
}
