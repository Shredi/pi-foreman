// The no-bash notice as the adapter wires it (index.ts): a win32 session whose shell lookup finds no bash says so once at session
// start, not again on a second start of the same session, and not when the user set the shell variables. The lookup is the
// adapter's `getShellConfig` seam, so no host bash is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { NO_BG_BASH_NOTICE } from "../bgshell.ts";

const KEYS = ["PI_BG_SHELL", "PI_BG_SHELL_PATH"];

async function rig(t: Parameters<typeof r11Rig>[0], getShellConfig: () => never, env: Record<string, string> = {}) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const notes: string[] = [];
  const ui = { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, { ctx: { ui }, deps: { platform: "win32", getShellConfig, spawner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }) } });
  const count = () => notes.filter((m) => m === NO_BG_BASH_NOTICE).length;
  return { r, count };
}

const none = (): never => {
  throw new Error("no bash");
};

test("win32 with no bash: the notice shows once at session start, not per command", async (t) => {
  const x = await rig(t, none);
  assert.equal(x.count(), 1);
  await x.r.fire("before_agent_start", { prompt: "go", systemPromptOptions: { sections: {} } });
  await x.r.fire("turn_start", {});
  assert.equal(x.count(), 1);
});

test("win32 with the shell variables set by the user: no notice", async (t) => {
  const x = await rig(t, none, { PI_BG_SHELL: "bash" });
  assert.equal(x.count(), 0);
});
