import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "../footerview.ts";
import type { PrView } from "../prdots.ts";
import { PrWidget, WIDGET_KEY, collapsedLine, prsListText, renderPrWidget } from "../prwidget.ts";
import type { PrShared, PrWidgetCtx } from "../prwidget.ts";
import { symbolSet } from "../symbols.ts";

const HOST = "github.com";
const CUR = { host: HOST, repo: "acme/pi" };

function view(n: number, over: Partial<PrView> & { repo?: string; counts?: Partial<PrView["checks"]["counts"]>; names?: Partial<Pick<PrView["checks"], "running" | "failed" | "missing" | "passed">> } = {}): PrView {
  const repo = over.repo ?? CUR.repo;
  const foreign = repo !== CUR.repo;
  const names = { running: [], failed: [], missing: [], passed: [], ...over.names };
  const counts = { running: names.running.length, failed: names.failed.length, missing: names.missing.length, passed: 0, ...over.counts };
  const { repo: _r, counts: _c, names: _n, ...rest } = over;
  return {
    key: { host: HOST, repo, n },
    id: `${HOST}/${repo}#${n}`,
    label: foreign ? `${repo}#${n}` : `#${n}`,
    foreign,
    url: `https://${HOST}/${repo}/pull/${n}`,
    title: `title ${n}`,
    state: "open",
    draft: false,
    mergeable: "mergeable",
    reviewDecision: null,
    source: "push",
    checks: { ...names, counts, truncated: false },
    dot: "ok",
    changedAt: 0,
    ...rest,
  };
}

const mockViews = (): PrView[] => [
  view(55, { title: "r55: ladder docs", reviewDecision: "APPROVED", counts: { passed: 12 } }),
  view(204, { repo: "acme/tools", title: "fix: retry on 502", reviewDecision: "REVIEW_REQUIRED", counts: { passed: 6 } }),
  view(57, { title: "r57: cache keep-alive per provider", reviewDecision: "APPROVED", dot: "run", names: { running: ["test (macos)"], missing: ["bench-smoke"] }, counts: { passed: 11 } }),
  view(58, { title: "r58: PR widget, reliable tracking, bot watch", reviewDecision: "REVIEW_REQUIRED", dot: "fail", names: { failed: ["test (ubuntu)"], running: ["bench-smoke", "test (windows)"] }, counts: { passed: 9 } }),
];
const item = (n: number, repo = "acme/web", title = `item ${n}`) => ({ host: HOST, repo, n, title, url: `https://${HOST}/${repo}/pull/${n}` });
const shared = (over: Partial<PrShared> = {}): PrShared => ({
  at: 1_000_000,
  intervalSeconds: 180,
  degraded: false,
  review: [item(7), item(9)],
  failing: [item(118, "acme/web", "chore: lockfile maintenance")],
  touched: [],
  ...over,
});
const NOW = 1_000_000;
const render = (views: PrView[], sh: PrShared | null, width: number, extra: Partial<Parameters<typeof renderPrWidget>[3]> = {}) => renderPrWidget(views, sh, width, { links: false, now: NOW, current: CUR, ...extra });

test("mock-up at width 80 and 120: eight own lines, the watch summary and one watch item, as golden lines", () => {
  const expected = [
    "● #58 r58: PR widget, reliable tracking, bot watch · review? · ✗1 ◉2 ✓9",
    "  ✗ failed: test (ubuntu)",
    "  ◉ running: bench-smoke, test (windows)",
    "◉ #57 r57: cache keep-alive per provider · approved · ◉1 ◌1 ✓11",
    "  ◉ running: test (macos)",
    "  ◌ missing: bench-smoke",
    "○ #55 r55: ladder docs · approved · ✓12",
    "○ acme/tools#204 fix: retry on 502 · review? · ✓6",
    "watch: 2 need review · 1 failing",
    "  ● acme/web#118 chore: lockfile maintenance",
  ];
  assert.deepEqual(render(mockViews(), shared(), 80), expected);
  assert.deepEqual(render(mockViews(), shared(), 120), expected);
});

