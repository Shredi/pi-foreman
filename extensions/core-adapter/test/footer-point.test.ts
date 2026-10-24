// r52: the footer context bar scales to the compaction point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageFooter } from "../footer.ts";
import { renderFooter, type FooterView } from "../footerview.ts";

const CODE = { success: "32", warning: "33", error: "31", dim: "2" } as const;
const theme = { fg: (c: keyof typeof CODE, t: string) => `\x1b[${CODE[c]}m${t}\x1b[0m` };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const bar = (s: string): string => plain(s).match(/[■□]+/)?.[0] ?? "";

const base: FooterView = { model: "m", thinking: null, branch: null, contextPercent: 7, contextWindow: 1_000_000, cacheHit: null, warm: false, usage: null, statuses: [] };

test("percent and cells divide by the point: 140k of a 1M window at a 200k point is 70%", () => {
  const line = renderFooter({ ...base, contextPercent: 14, contextPoint: 200_000 }, 200, theme)[0];
  assert.match(plain(line), /70% of 200k/);
  assert.equal(bar(line), "■■■■■■■□□□");
});

test("a point larger than the window never overfills; colour bands unchanged", () => {
  const line = renderFooter({ ...base, contextPercent: 90, contextWindow: 200_000, contextPoint: 183_616 }, 200, theme)[0];
  assert.match(plain(line), /98% of 184k/);
  assert.ok(line.includes("\x1b[31m"), "red from 80%");
  const over = renderFooter({ ...base, contextPercent: 99, contextWindow: 200_000, contextPoint: 100_000 }, 200, theme)[0];
  assert.equal(bar(over), "■".repeat(10));
});

test("no point: the window is the scale", () => {
  for (const contextPoint of [undefined, null, 0, Number.NaN]) {
    const line = renderFooter({ ...base, contextPercent: 14, contextPoint }, 200, theme)[0];
    assert.match(plain(line), /14% of 1\.0M/);
  }
});

test("unknown usage keeps the question mark and shows the point", () => {
  assert.match(plain(renderFooter({ ...base, contextPercent: null, contextPoint: 200_000 }, 200, theme)[0]), /\? of 200k/);
});

test("the mounted footer reads the point from the adapter's function; compaction off -> window", () => {
  const data = { getGitBranch: () => null, getExtensionStatuses: () => new Map<string, string>() };
  const ctx = { mode: "tui", model: { id: "m", provider: "p", contextWindow: 1_000_000 }, getContextUsage: () => ({ percent: 14, contextWindow: 1_000_000 }), ui: { setStatus: () => undefined } };
  const withPoint = new UsageFooter(null, () => 200_000).mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off");
  assert.match(plain(withPoint.render(200)[0]), /70% of 200k/);
  const off = new UsageFooter(null, () => null).mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off");
  assert.match(plain(off.render(200)[0]), /14% of 1\.0M/);
});
