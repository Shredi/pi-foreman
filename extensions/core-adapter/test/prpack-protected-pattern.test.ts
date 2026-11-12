// pr_create's push check reads safety.git.protectedBranches as patterns: with release/* configured, a PR from release/1.0 is refused, with no host call.
// Same wiring as prpack-push-floor.test.ts (index.ts `pushRefusal`), reviewer gate off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { r11Rig } from "./_r11rig.ts";
import { defaultSpawner } from "../spawn.ts";
import type { Spawner } from "../spawn.ts";

type T = Parameters<typeof r11Rig>[0];
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });

async function prRig(t: T, branch: string, protectedBranches: string[]) {
  const tools = new Map<string, Tool>();
  const hostCalls: string[] = [];
  const spawner: Spawner = async (command, args, o) => {
    if (!args.some((a) => a.endsWith("safe_ops.py"))) return defaultSpawner(command, args, o);
    hostCalls.push(o.input ?? "");
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 7, url: "https://github.com/acme/app/pull/7" }) + "\n", stderr: "", timedOut: false };
  };
  const c = await r11Rig(t, { reviewBeforePr: false }, {
    config: { tools: { pr: true }, safety: { git: { protectedBranches } } },
    piExtra: { registerTool: (def: unknown) => void tools.set((def as Tool).name, def as Tool) },
    deps: { spawner },
  });
  git(c.project, "init", "-q", "-b", "main");
  git(c.project, "commit", "-q", "--allow-empty", "-m", "init");
  git(c.project, "checkout", "-q", "-b", branch);
  await c.restart();
  const create = () => tools.get("pr_create")!.execute("id1", { title: "t", body: "b" }, undefined, undefined, c.ctx);
  return { create, hostCalls };
}

test("pr_create from release/1.0 with release/* configured is refused by the push floor, with no host call", async (t: T) => {
  const r = await prRig(t, "release/1.0", ["release/*"]);
  const res = await r.create();
  assert.equal(res.details.decision, "push_refused");
  assert.match(res.content[0].text, /git-push-protected/);
  assert.deepEqual(r.hostCalls, []);
});

test("pr_create from release/1.0 without the pattern passes the push step (the refusal comes from the pattern)", async (t: T) => {
  const r = await prRig(t, "release/1.0", []);
  const res = await r.create();
  assert.equal(res.details.decision, "ran");
  assert.equal(r.hostCalls.length, 1);
});
