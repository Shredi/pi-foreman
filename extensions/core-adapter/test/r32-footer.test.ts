// r32 (reworked in r65): the foreman footer no longer reads the keep-alive status slot; the cache bar replaces it (r65-cache-bar.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_STATUS_KEY, UsageFooter } from "../footer.ts";
import { symbolSet } from "../symbols.ts";

const theme = { fg: (_c: string, t: string) => t };
const MSG = { role: "assistant", usage: { input: 10000, output: 2300, cacheRead: 1_000_000, cacheWrite: 200_000, cost: { input: 0.05, output: 0.1, cacheRead: 0.5, cacheWrite: 0.25, total: 0.9 } } };

function line1(status: string | undefined): string {
  const f = new UsageFooter();
  const statuses = new Map<string, string>();
  if (status !== undefined) statuses.set(CACHE_STATUS_KEY, status);
  const data = { getGitBranch: () => null, getExtensionStatuses: () => statuses };
  const ctx = { mode: "tui", model: { id: "m", reasoning: false, contextWindow: 200_000 }, getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }), ui: { setStatus: () => undefined } };
  const mount = f.mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off");
  f.update("s", ctx, MSG, { enabled: true, isChild: false });
  return mount.render(200)[0];
}

for (const which of ["unicode", "emoji", "nerd", "ascii"] as const) {
  const sym = symbolSet(which);
  for (const glyph of [sym.keepalive, sym.cold, sym.downshift]) {
    test(`footer cache slot (${which}): status glyph ${glyph} is not shown by the foreman footer`, () => {
      const l = line1(glyph);
      assert.equal(l, line1(undefined));
      assert.ok(!l.includes("warm") && !l.includes("cold") && !l.includes(glyph), l);
    });
  }
}