test("mock-up at width 40: no review word, titles cut, counts instead of names, no watch items (addendum golden lines)", () => {
  const lines = render(mockViews(), shared(), 40);
  assert.deepEqual(lines, [
    "● #58 r58: PR widget, reliab… · ✗1 ◉2 ✓9",
    "  ✗ failed 1 · ◉ running 2",
    "◉ #57 r57: cache keep-alive… · ◉1 ◌1 ✓11",
    "  ◉ running 1 · ◌ missing 1",
    "○ #55 r55: ladder docs · ✓12",
    "○ acme/tools#204 fix: retry on 502 · ✓6",
    "watch: 2 need review · 1 failing",
  ]);
  for (const l of lines) assert.ok(visibleWidth(l) <= 40, l);
});

test("all green, no watch items: compact lines only", () => {
  const v = [view(55, { title: "r55: ladder docs", reviewDecision: "APPROVED", counts: { passed: 12 } }), view(54, { title: "r54: footer context point", reviewDecision: "REVIEW_REQUIRED", counts: { passed: 12 } })];
  assert.deepEqual(render(v, null, 80), ["○ #54 r54: footer context point · review? · ✓12", "○ #55 r55: ladder docs · approved · ✓12"]);
  assert.deepEqual(render([], null, 80), []);
  assert.deepEqual(render([], shared({ review: [], failing: [] }), 80), []);
});

test("breakpoint 60: at 60 the review word and names stay, at 59 the review word goes and detail lines show counts", () => {
  const v = [view(5, { title: "short", dot: "fail", reviewDecision: "APPROVED", names: { failed: ["lint"] }, counts: { passed: 2 } })];
  assert.deepEqual(render(v, null, 60), ["● #5 short · approved · ✗1 ✓2", "  ✗ failed: lint"]);
  assert.deepEqual(render(v, null, 59), ["● #5 short · ✗1 ✓2", "  ✗ failed 1"]);
  const items = render([], shared(), 60);
  assert.equal(items.length, 3);
  assert.equal(render([], shared(), 59).length, 1);
});

test("at or above 60 the title is cut to fit and the review word stays; below it the title is cut only when needed", () => {
  const v = [view(5, { title: "x".repeat(100), reviewDecision: "APPROVED", counts: { passed: 2 } })];
  const wide = render(v, null, 60)[0];
  assert.equal(visibleWidth(wide), 60);
  assert.ok(wide.includes("… · approved · ✓2"));
  const narrow = render(v, null, 30)[0];
  assert.equal(visibleWidth(narrow), 30);
  assert.ok(narrow.endsWith("… · ✓2"));
});

test("expanded block is at most four lines; draft and changes review words; closed counts omitted when zero", () => {
  const v = view(5, { dot: "fail", draft: true, names: { failed: ["a"], running: ["b"], missing: ["c"] } });
  const lines = render([v], null, 80);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes(" · draft · "));
  assert.deepEqual(render([view(6, { reviewDecision: "CHANGES_REQUESTED", counts: { passed: 1 } })], null, 80), ["○ #6 title 6 · changes! · ✓1"]);
  const three = render([v], null, 40);
  assert.deepEqual(three.slice(1), ["  ✗ failed 1 · ◉ running 1", "  ◌ missing 1"]);
});

test("order: fail, run, ok, none, current repo before foreign, by number, merged last", () => {
  const v = [
    view(3, { dot: "none" }),
    view(9, { repo: "acme/tools", dot: "ok" }),
    view(7, { dot: "ok" }),
    view(2, { dot: "run", names: { running: ["r"] } }),
    view(1, { dot: "fail", names: { failed: ["f"] } }),
    view(4, { state: "merged", dot: "none", closedAt: 0 }),
  ];
  const heads = render(v, null, 80).filter((l) => !l.startsWith("  "));
  assert.deepEqual(heads, ["● #1 title 1 · ✗1", "◉ #2 title 2 · ◉1", "○ #7 title 7", "○ acme/tools#9 title 9", "◌ #3 title 3", "✓ merged #4 title 4"]);
});

