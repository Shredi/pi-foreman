// Round 67: the titled divider above the PR widget, the widget glyphs against config/symbols.json, and dots() against views().
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "../footerview.ts";
import type { PrView } from "../prdots.ts";
import { MAX_TOTAL_LINES, PrWidget, dividerLine, renderPrWidget } from "../prwidget.ts";
import type { PrShared } from "../prwidget.ts";
import { symbolSet } from "../symbols.ts";
import { pre, ran, rig, url } from "./_prrig.ts";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "config", "symbols.json");
const PLAIN = { fg: (_c: string, t: string) => t };
const THEMED = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
const CUR = { host: "github.com", repo: "acme/pi" };

function view(n: number, over: Partial<PrView> & { failed?: string[]; running?: string[] } = {}): PrView {
  const { failed = [], running = [], ...rest } = over;
  return {
    key: { host: "github.com", repo: CUR.repo, n },
    id: `github.com/${CUR.repo}#${n}`,
    label: `#${n}`,
    foreign: false,
    url: `https://github.com/${CUR.repo}/pull/${n}`,
    title: `title ${n}`,
    state: "open",
    draft: false,
    mergeable: "mergeable",
    reviewDecision: null,
    source: "push",
    checks: { running, failed, missing: [], passed: [], counts: { running: running.length, failed: failed.length, missing: 0, passed: 0 }, truncated: false },
    dot: "ok",
    changedAt: 0,
    ...rest,
  } as PrView;
}

/** The widget as Pi mounts it: the component `setWidget` received, rendered at a width. */
function mounted(views: PrView[], sh: PrShared | null = null, symbols = "unicode") {
  let factory: ((tui: { requestRender(): void }) => { render(width: number): string[] }) | undefined;
  const w = new PrWidget({ views: () => views, shared: () => sh, current: () => CUR, now: () => 1_000_000 });
  w.request({ mode: "tui", ui: { setWidget: (_k, content) => void (factory = content as typeof factory) } }, { enabled: true, links: false, symbols });
  return { w, c: factory?.({ requestRender: () => undefined }) };
}

const FILL = (n: number, rule = "─") => rule.repeat(n);

test("divider at width 72 with unicode: ── PRs (3) then the rule to exactly 72 columns", () => {
  const d = dividerLine(3, 72, PLAIN, symbolSet("unicode"));
  assert.equal(d, `── PRs (3) ${FILL(61)}`);
  assert.equal(visibleWidth(d), 72);
});

test("divider with ascii: -- PRs (3) and dashes, no rule glyph of another set", () => {
  const d = dividerLine(3, 72, PLAIN, symbolSet("ascii"));
  assert.equal(d, `-- PRs (3) ${FILL(61, "-")}`);
  assert.equal(visibleWidth(d), 72);
});

test("divider below 12 columns is a plain rule of the exact width", () => {
  assert.equal(dividerLine(3, 10, PLAIN, symbolSet("unicode")), FILL(10));
  assert.equal(dividerLine(3, 11, PLAIN, symbolSet("ascii")), FILL(11, "-"));
  assert.equal(dividerLine(0, 1, PLAIN, symbolSet("unicode")), FILL(1));
});

test("divider whose title does not fit falls back to a plain rule of the exact width", () => {
  let d = "";
  assert.doesNotThrow(() => {
    d = dividerLine(100, 12, PLAIN, symbolSet("unicode"));
  });
  assert.equal(d, FILL(12));
  assert.equal(visibleWidth(d), 12);
});

test("divider at 12 columns carries the title; no count when no view is open", () => {
  assert.equal(dividerLine(2, 12, PLAIN, symbolSet("unicode")), `── PRs (2) ${FILL(1)}`);
  assert.equal(dividerLine(0, 72, PLAIN, symbolSet("unicode")), `── PRs ${FILL(65)}`);
  assert.equal(visibleWidth(dividerLine(0, 72, PLAIN, symbolSet("unicode"))), 72);
});

test("divider is dim and drawn in the theme's dim colour", () => {
  assert.equal(dividerLine(1, 20, THEMED, symbolSet("unicode")), `<dim>── PRs (1) ${FILL(9)}</dim>`);
});

test("widget: the divider is the first line, counts open PRs and is not part of the ten-line cap", () => {
  const own = Array.from({ length: 12 }, (_, i) => view(i + 1, { dot: "fail", failed: ["f"] }));
  const { c } = mounted(own);
  const lines = c!.render(80);
  assert.equal(lines[0], `── PRs (12) ${FILL(68)}`);
  const body = renderPrWidget(own, null, 80, { links: false });
  assert.ok(body.length <= MAX_TOTAL_LINES);
  assert.deepEqual(lines.slice(1), body);
});

test("widget at width 72 with ascii: the rule line is exact and the PR lines follow", () => {
  const { c } = mounted([view(1, { dot: "run", running: ["build"] })], null, "ascii");
  const lines = c!.render(72);
  assert.equal(lines[0], `-- PRs (1) ${FILL(61, "-")}`);
  assert.equal(visibleWidth(lines[0]), 72);
  assert.ok(lines[1].startsWith("* "));
});

test("widget with watch items only: the rule has no count and the watch summary follows", () => {
  const sh: PrShared = { at: 1_000_000, intervalSeconds: 180, degraded: false, review: [{ host: "github.com", repo: "acme/web", n: 7, title: "item 7", url: null }], failing: [], touched: [] };
  const lines = mounted([], sh).c!.render(72);
  assert.equal(lines[0], `── PRs ${FILL(65)}`);
  assert.equal(lines[1], "watch: 1 need review");
});

