// pr_create's push check through the adapter's real wiring (index.ts `pushRefusal`: the gate's push floors on a synthetic `git push`
// in the PR's checkout), not the injected fake of prpack.test.ts. The reviewer gate is off so only the push step decides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { r11Rig } from "./_r11rig.ts";
import { defaultSpawner } from "../spawn.ts";
import type { Spawner } from "../spawn.ts";

type T = Parameters<typeof r11Rig>[0];
type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> };

const git = (cwd: string, ...args: string[]): void => void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });

/** A rig with the PR tools on, a repository on `branch` with one commit, and a spawner that answers the PR script and records it (every other spawn runs for real). */
async function prRig(t: T, branch: string) {
  const tools = new Map<string, Tool>();
  const hostCalls: string[] = [];
  const spawner: Spawner = async (command, args, o) => {
    if (!args.some((a) => a.endsWith("safe_ops.py"))) return defaultSpawner(command, args, o);
    hostCalls.push(o.input ?? "");
    return { code: 0, stdout: JSON.stringify({ ok: true, action: "pr_create", number: 7, url: "https://github.com/acme/app/pull/7" }) + "\n", stderr: "", timedOut: false };
  };
  const c = await r11Rig(t, { reviewBeforePr: false }, {
    config: { tools: { pr: true } },
    piExtra: { registerTool: (def: unknown) => void tools.set((def as Tool).name, def as Tool) },
    deps: { spawner },
  });
  git(c.project, "init", "-q", "-b", "main");
  git(c.project, "commit", "-q", "--allow-empty", "-m", "init");
  if (branch !== "main") git(c.project, "checkout", "-q", "-b", branch);
  await c.restart();
  const create = () => tools.get("pr_create")!.execute("id1", { title: "t", body: "b" }, undefined, undefined, c.ctx);
  return { create, hostCalls };
}

test("pr_create from the default branch is refused by the push floor, with no host call", async (t: T) => {
  const r = await prRig(t, "main");
  const res = await r.create();
  assert.equal(res.details.decision, "push_refused");
  assert.match(res.content[0].text, /^pr_create: a push floor refuses pushing this branch \(.*git-push-protected.*\); nothing was done\.$/s);
  assert.deepEqual(r.hostCalls, []);
});

test("pr_create from a feature branch passes the push step and reaches the host call", async (t: T) => {
  const r = await prRig(t, "feat/x");
  const res = await r.create();
  assert.equal(res.details.decision, "ran");
  assert.equal(r.hostCalls.length, 1);
});
