// guard-followup item 2: `git clone -c|--config <key=value>` meets the same config floor as `git -c <key=value>` before the subcommand (floors.ts gitFloors).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string, e: FloorEnv = env): string | null => lineFloors(line, parseShell(line, { cwd: e.cwd }), e)?.rule ?? null;
const U = "https://example.com/r.git";

test("clone config: every spelling of -c and --config with a floored key is refused, for main and child", () => {
  for (const l of [
    `git clone -c core.sshCommand=x ${U}`,
    `git clone --config core.hooksPath=h ${U}`,
    `git clone --config=core.sshCommand=x ${U}`,
    `git clone -ccore.sshCommand=x ${U}`,
    `git clone ${U} -c core.sshCommand=x`,
    `git clone --conf core.sshCommand=x ${U}`,
    `git clone --co core.sshCommand=x ${U}`,
    `git clone --con=core.sshCommand=x ${U}`,
    `git clone -nc core.sshCommand=x ${U}`,
    `git clone -nccore.sshCommand=x ${U}`,
    `git clone --bare --config credential.helper=x ${U} d`,
    `git -C .. clone -c core.fsmonitor=x ${U}`,
    "git clone --config core.sshCommand=true /x y",
  ]) {
    assert.equal(floor(l), "floor-git-config", l);
    assert.equal(floor(l, { ...env, child: true }), "floor-git-config", l);
  }
});

test("clone config: core.attributesFile after clone is refused the way it is before the subcommand", () => {
  const before = floor(`git -c core.attributesFile=/x clone ${U}`);
  assert.equal(before, "floor-git-attributes-file");
  assert.equal(floor(`git clone -c core.attributesFile=/x ${U}`), before);
  assert.equal(floor(`git clone --config=core.attributesFile=/x ${U}`, { ...env, child: true }), before);
});

test("clone config: a harmless key runs, a word after -- is not read, a glued value of another option is not config", () => {
  for (const l of [`git clone -c user.name=x ${U}`, `git clone --config=user.name=x ${U}`, `git clone ${U} -- -c core.sshCommand=x`, `git clone -bcore.sshCommand=x ${U}`, `git clone -b -c ${U}`]) {
    assert.equal(floor(l), null, l);
    assert.equal(floor(l, { ...env, child: true }), null, l);
  }
});

test("clone config: git clone without config is unchanged", () => {
  for (const l of [`git clone ${U}`, `git clone --depth 1 ${U} d`, `git clone -n ${U}`, "git clone --template=./t /x y"]) assert.equal(floor(l), null, l);
});

type T = Parameters<typeof r11Rig>[0];
const ALLOW = JSON.stringify({ verdict: "allow", entry: "A1", reason: "stub" });
const ROLES = ["explorer", "builder", "reviewer"];

for (const kind of ["main", "child"] as const) {
  for (const mode of ["auto", "allow"] as const) {
    test(`clone config end to end: ${kind} in mode ${mode} is blocked by floor-git-config, a harmless clone is not`, async (t: T) => {
      const saved = { b: process.env[BINDINGS_ENV], c: process.env.FOREMAN_CHECKOUT };
      t.after(() => {
        if (saved.b === undefined) delete process.env[BINDINGS_ENV]; else process.env[BINDINGS_ENV] = saved.b;
        if (saved.c === undefined) delete process.env.FOREMAN_CHECKOUT; else process.env.FOREMAN_CHECKOUT = saved.c;
      });
      if (kind === "child") process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "builder", launchId: "l1", kind: "first", workspace: "", perms: { mode, childDeny: true } } });
      else delete process.env[BINDINGS_ENV];
      delete process.env.FOREMAN_CHECKOUT;
      const modelRegistry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: ALLOW }], stopReason: "stop", usage: { input: 1, output: 1 } }) };
      const ui = { notify: () => undefined, confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
      const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(ROLES.map((r) => [r, { model: `fake/${r}` }])) } } };
      const c = await r11Rig(t, {}, { ctx: { modelRegistry, ui, [RIG_PERMISSIONS]: { mode, allow: ["Write", "Edit"], classifier: { allow: ["Anything at all."] } } }, config, child: kind === "child" });
      const g = (...a: string[]) => execFileSync("git", ["-C", c.project, "-c", "user.name=p", "-c", "user.email=p@x", ...a], { stdio: "ignore" });
      g("init", "-q", "-b", "feature");
      fs.writeFileSync(path.join(c.project, "f.txt"), "x");
      g("add", "f.txt");
      g("commit", "-q", "-m", "init");
      if (kind === "child") process.env.FOREMAN_CHECKOUT = path.join(c.project, "..", "main");
      const rule = async (command: string): Promise<{ blocked: boolean; rule?: string }> => {
        const n0 = c.trace().length;
        const res = (await c.call("bash", { command })) as { block?: boolean } | undefined;
        const recs = c.trace().slice(n0).filter((x) => x.event === "guard" && x.guard === "gate");
        return { blocked: res?.block === true, rule: (recs[recs.length - 1] as { rule?: string } | undefined)?.rule };
      };
      for (const l of [`git clone --config core.sshCommand=x ${U}`, `git clone ${U} -c core.hooksPath=h`]) {
        const r = await rule(l);
        assert.equal(r.blocked, true, l);
        assert.equal(r.rule, "floor-git-config", l);
      }
      const ok = await rule(`git clone -c user.name=x ${U}`);
      assert.notEqual(ok.rule, "floor-git-config");
    });
  }
}