test("widget collapsed: the rule with the open count, then the collapsed line", () => {
  const views = [view(1, { dot: "fail", failed: ["f"] }), view(2, { dot: "run", running: ["r"] }), view(3), view(4)];
  const { w, c } = mounted(views);
  assert.equal(w.cycle(), "collapsed");
  assert.deepEqual(c!.render(72), [`── PRs (4) ${FILL(61)}`, "PRs: 1 fail · 1 run · 2 ok"]);
});

test("widget: no lines when empty", () => {
  assert.equal(mounted([], null).c, undefined, "nothing is mounted for an empty widget");
});

test("widget: every line is at most the width, and the divider is exactly the width, at every width", () => {
  const views = Array.from({ length: 9 }, (_, i) => view(i + 1, { dot: "fail", failed: ["a-very-long-check-name"], title: "t".repeat(120) }));
  const { c } = mounted(views);
  for (const width of [1, 5, 10, 11, 12, 40, 72, 120]) {
    const lines = c!.render(width);
    assert.equal(visibleWidth(lines[0]), width, `divider at ${width}`);
    for (const l of lines) assert.ok(visibleWidth(l) <= width, `${width}: ${l}`);
  }
});

test("renderPrWidget itself has no divider: the rule belongs to the component", () => {
  const lines = renderPrWidget([view(1)], null, 80, { links: false });
  assert.deepEqual(lines, ["○ #1 title 1"]);
});

test("every set: the widget glyphs are the pr-<state> circles of config/symbols.json, and the rule is its rule", () => {
  const shared = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const name of ["unicode", "emoji", "nerd", "ascii"] as const) {
    const set = symbolSet(name);
    assert.equal(set.rule, shared[name].rule, `${name} rule`);
    const expect: Record<string, { dot: PrView["dot"]; view: PrView }> = {
      fail: { dot: "fail", view: view(1, { dot: "fail", failed: ["f"] }) },
      run: { dot: "run", view: view(1, { dot: "run", running: ["r"] }) },
      ok: { dot: "ok", view: view(1, { dot: "ok" }) },
      none: { dot: "none", view: view(1, { dot: "none" }) },
    };
    for (const [state, { view: v }] of Object.entries(expect)) {
      const glyph = shared[name][`pr-${state}`];
      assert.equal(set[`pr-${state}` as "pr-fail"], glyph, `${name} pr-${state}`);
      const line = renderPrWidget([v], null, 80, { links: false, symbols: set })[0];
      assert.ok(line.startsWith(`${glyph} `), `${name} ${state}: ${line}`);
    }
  }
});

test("dots() and views() agree on fail for a PR with failed and running checks", async () => {
  const checks = { pending: ["build"], failed: ["lint"], passed: [], missing: [], counts: { pending: 1, failed: 1, passed: 0, missing: 0 }, truncated: false };
  const h = rig({ branch: "" });
  h.d.onCreated(1, url("acme/app", 1));
  h.state.handle = (c) =>
    c.op === "pr_batch"
      ? ran({ prs: [{ repo: "acme/app", number: 1, url: url("acme/app", 1), title: "t", state: "open", draft: false, mergeable: "mergeable", reviewDecision: "approved", headRefName: "b1", checks }], errors: [] })
      : pre("pr_not_found");
  h.d.start();
  await h.fire();
  const v = h.d.views().find((x) => x.key.n === 1);
  assert.deepEqual(h.d.dots(), [{ n: 1, state: "fail", url: url("acme/app", 1) }]);
  assert.equal(v?.dot, "fail");
  assert.deepEqual(v?.checks.running, ["build"]);
  assert.deepEqual(v?.checks.failed, ["lint"]);
});

test("counters: one space between each symbol and its number, a + when truncated, every line within the width, per set", () => {
  for (const name of ["unicode", "emoji", "nerd", "ascii"] as const) {
    const sym = symbolSet(name);
    const v = view(1, { dot: "fail", failed: ["f", "g", "h"], running: ["r", "s"] });
    v.checks.passed = ["p"];
    v.checks.counts = { running: 2, failed: 3, missing: 0, passed: 1 };
    v.checks.truncated = true;
    for (const width of [40, 72]) {
      const line = renderPrWidget([v], null, width, { links: false, symbols: sym })[0];
      assert.ok(line.includes(`${sym.lost} 3 ${sym["pr-run"]} 2 ${sym.recent} 1+`), `${name} ${width}: ${line}`);
      assert.ok(visibleWidth(line) <= width, `${name} ${width}: ${visibleWidth(line)} columns`);
    }
  }
});

test("counters with emoji: the emoji set's wide glyphs are counted as two cells, the line still fits", () => {
  const sym = symbolSet("emoji");
  const v = view(7, { dot: "fail", failed: ["f"] });
  v.checks.counts = { running: 0, failed: 3, missing: 2, passed: 1 };
  v.checks.passed = ["p"];
  for (const width of [12, 24, 40, 72]) {
    const line = renderPrWidget([v], null, width, { links: false, symbols: sym })[0];
    assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  const wide = renderPrWidget([v], null, 80, { links: false, symbols: sym })[0];
  assert.ok(wide.includes(`${sym.lost} 3`), wide);
});
