// D157: a session another session opened (PI_FOREMAN_HANDOFF_DIR set, local or remote) gets the child bash default timeout (600, cap 1800);
// the top session is unchanged. Same result with process.platform stubbed to win32.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { r11Rig } from "./_r11rig.ts";

async function withPlatform<T>(platform: string | null, fn: () => Promise<T>): Promise<T> {
  if (!platform) return fn();
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform });
  try { return await fn(); } finally { Object.defineProperty(process, "platform", orig); }
}

for (const platform of [null, "win32"]) {
  const tag = platform ?? "native";
  test(`handoff child session (${tag}): no timeout gets 600, an explicit one is kept, a larger one is capped at 1800`, async (t) => {
    const rig = await r11Rig(t);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-d157-"));
    const prev = process.env.PI_FOREMAN_HANDOFF_DIR;
    process.env.PI_FOREMAN_HANDOFF_DIR = dir;
    t.after(() => {
      if (prev === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
      else process.env.PI_FOREMAN_HANDOFF_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await withPlatform(platform, async () => {
      const missing: Record<string, unknown> = { command: "echo ok" };
      await rig.call("bash", missing);
      assert.equal(missing.timeout, 600);
      const kept: Record<string, unknown> = { command: "echo ok", timeout: 120 };
      await rig.call("bash", kept);
      assert.equal(kept.timeout, 120);
      const big: Record<string, unknown> = { command: "echo ok", timeout: 7200 };
      await rig.call("bash", big);
      assert.equal(big.timeout, 1800);
    });
  });

  test(`top session (${tag}): bash input unchanged`, async (t) => {
    const rig = await r11Rig(t);
    const prev = process.env.PI_FOREMAN_HANDOFF_DIR;
    delete process.env.PI_FOREMAN_HANDOFF_DIR;
    t.after(() => { if (prev !== undefined) process.env.PI_FOREMAN_HANDOFF_DIR = prev; });
    await withPlatform(platform, async () => {
      const input: Record<string, unknown> = { command: "echo ok" };
      await rig.call("bash", input);
      assert.equal("timeout" in input, false);
    });
  });
}