test("six PRs: eight own lines at most, the last line is +n more PRs", () => {
  const v = [1, 2, 3, 4, 5, 6].map((n) => view(n, { dot: "fail", names: { failed: ["f"] } }));
  const lines = render(v, null, 80);
  assert.equal(lines.length, 8);
  assert.equal(lines[7], "+2 more PRs");
  assert.deepEqual(lines.slice(0, 7).map((l) => l.startsWith("  ")), [false, true, false, true, false, true, false]);
  const green = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => view(n, { counts: { passed: 1 } }));
  const g = render(green, null, 80);
  assert.equal(g.length, 8);
  assert.equal(g[7], "+2 more PRs");
  assert.equal(render(green.slice(0, 8), null, 80).length, 8);
  assert.ok(!render(green.slice(0, 8), null, 80).some((l) => l.includes("more PRs")));
});

test("a foreign PR reads owner/name#n; the counts end with + when the host cut the list", () => {
  const v = [view(204, { repo: "acme/tools", counts: { passed: 12 } })];
  v[0].checks.truncated = true;
  assert.deepEqual(render(v, null, 80), ["○ acme/tools#204 title 204 · ✓12+"]);
});

test("merged and closed PRs show a dim glyph line and fade through the view list", () => {
  const themed = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` };
  const merged = view(55, { state: "merged", title: "r55: ladder docs", closedAt: 0 });
  assert.deepEqual(render([merged], null, 80), ["✓ merged #55 r55: ladder docs"]);
  assert.deepEqual(render([merged], null, 80, { theme: themed as never }), ["<dim>✓ merged #55 r55: ladder docs</dim>"]);
  assert.deepEqual(render([{ ...merged, state: "closed" }], null, 80), ["✗ closed #55 r55: ladder docs"]);
});

test("colours: fail red, run yellow, missing dim, ok line dim", () => {
  const themed = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as never;
  const v = [view(1, { dot: "fail", names: { failed: ["f"] }, counts: { passed: 1 } }), view(2, { counts: { passed: 1 } })];
  const lines = render(v, null, 80, { theme: themed });
  assert.ok(lines[0].startsWith("<error>●</error> #1 title 1 · <error>✗1</error> <success>✓1</success>"));
  assert.equal(lines[1], "<error>  ✗ failed: f</error>");
  assert.equal(lines[2], "<dim>○ #2 title 2 · ✓1</dim>");
});

test("watch section: failing first, review with the ask glyph, at most two items, ten lines in total, touched never rendered", () => {
  const sh = shared({ review: [item(1), item(2), item(3)], failing: [item(118, "acme/web", "chore: lockfile")], touched: [{ host: HOST, repo: "acme/pi", n: 99, url: `https://${HOST}/acme/pi/pull/99`, at: NOW }] });
  const lines = render([], sh, 80);
  assert.deepEqual(lines, ["watch: 3 need review · 1 failing", "  ● acme/web#118 chore: lockfile", "  ? acme/web#1 item 1"]);
  assert.ok(!lines.join("\n").includes("99"));
  const own = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => view(n, { counts: { passed: 1 } }));
  const full = render(own, sh, 80);
  assert.equal(full.length, 10);
  assert.equal(full[8], "watch: 3 need review · 1 failing");
  assert.equal(full[9], "  ● acme/web#118 chore: lockfile");
  const only = render([], shared({ failing: [] }), 80);
  assert.equal(only[0], "watch: 2 need review");
  assert.equal(render([], shared({ review: [] }), 80)[0], "watch: 1 failing");
  assert.equal(render([], shared({ review: [], failing: [], touched: [{ host: HOST, repo: "a/b", n: 1, url: null, at: NOW }] }), 80).length, 0);
  assert.equal(render([], sh, 80, { symbols: symbolSet("ascii") })[2], "  ? acme/web#1 item 1");
});

