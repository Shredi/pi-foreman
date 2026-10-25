// PR widget above the editor (docs/tools.md, "PR widget"): one line per tracked PR when green, up to four lines
// when something fails or runs, eight lines for own PRs, then the shared watch summary. renderPrWidget is a pure
// layout of data the poller (prdots.ts) and the shared snapshot already hold; PrWidget mounts it once and renders
// inside render(width) so a terminal resize needs no new data. Every string from the host is stripped of control
// and format characters again here. Display only: nothing reaches the model.
import { fitWidth, visibleWidth } from "./footerview.ts";
import type { FooterTheme } from "./footerview.ts";
import type { PrView } from "./prdots.ts";
import { keyString, parsePrUrl } from "./prtrack.ts";
import type { PrKey } from "./prtrack.ts";
import { realTimers } from "./prwatch.ts";
import type { Timers } from "./prwatch.ts";
import { symbolSet } from "./symbols.ts";
import type { SymbolSet } from "./symbols.ts";

export const WIDGET_KEY = "pi-foreman-prs";
/** Columns from which titles and detail lines show names and the review word stays. */
export const WIDE_FROM = 60;
export const MAX_OWN_LINES = 8;
export const MAX_TOTAL_LINES = 10;
export const MAX_WATCH_ITEMS = 2;
export const RENDER_GAP_MS = 1000;
export const STALE_INTERVALS = 3;
export type PrsMode = "auto" | "collapsed" | "hidden";

export interface SharedItem {
  host: string;
  repo: string;
  n: number;
  title: string;
  url: string | null;
}
/** The parsed shared snapshot (the leader's file, read on the PrDots tick); `at` is epoch milliseconds. */
export interface PrShared {
  at: number;
  intervalSeconds: number;
  degraded: boolean;
  sources?: { notifications?: string; events?: string };
  review: SharedItem[];
  failing: SharedItem[];
  touched: Array<{ host: string; repo: string; n: number; url: string | null; at: number }>;
}
export interface RenderOpts {
  links: boolean;
  theme?: FooterTheme;
  symbols?: SymbolSet;
  /** Clock reading for the stale check. */
  now?: number;
  /** The host-resolved current repository: its watch items read `#n`. */
  current?: { host: string; repo: string } | null;
}

const PLAIN: FooterTheme = { fg: (_c, t) => t };
const URL_OK = /^https:\/\/[\x21-\x7e]+$/;

/** Host or snapshot text as one plain line of display data. */
export const clean = (v: unknown, max = 200): string => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : "");

const vw = visibleWidth;

/** Cuts plain text to `avail` columns, ending with `…` when it was longer. */
function cut(text: string, avail: number): string {
  if (vw(text) <= avail) return text;
  let out = "";
  let cols = 0;
  for (const ch of text) {
    const w = vw(ch);
    if (cols + w > avail - 1) break;
    out += ch;
    cols += w;
  }
  return `${out}…`;
}

