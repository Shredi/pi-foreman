// r30 track A: the two-line pi-foreman footer (footer.style "foreman") and its "pi" / child paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_STATUS_KEY, FOOTER_KEY, UsageFooter, footerStyleOf } from "../footer.ts";
import { fitWidth, renderFooter, visibleWidth, type FooterView } from "../footerview.ts";
import { r11Rig } from "./_r11rig.ts";

// A fake theme: each colour is an SGR code, so a line's width ignores the colour like a real theme's.
const CODE = { success: "32", warning: "33", error: "31", dim: "2" } as const;
const theme = { fg: (c: keyof typeof CODE, t: string) => `\x1b[${CODE[c]}m${t}\x1b[0m` };
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const cells = (s: string): number => (plain(s).match(/[■□]/g) ?? []).length;

const VIEW: FooterView = {
  model: "claude-opus-5-5",
  thinking: "high",
  branch: "round/30-footer",
  contextPercent: 12,
  contextWindow: 1_000_000,
  cacheHit: 98,
  usage: "↑1.2M ↓2.3k tok · $0.90 list (warm $0.50 / cold $0.30) · children 3",
  statuses: ["ext ok"],
};

const MSG = { role: "assistant", usage: { input: 10000, output: 2300, cacheRead: 1_000_000, cacheWrite: 200_000, cost: { input: 0.05, output: 0.1, cacheRead: 0.5, cacheWrite: 0.25, total: 0.9 } } };

test("the footer is two lines that fit widths 200, 80 and 40; a cut line ends with an ellipsis", () => {
  for (const width of [200, 80, 40]) {
    const lines = renderFooter(VIEW, width, theme);
    assert.equal(lines.length, 2, String(width));
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
  }
  const wide = plain(renderFooter(VIEW, 200, theme)[0]);
  assert.equal(wide, "claude-opus-5-5 • high · round/30-footer · ■□□□□□□□□□ 12% of 1.0M · CH 98%");
  assert.ok(plain(renderFooter(VIEW, 40, theme)[0]).endsWith("…"));
});

test("line 1 drops the branch first, then shrinks the bar to 5 cells", () => {
  const fullWidth = visibleWidth(renderFooter(VIEW, 200, theme)[0]);
  const noBranch = renderFooter({ ...VIEW, branch: null }, 200, theme)[0];
  const noBranchWidth = visibleWidth(noBranch);
  const dropped = plain(renderFooter(VIEW, fullWidth - 1, theme)[0]);
  assert.ok(!dropped.includes("round/30-footer"), dropped);
  assert.equal(cells(dropped), 10);
  const shrunk = plain(renderFooter(VIEW, noBranchWidth - 1, theme)[0]);
  assert.ok(!shrunk.includes("round/30-footer"), shrunk);
  assert.equal(cells(shrunk), 5);
});

test("the context bar is green below 50%, yellow below 80%, red from 80%", () => {
  const barCode = (percent: number): string | undefined => renderFooter({ ...VIEW, contextPercent: percent }, 200, theme)[0].match(/\x1b\[(\d+)m[■□]/)?.[1];
  assert.equal(barCode(49), CODE.success);
  assert.equal(barCode(50), CODE.warning);
  assert.equal(barCode(79), CODE.warning);
  assert.equal(barCode(80), CODE.error);
  assert.match(plain(renderFooter({ ...VIEW, contextPercent: null }, 200, theme)[0]), /\? of 1\.0M/);
});

test("CH is green from 80, yellow from 40, red below", () => {
  const chCode = (hit: number | null): string | undefined => renderFooter({ ...VIEW, cacheHit: hit }, 200, theme)[0].match(/\x1b\[(\d+)mCH /)?.[1];
  assert.equal(chCode(80), CODE.success);
  assert.equal(chCode(40), CODE.warning);
  assert.equal(chCode(39), CODE.error);
  assert.ok(!plain(renderFooter({ ...VIEW, cacheHit: null }, 200, theme)[0]).includes("CH "));
});

test("line 2 is the usage text then the foreign statuses; newlines collapse; a status is cut at the width", () => {
  const [, line2] = renderFooter({ ...VIEW, statuses: ["a one", "b\n  two"] }, 200, theme);
  assert.equal(plain(line2), `${VIEW.usage} · a one b two`);
  assert.equal(plain(renderFooter({ ...VIEW, usage: null, statuses: ["only"] }, 200, theme)[1]), "only");
  assert.ok(plain(renderFooter(VIEW, 30, theme)[1]).endsWith("…"));
});

test("footer.style: only \"pi\" selects Pi's footer; any other value or none is the foreman footer", () => {
  assert.equal(footerStyleOf("pi"), "pi");
  assert.equal(footerStyleOf("foreman"), "foreman");
  assert.equal(footerStyleOf(undefined), "foreman");
  assert.equal(footerStyleOf("bogus"), "foreman");
});

test("the mounted footer appends foreign statuses, never repeats the foreman's own keys, and repaints on update", () => {
  const f = new UsageFooter();
  const statuses = new Map([
    [FOOTER_KEY, "usage-should-not-appear"],
    [CACHE_STATUS_KEY, "♨"],
    ["zz-other", "hello\n  world"],
    ["aa-other", "first"],
  ]);
  const data = { getGitBranch: () => "main", getExtensionStatuses: () => statuses };
  const setStatus: string[] = [];
  let repaints = 0;
  const ctx = { mode: "tui", model: { id: "m", reasoning: false, contextWindow: 200_000 }, getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }), ui: { setStatus: (k: string, v: string | undefined) => void setStatus.push(`${k}=${v}`) } };
  const mount = f.mount("s", ctx, { requestRender: () => void repaints++ }, theme, data, () => "high");
  f.update("s", ctx, MSG, { enabled: true, isChild: false, children: 0 });
  assert.equal(repaints, 1);
  assert.deepEqual(setStatus, []);
  const line2 = plain(mount.render(200)[1]);
  assert.equal(line2.split("↑").length - 1, 1, line2);
  assert.ok(!line2.includes("usage-should-not-appear"));
  assert.ok(line2.endsWith("· first hello world"), line2);
});