test("watch items of the current repository read #n", () => {
  const sh = shared({ review: [item(4, "acme/pi", "mine")], failing: [] });
  assert.deepEqual(render([], sh, 80), ["watch: 1 need review", "  ? #4 mine"]);
});

test("stale and degraded snapshots render dim with a stale mark", () => {
  const themed = { fg: (c: string, t: string) => `<${c}>${t}</${c}>` } as never;
  const fresh = render([], shared(), 80, { theme: themed });
  assert.equal(fresh[0], "watch: 2 need review · 1 failing");
  const old = render([], shared(), 80, { theme: themed, now: NOW + 3 * 180_000 + 1 });
  assert.equal(old[0], "<dim>watch: 2 need review · 1 failing · stale</dim>");
  assert.ok(old[1].startsWith("<dim>"));
  const degraded = render([], shared({ degraded: true }), 80, { theme: themed });
  assert.equal(degraded[0], "<dim>watch: 2 need review · 1 failing · stale</dim>");
  assert.equal(render([], shared(), 80, { theme: themed, now: NOW + 3 * 180_000 })[0], "watch: 2 need review · 1 failing");
});

const OSC = (url: string, label: string) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

test("links: the label is a hyperlink only when the URL matches the key; width is unchanged", () => {
  const v = [view(55, { counts: { passed: 1 } })];
  const plain = render(v, null, 80, { links: false });
  const linkedLines = render(v, null, 80, { links: true });
  assert.equal(linkedLines[0], `○ ${OSC("https://github.com/acme/pi/pull/55", "#55")} title 55 · ✓1`);
  assert.equal(visibleWidth(linkedLines[0]), visibleWidth(plain[0]));
  assert.deepEqual(plain, ["○ #55 title 55 · ✓1"]);
  for (const url of ["https://github.com/acme/pi/pull/56", "https://github.com/acme/other/pull/55", "https://example.org/acme/pi/pull/55", "http://github.com/acme/pi/pull/55", "https://github.com/acme/pi/pull/55\x1b\\x", "https://github.com/acme/pi/pull/55 x", "https://github.com/acme/pi/pull/55\u0085", null]) {
    assert.deepEqual(render([{ ...v[0], url }], null, 80, { links: true }), plain, String(url));
  }
  const gl = view(8, { key: { host: "gitlab.example.com", repo: "acme/pi", n: 8 }, url: "https://gitlab.example.com/acme/pi/-/merge_requests/8", counts: { passed: 1 } });
  assert.ok(render([gl], null, 80, { links: true })[0].includes("\x1b]8;;https://gitlab.example.com/acme/pi/-/merge_requests/8"));
  const w = render([view(5, { title: "x".repeat(100), counts: { passed: 1 } })], null, 40, { links: true })[0];
  assert.equal(visibleWidth(w), 40);
});

test("watch item labels link only for a matching URL", () => {
  const sh = shared({ review: [], failing: [item(118), { ...item(119), url: "https://github.com/acme/web/pull/1" }] });
  const lines = render([], sh, 80, { links: true });
  assert.ok(lines[1].includes(OSC("https://github.com/acme/web/pull/118", "acme/web#118")));
  assert.ok(!lines[2].includes("\x1b]8"));
});

test("control and format characters in titles, names and snapshot strings never reach the output", () => {
  const evil = "a\x1b[31mb\x9b2Jc\u202ed\u200be\x07f\nG";
  const v = [view(1, { title: evil, dot: "fail", names: { failed: [evil] }, label: `#1${evil}` })];
  const sh = shared({ review: [item(1, "acme/web", evil)], failing: [{ ...item(2, `ac${evil}me/web`, evil), host: `gh${evil}` }] });
  for (const width of [40, 80]) {
    assert.ok(!render(v, sh, width).join("\n").includes("\x1b"));
    const out = render(v, sh, width, { links: true }).join("\n").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");
    assert.ok(!/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2064]/.test(out.replace(/\n/g, "")), out);
    assert.ok(!out.includes("\x1b"), out);
    assert.ok(out.includes("a[31mbc2Jc") || out.includes("a[31mb"), out);
  }
  const listed = prsListText(v, sh);
  assert.ok(!listed.includes("\x1b") && !listed.includes("\x9b") && !listed.includes("\u202e"));
});

