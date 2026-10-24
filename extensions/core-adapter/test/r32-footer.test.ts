// r32: the foreman footer's cache slot tells keep-alive (warm), cold and downshift glyphs apart.
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
  f.update("s", ctx, MSG, { enabled: true, isChild: false, children: 0 });
  return mount.render(200)[0];
}

for (const which of ["unicode", "nerd"] as const) {
  const sym = symbolSet(which);
  test(`footer cache slot (${which}): keep-alive glyph shows warm`, () => {
    const l = line1(sym.keepalive);
    assert.ok(l.endsWith("warm"), l);
    assert.ok(!l.includes(sym.cold) && !l.includes(sym.downshift), l);
  });
  test(`footer cache slot (${which}): cold glyph shows the glyph, not warm`, () => {
    const l = line1(sym.cold);
    assert.ok(l.endsWith(`${sym.cold} cold`), l);
    assert.ok(!l.includes("warm"), l);
  });
  test(`footer cache slot (${which}): downshift glyph shows the glyph, not warm`, () => {
    const l = line1(sym.downshift);
    assert.ok(l.endsWith(`${sym.downshift} downshift`), l);
    assert.ok(!l.includes("warm"), l);
  });
}

test("footer cache slot: no status shows neither glyph nor warm", () => {
  const l = line1(undefined);
  const sym = symbolSet("unicode");
  assert.ok(!l.includes("warm") && !l.includes(sym.cold) && !l.includes(sym.downshift), l);
});