test("a render that throws falls back to the plain status text", () => {
  const f = new UsageFooter();
  const ctx = { mode: "tui", model: { id: "m" }, getContextUsage: () => { throw new Error("stale"); }, ui: { setStatus: () => undefined } };
  const data = { getGitBranch: () => null, getExtensionStatuses: () => new Map<string, string>() };
  const mount = f.mount("s", ctx, { requestRender: () => undefined }, theme, data, () => "off");
  f.update("s", ctx, MSG, { enabled: true, isChild: false, children: 0 });
  assert.deepEqual(mount.render(80), ["↑1.2M ↓2.3k tok · $0.90 list (warm $0.50 / cold $0.30) · children 0"]);
});

const usageCtx = (calls: string[], extra: Record<string, unknown> = {}) => ({
  notify: () => undefined,
  confirm: async () => false,
  select: async () => "approve",
  setWidget: () => undefined,
  setStatus: (k: string, v: string | undefined) => void calls.push(`${k}=${v}`),
  ...extra,
});

test("footer.style foreman in a tui session installs the footer; the usage line goes to the footer, not the status", async (t) => {
  let factories = 0;
  let mounted: { render(width: number): string[] } | undefined;
  const calls: string[] = [];
  const setFooter = (factory: (tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] }) => {
    factories++;
    mounted = factory({ requestRender: () => undefined }, theme, { getGitBranch: () => "main", getExtensionStatuses: () => new Map() });
  };
  const a = await r11Rig(t, {}, { ctx: { ui: usageCtx(calls, { setFooter }) } });
  assert.equal(factories, 1);
  assert.match(plain(mounted!.render(200)[0]), /^foreman • |^foreman · /);
  await a.launch({ agent: "builder", task: "touch up" });
  assert.ok(!calls.some((c) => c.startsWith(`${FOOTER_KEY}=`)), calls.join("\n"));
});

test("footer.style pi: no setFooter, the usage line stays in the one-line status", async (t) => {
  let factories = 0;
  const calls: string[] = [];
  const a = await r11Rig(t, {}, { config: { footer: { style: "pi" } }, ctx: { ui: usageCtx(calls, { setFooter: () => void factories++ }) } });
  await a.launch({ agent: "builder", task: "touch up" });
  assert.equal(factories, 0);
  assert.ok(calls.some((c) => c.startsWith(`${FOOTER_KEY}=↑`)), calls.join("\n"));
});

test("a child session never installs a footer", async (t) => {
  let factories = 0;
  await r11Rig(t, {}, { child: true, ctx: { ui: usageCtx([], { setFooter: () => void factories++ }) } });
  assert.equal(factories, 0);
});

test("visibleWidth counts East Asian wide and emoji glyphs as two columns; box and dot glyphs stay one", () => {
  assert.equal(visibleWidth("中文"), 4);
  assert.equal(visibleWidth("가"), 2);
  assert.equal(visibleWidth("Ａ"), 2);
  assert.equal(visibleWidth("🚀 ok"), 5);
  assert.equal(visibleWidth("■□ · …"), 6);
});

test("visibleWidth skips SGR and OSC escape sequences", () => {
  assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(visibleWidth("\x1b]8;;https://example.org\x07link\x1b]8;;\x07"), 4);
  assert.equal(visibleWidth("\x1b]0;title\x1b\\ab"), 2);
});

test("fitWidth keeps escape sequences whole and never cuts a wide glyph in half", () => {
  assert.equal(fitWidth("\x1b[31mabcdef\x1b[0m", 4), "\x1b[31mabc\x1b[0m…\x1b[0m");
  assert.equal(fitWidth("\x1b]8;;https://x.y\x07ab\x1b]8;;\x07cd", 3), "\x1b]8;;https://x.y\x07ab\x1b]8;;\x07…\x1b[0m");
  assert.equal(fitWidth("中文字", 4), "中…\x1b[0m");
  const odd = fitWidth("a中b", 3);
  assert.equal(odd, "a…\x1b[0m");
  assert.ok(visibleWidth(odd) <= 3);
});

test("a wide-glyph status line fits the width", () => {
  const line2 = renderFooter({ ...VIEW, usage: null, statuses: ["漢字漢字漢字"] }, 10, theme)[1];
  assert.ok(visibleWidth(line2) <= 10, plain(line2));
});