test("no line is wider than the width, at any width", () => {
  const long = [...mockViews(), view(300, { repo: "acme/very-long-repository-name-here", title: "y".repeat(300), dot: "fail", names: { failed: ["z".repeat(200)] }, counts: { passed: 3 } })];
  for (const width of [1, 2, 5, 10, 20, 39, 40, 59, 60, 61, 80, 120]) {
    for (const links of [false, true]) {
      for (const l of render(long, shared(), width, { links })) assert.ok(visibleWidth(l) <= width, `${width}: ${l}`);
    }
  }
});

test("collapsed line and /foreman prs list text", () => {
  assert.equal(collapsedLine([view(1, { dot: "fail" }), view(2, { dot: "run" }), view(3), view(4), view(5, { state: "merged" })], shared({ review: [item(1), item(2)], failing: [] })), "PRs: 1 fail · 1 run · 2 ok · watch 2");
  assert.equal(collapsedLine([], null), "PRs: none");
  const text = prsListText(mockViews(), shared({ touched: [{ host: HOST, repo: "acme/pi", n: 99, url: `https://${HOST}/acme/pi/pull/99`, at: NOW }] }));
  assert.ok(text.includes("github.com acme/pi#58 · open · fail · r58: PR widget, reliable tracking, bot watch · https://github.com/acme/pi/pull/58"));
  assert.ok(text.includes("github.com acme/tools#204"));
  assert.ok(text.includes("shared watch: 2 need review · 1 failing · 1 touched"));
  assert.ok(text.includes("  touched:\n    github.com acme/pi#99 · https://github.com/acme/pi/pull/99"));
  assert.ok(text.includes("  failing:\n    github.com acme/web#118 · chore: lockfile maintenance · https://github.com/acme/web/pull/118"));
  assert.ok(prsListText([], null).includes("none tracked") && prsListText([], null).includes("no snapshot"));
});

// ---------------------------------------------------------------- PrWidget