/** The label as an OSC 8 hyperlink when the URL is plain https and names the same host, repository and number as the key. */
function linked(label: string, url: string | null, key: PrKey, links: boolean): string {
  if (!links || typeof url !== "string" || !URL_OK.test(url)) return label;
  const k = parsePrUrl(url);
  if (!k || keyString(k) !== keyString(key)) return label;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

const REVIEW: Record<string, string> = { review_required: "review?", changes_requested: "changes!", approved: "approved" };
function reviewWord(v: PrView): string {
  if (v.draft) return "draft";
  return typeof v.reviewDecision === "string" ? (REVIEW[v.reviewDecision.toLowerCase()] ?? "") : "";
}

const RANK = { fail: 0, run: 1, ok: 2, none: 3 } as const;

/** Order: open before merged or closed, fail, run, ok, none, current repository before foreign, by number. */
export function orderViews(views: PrView[]): PrView[] {
  const closed = (v: PrView) => (v.state === "open" ? 0 : 1);
  return [...views].sort((a, b) => closed(a) - closed(b) || RANK[a.dot] - RANK[b.dot] || Number(a.foreign) - Number(b.foreign) || a.key.n - b.key.n);
}

interface Ctx {
  width: number;
  theme: FooterTheme;
  sym: SymbolSet;
  links: boolean;
}

function counts(v: PrView, c: Ctx, theme: FooterTheme): string {
  const n = v.checks.counts;
  const parts: string[] = [];
  if (n.failed > 0) parts.push(theme.fg("error", `${c.sym.lost}${n.failed}`));
  if (n.running > 0) parts.push(theme.fg("warning", `${c.sym["pr-run"]}${n.running}`));
  if (n.missing > 0) parts.push(theme.fg("dim", `${c.sym["pr-none"]}${n.missing}`));
  if (n.passed > 0) parts.push(theme.fg("success", `${c.sym.recent}${n.passed}`));
  const text = parts.join(" ");
  return text && v.checks.truncated ? `${text}+` : text;
}

/** `<circle> <label> <title> · <review> · <counts>`; below the breakpoint the review word goes first, then the title is cut. */
function headerLine(v: PrView, c: Ctx): string {
  const label = linked(clean(v.label, 80), v.url, v.key, c.links);
  const title = clean(v.title);
  const plainDot = v.dot === "fail" ? "error" : v.dot === "run" ? "warning" : v.dot === "ok" ? "success" : "dim";
  const glyph = c.sym[`pr-${v.dot}` as "pr-fail"];
  const compact = v.dot === "ok" || v.dot === "none";
  const review = c.width >= WIDE_FROM ? reviewWord(v) : "";
  const cnt = counts(v, c, compact ? PLAIN : c.theme);
  const tail = [review, cnt].filter(Boolean).map((p) => ` · ${p}`).join("");
  const head = `${compact ? glyph : c.theme.fg(plainDot, glyph)} ${label}`;
  const avail = c.width - vw(head) - 1 - vw(tail);
  const shown = title && avail >= 2 ? ` ${cut(title, avail)}` : "";
  const line = `${head}${shown}${tail}`;
  return compact ? c.theme.fg("dim", line) : line;
}

function closedLine(v: PrView, c: Ctx): string {
  const word = v.state === "merged" ? "merged" : "closed";
  const glyph = v.state === "merged" ? c.sym.recent : c.sym.lost;
  const head = `${glyph} ${word} ${linked(clean(v.label, 80), v.url, v.key, c.links)}`;
  const title = clean(v.title);
  const avail = c.width - vw(head) - 1;
  return c.theme.fg("dim", `${head}${title && avail >= 2 ? ` ${cut(title, avail)}` : ""}`);
}

function detailLines(v: PrView, c: Ctx): string[] {
  const groups = [
    { name: "failed", glyph: c.sym.lost, color: "error" as const, names: v.checks.failed, count: v.checks.counts.failed },
    { name: "running", glyph: c.sym["pr-run"], color: "warning" as const, names: v.checks.running, count: v.checks.counts.running },
    { name: "missing", glyph: c.sym["pr-none"], color: "dim" as const, names: v.checks.missing, count: v.checks.counts.missing },
  ].filter((g) => g.count > 0);
  if (c.width >= WIDE_FROM) {
    return groups.map((g) => {
      const list = g.names.map((x) => clean(x, 120));
      const more = g.count > list.length ? ` +${g.count - list.length}` : "";
      return c.theme.fg(g.color, `  ${g.glyph} ${g.name}: ${list.length ? list.join(", ") : g.count}${list.length ? more : ""}`);
    });
  }
  const cells = groups.map((g) => c.theme.fg(g.color, `${g.glyph} ${g.name} ${g.count}`));
  const lines = cells.length > 2 ? [cells.slice(0, 2).join(" · "), cells[2]] : cells.length ? [cells.join(" · ")] : [];
  return lines.map((l) => `  ${l}`);
}

function blockOf(v: PrView, c: Ctx): string[] {
  if (v.state !== "open") return [closedLine(v, c)];
  const head = headerLine(v, c);
  if (v.dot !== "fail" && v.dot !== "run") return [head];
  return [head, ...detailLines(v, c).slice(0, 3)];
}

function watchLines(shared: PrShared, room: number, c: Ctx, opts: RenderOpts): string[] {
  const review = shared.review.length;
  const failing = shared.failing.length;
  if (review + failing === 0 || room < 1) return [];
  const stale = shared.degraded || (typeof opts.now === "number" && opts.now - shared.at > STALE_INTERVALS * Math.max(1, shared.intervalSeconds) * 1000);
  const dim = (t: string) => (stale ? c.theme.fg("dim", t) : t);
  const parts = [review > 0 ? `${review} need review` : "", failing > 0 ? `${failing} failing` : ""].filter(Boolean);
  const out = [dim(`watch: ${parts.join(" · ")}${stale ? " · stale" : ""}`)];
  if (c.width < WIDE_FROM) return out;
  const items = [
    ...shared.failing.map((i) => ({ i, glyph: c.sym["pr-fail"] })),
    ...shared.review.map((i) => ({ i, glyph: c.sym.ask })),
  ].slice(0, Math.min(MAX_WATCH_ITEMS, room - 1));
  for (const { i, glyph } of items) {
    const key: PrKey = { host: clean(i.host, 100), repo: clean(i.repo, 140), n: i.n };
    const cur = opts.current;
    const same = !!cur && cur.host.toLowerCase() === key.host.toLowerCase() && cur.repo.toLowerCase() === key.repo.toLowerCase();
    const plain = same ? `#${key.n}` : `${key.repo}#${key.n}`;
    const head = `  ${glyph} ${linked(plain, i.url, key, c.links)}`;
    const title = clean(i.title);
    const avail = c.width - vw(head) - 1;
    out.push(dim(`${head}${title && avail >= 2 ? ` ${cut(title, avail)}` : ""}`));
  }
  return out;
}

/** The widget lines for `views` (any order) and the shared snapshot (null: none), none wider than `width`. */
export function renderPrWidget(views: PrView[], shared: PrShared | null, width: number, opts: RenderOpts): string[] {
  const c: Ctx = { width, theme: opts.theme ?? PLAIN, sym: opts.symbols ?? symbolSet("unicode"), links: opts.links };
  const ordered = orderViews(views);
  let own: string[] = [];
  const headers = new Set<number>();
  let overflow = false;
  for (const v of ordered) {
    const block = blockOf(v, c);
    if (own.length + block.length > MAX_OWN_LINES) {
      overflow = true;
      break;
    }
    headers.add(own.length);
    own = own.concat(block);
  }
  if (overflow) {
    if (own.length >= MAX_OWN_LINES) {
      own.pop();
      for (const h of [...headers]) if (h >= own.length) headers.delete(h);
    }
    own.push(c.theme.fg("dim", `+${ordered.length - headers.size} more PRs`));
  }
  const watch = shared ? watchLines(shared, MAX_TOTAL_LINES - own.length, c, opts) : [];
  return [...own, ...watch].slice(0, MAX_TOTAL_LINES).map((l) => fitWidth(l, width));
}

/** `PRs: 1 fail · 1 run · 2 ok · watch 3`: the one line of `/foreman prs` collapsed. */
export function collapsedLine(views: PrView[], shared: PrShared | null): string {
  const open = views.filter((v) => v.state === "open");
  const n = (dot: string) => open.filter((v) => v.dot === dot).length;
  const watch = shared ? shared.review.length + shared.failing.length : 0;
  const parts = [n("fail") ? `${n("fail")} fail` : "", n("run") ? `${n("run")} run` : "", n("ok") ? `${n("ok")} ok` : "", watch ? `watch ${watch}` : ""].filter(Boolean);
  return `PRs: ${parts.join(" · ") || "none"}`;
}

/** `/foreman prs list`: host, repository, URL and state of every view, then the shared snapshot (review, failing, touched). */
export function prsListText(views: PrView[], shared: PrShared | null): string {
  const lines = [`PRs (${views.length}):`];
  for (const v of orderViews(views)) {
    const k = v.key;
    lines.push(`  ${clean(k.host, 100)} ${clean(k.repo, 140)}#${k.n} · ${v.state}${v.state === "open" ? ` · ${v.dot}` : ""} · ${clean(v.title, 80)} · ${clean(v.url, 300) || "no url"}`);
  }
  if (!views.length) lines.push("  none tracked");
  if (!shared) {
    lines.push("shared watch: no snapshot");
    return lines.join("\n");
  }
  lines.push(`shared watch: ${shared.review.length} need review · ${shared.failing.length} failing · ${shared.touched.length} touched${shared.degraded ? " · degraded" : ""}`);
  const item = (i: { host: string; repo: string; n: number; url: string | null; title?: string }) => `    ${clean(i.host, 100)} ${clean(i.repo, 140)}#${i.n}${i.title ? ` · ${clean(i.title, 80)}` : ""} · ${clean(i.url, 300) || "no url"}`;
  for (const [name, list] of [["review", shared.review], ["failing", shared.failing], ["touched", shared.touched]] as const) {
    if (!list.length) continue;
    lines.push(`  ${name}:`);
    for (const i of list.slice(0, 10)) lines.push(item(i as SharedItem));
    if (list.length > 10) lines.push(`    +${list.length - 10} more`);
  }
  return lines.join("\n");
}

export interface PrWidgetCtx {
  mode?: string;
  ui: { setWidget(key: string, content: ((tui: { requestRender(): void }, theme?: FooterTheme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void };
}
export interface PrWidgetOpts {
  /** `widget.prs`. */
  enabled: boolean;
  /** `widget.prLinks`. */
  links: boolean;
  symbols?: unknown;
}
export interface PrWidgetDeps {
  views(): PrView[];
  /** The parsed shared snapshot, null when absent (read on the PrDots tick by the watch). */
  shared(): PrShared | null;
  current(): { host: string; repo: string } | null;
  now?(): number;
  timers?: Timers;
}

interface Data {
  views: PrView[];
  shared: PrShared | null;
  stale: boolean;
}

const sigOf = (d: Data, mode: PrsMode, links: boolean, symbols: unknown): string =>
  JSON.stringify([
    mode,
    links,
    typeof symbols === "string" ? symbols : "",
    d.stale,
    d.views.map((v) => [keyString(v.key), v.label, v.url, v.title, v.state, v.draft, v.reviewDecision, v.dot, v.checks]),
    d.shared && [d.shared.at, d.shared.degraded, d.shared.review.map((i) => [i.host, i.repo, i.n, i.title, i.url]), d.shared.failing.map((i) => [i.host, i.repo, i.n, i.title, i.url])],
  ]);

/** Pi component: lines are laid out in render(width) from the data held at the last applied change. */
class PrRows {
  private readonly owner: PrWidget;
  constructor(owner: PrWidget) {
    this.owner = owner;
  }
  render(width: number): string[] {
    return this.owner.linesFor(width);
  }
  invalidate(): void {
    // stateless: render reads the owner's data
  }
  dispose(): void {
    this.owner.unmounted();
  }
}

export class PrWidget {
  private readonly deps: PrWidgetDeps;
  private readonly timers: Timers;
  private ctx: PrWidgetCtx | null = null;
  private opts: PrWidgetOpts | null = null;
  private mode: PrsMode = "auto";
  private last = -Infinity;
  private shown = "";
  private data: Data = { views: [], shared: null, stale: false };
  private tui: { requestRender(): void } | null = null;
  private theme: FooterTheme | undefined;
  private mounted = false;
  private timer: unknown = null;
  private expiry: unknown = null;
  private disposed = false;

  constructor(deps: PrWidgetDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The text of `/foreman prs list`. */
  listText(): string {
    return prsListText(this.deps.views(), this.deps.shared());
  }

  currentMode(): PrsMode {
    return this.mode;
  }

  /** auto -> collapsed -> hidden -> auto for this session. */
  cycle(): PrsMode {
    this.mode = this.mode === "auto" ? "collapsed" : this.mode === "collapsed" ? "hidden" : "auto";
    this.refresh(true);
    return this.mode;
  }

  /** Render now or, within a second of the last render, once at the end of that second. Never throws. */
  request(ctx: PrWidgetCtx, opts: PrWidgetOpts): void {
    this.ctx = ctx;
    this.opts = opts;
    this.refresh();
  }

  /** Re-render with the last context; no-op before the first request. */
  refresh(immediate = false): void {
    if (this.disposed || !this.ctx || !this.opts) return;
    if (!this.opts.enabled || this.ctx.mode !== "tui") return this.remove();
    const wait = this.last + RENDER_GAP_MS - this.now();
    if (immediate || wait <= 0) return this.apply();
    if (this.timer) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.apply();
    }, wait);
  }

  private remove(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    this.timers.clear(this.expiry);
    this.expiry = null;
    this.shown = "";
    if (!this.mounted || !this.ctx) return;
    this.mounted = false;
    this.tui = null;
    try {
      this.ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "aboveEditor" });
    } catch {
      // the widget is cosmetic
    }
  }

  private apply(): void {
    this.last = this.now();
    try {
      if (!this.ctx || !this.opts) return;
      const views = this.deps.views();
      const shared = this.deps.shared();
      const stale = !!shared && (shared.degraded || this.now() - shared.at > STALE_INTERVALS * Math.max(1, shared.intervalSeconds) * 1000);
      this.data = { views, shared, stale };
      this.armExpiry(views);
      const empty = !views.length && !(shared && shared.review.length + shared.failing.length > 0);
      if (this.mode === "hidden" || empty) return this.remove();
      const sig = sigOf(this.data, this.mode, this.opts.links, this.opts.symbols);
      if (sig === this.shown && this.mounted) return;
      this.shown = sig;
      if (this.mounted) {
        this.tui?.requestRender();
        return;
      }
      this.mounted = true;
      this.ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        this.theme = theme;
        return new PrRows(this);
      }, { placement: "aboveEditor" });
    } catch {
      // the widget is cosmetic
    }
  }

  /** A merged or closed view drops after its minute: refresh once it is due. */
  private armExpiry(views: PrView[]): void {
    this.timers.clear(this.expiry);
    this.expiry = null;
    const due = views.flatMap((v) => (v.closedAt !== undefined ? [v.closedAt] : []));
    if (!due.length) return;
    const ms = Math.max(RENDER_GAP_MS, Math.min(...due) + 60_000 - this.now() + 50);
    this.expiry = this.timers.set(() => {
      this.expiry = null;
      this.refresh(true);
    }, ms);
  }

  /** The lines Pi draws at `width` (called from the component's render). */
  linesFor(width: number): string[] {
    if (!this.opts) return [];
    if (this.mode === "collapsed") return [fitWidth((this.theme ?? PLAIN).fg("dim", collapsedLine(this.data.views, this.data.shared)), width)];
    return renderPrWidget(this.data.views, this.data.shared, width, { links: this.opts.links, theme: this.theme, symbols: symbolSet(this.opts.symbols), now: this.now(), current: this.deps.current() });
  }

  /** Pi dropped the component. */
  unmounted(): void {
    this.mounted = false;
    this.tui = null;
    this.shown = "";
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
    this.timers.clear(this.expiry);
    this.expiry = null;
    this.ctx = null;
  }
}