function rig(initial: PrView[] = mockViews(), sh: PrShared | null = null) {
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let clock = 5_000_000;
  let seq = 0;
  const state = { views: initial, shared: sh };
  const calls: Array<{ key: string; removed: boolean; placement?: string }> = [];
  let factory: ((tui: { requestRender(): void }, theme?: never) => { render(width: number): string[] }) | undefined;
  let renders = 0;
  const ctx = (mode = "tui"): PrWidgetCtx => ({
    mode,
    ui: {
      setWidget(key, content, options) {
        calls.push({ key, removed: content === undefined, placement: options?.placement });
        factory = content as never;
      },
    },
  });
  const widget = new PrWidget({
    views: () => state.views,
    shared: () => state.shared,
    current: () => CUR,
    now: () => clock,
    timers: {
      set: (fn, ms) => {
        const t = { id: ++seq, at: clock + ms, fn };
        timers.push(t);
        return t.id;
      },
      clear: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= clock && timers.includes(t)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  const mount = () => factory?.({ requestRender: () => void renders++ });
  return { widget, state, calls, ctx, advance, mount, renders: () => renders, timers };
}
const opts = { enabled: true, links: false };

test("PrWidget mounts once above the editor under key pi-foreman-prs and renders inside render(width)", () => {
  const r = rig();
  r.widget.request(r.ctx(), opts);
  assert.deepEqual(r.calls, [{ key: WIDGET_KEY, removed: false, placement: "aboveEditor" }]);
  assert.equal(WIDGET_KEY, "pi-foreman-prs");
  const c = r.mount()!;
  assert.deepEqual(c.render(40), render(mockViews(), null, 40));
  assert.deepEqual(c.render(80), render(mockViews(), null, 80));
});

test("PrWidget: an unchanged signature neither mounts again nor requests a render; a change requests one, debounced to one per second", () => {
  const r = rig();
  r.widget.request(r.ctx(), opts);
  r.mount();
  r.advance(1500);
  r.widget.refresh();
  assert.equal(r.calls.length, 1);
  assert.equal(r.renders(), 0);
  r.advance(1000);
  r.state.views = mockViews().slice(1);
  r.widget.refresh();
  assert.equal(r.renders(), 1);
  r.state.views = mockViews().slice(2);
  r.widget.refresh();
  r.widget.refresh();
  assert.equal(r.renders(), 1);
  r.advance(1000);
  assert.equal(r.renders(), 2);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.mount()!.render(80), render(mockViews().slice(2), null, 80));
});

test("PrWidget: removed once when empty and mounted again when data returns", () => {
  const r = rig();
  r.widget.request(r.ctx(), opts);
  r.advance(1500);
  r.state.views = [];
  r.widget.refresh();
  assert.deepEqual(r.calls.map((c) => c.removed), [false, true]);
  r.advance(1500);
  r.widget.refresh();
  assert.equal(r.calls.length, 2);
  r.state.views = mockViews();
  r.widget.refresh();
  r.advance(1000);
  assert.deepEqual(r.calls.map((c) => c.removed), [false, true, false]);
});

test("PrWidget: a watch-only snapshot mounts, widget.prs off removes, a non-tui mode never mounts", () => {
  const r = rig([], shared({ at: 5_000_000 }));
  r.widget.request(r.ctx(), opts);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.mount()!.render(80), ["watch: 2 need review · 1 failing", "  ● acme/web#118 chore: lockfile maintenance", "  ? acme/web#7 item 7"]);
  r.widget.request(r.ctx(), { ...opts, enabled: false });
  assert.deepEqual(r.calls.map((c) => c.removed), [false, true]);
  r.widget.request(r.ctx(), { ...opts, enabled: false });
  assert.equal(r.calls.length, 2);
  const p = rig();
  p.widget.request(p.ctx("print"), opts);
  p.widget.request(p.ctx("rpc"), opts);
  assert.equal(p.calls.length, 0);
  const off = rig();
  off.widget.request(off.ctx(), { ...opts, enabled: false });
  assert.equal(off.calls.length, 0);
});

test("/foreman prs cycles auto, collapsed, hidden and back", () => {
  const r = rig(mockViews(), shared());
  r.widget.request(r.ctx(), opts);
  const c = r.mount()!;
  assert.equal(r.widget.currentMode(), "auto");
  assert.equal(r.widget.cycle(), "collapsed");
  assert.equal(r.renders(), 1);
  assert.deepEqual(c.render(80), ["PRs: 1 fail · 1 run · 2 ok · watch 3"]);
  assert.equal(r.widget.cycle(), "hidden");
  assert.deepEqual(r.calls.map((x) => x.removed), [false, true]);
  assert.equal(r.widget.cycle(), "auto");
  assert.deepEqual(r.calls.map((x) => x.removed), [false, true, false]);
  assert.equal(r.widget.currentMode(), "auto");
});

test("PrWidget: a merged view's fade is refreshed once its minute is up; dispose stops timers", () => {
  const merged = view(55, { state: "merged", dot: "none", title: "r55", closedAt: 5_000_000 });
  const r = rig([merged]);
  r.widget.request(r.ctx(), opts);
  assert.equal(r.calls.length, 1);
  r.state.views = [];
  r.advance(60_100);
  assert.deepEqual(r.calls.map((c) => c.removed), [false, true]);
  const d = rig([merged]);
  d.widget.request(d.ctx(), opts);
  d.widget.dispose();
  assert.equal(d.timers.length, 0);
  d.widget.refresh();
  assert.equal(d.calls.length, 1);
});

test("PrWidget.listText is the notice of /foreman prs list", () => {
  const r = rig(mockViews(), shared());
  assert.equal(r.widget.listText(), prsListText(mockViews(), shared()));
});
