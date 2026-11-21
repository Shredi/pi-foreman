// pi-foreman-plan mod for herdr-app: the pages and milestones of the foreman that owns the tab, and of its child sessions, as a list in
// the panel. Reads radar from shared("pi-foreman.radar") (published by the pi-foreman Agents mod) and, per session on screen,
// <show dir>/pages/pages.json (the index the foreman writes). A page opens in the system browser through a copy this mod writes
// into one of eight fixed slots under its own cache folder; writes nothing else but the clearing of the sidebar's pending open request
// (shared "pi-foreman.show-pending"); the processes it starts are the platform opener, for https links, for those page copies and for the served
// page URL of a local session, and `foreman pages url <page file>` (the binary of the `foreman` prop), which prints that URL (docs/pages.md).

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readTextFile, writeTextFile, watchFolder, theme, shared, setShared, agents, panes, terminals, focused, exec, window, run, layout, appHome, notify, props } from "herdr";
import {
  buildTree, joinAgents, allSessions, childPlans, tabDot, pageUnseen, pageStamp, chipText, parsePages, newPage, anchorAgent, joinPath,
  isSafeHttpsUrl, openerArgv, pageOpenerArgv, pageUrlArgv, radarBinary, slotPath, dirFileUrl, rewriteRelative, openFailure, fmtSince, findPanelBlock, PAGE_FILE, MAX_PAGE_CHARS, SLOTS,
} from "./model.js";

const TICK_MS = 1000;
const OPEN_TIMEOUT_MS = 10000; // exec `timeout` of the platform opener
const URL_TIMEOUT_MS = 5000; // exec `timeout` of `foreman pages url`
const POLL_MS = 5000;
const FAILED = Symbol("read failed");
const MOD = "pi-foreman-plan";
const PAGES_DIR = "pages";
// the ids of layouts/foreman.json, used when the shown layout cannot be searched
const DEFAULT_IDS = { stack: "panel-body", block: "plan", show: "panel" };

const guard = (f, fallback) => { try { return f(); } catch { return fallback; } };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const osOf = () => { const p = guard(() => window().platform, ""); return p === "macos" ? "darwin" : p === "windows" ? "win32" : "linux"; };

export default class PlanPanel extends View {
  init(p, cx) {
    this.foremanProp = guard(() => props() ?? p ?? {}, {}).foreman;
    this.recs = new Map(); // `${machine}|${dir}` -> what was read of one session's pages.json
    this.watched = new Set(); // local dirs with a running watch loop
    this.tab = "foreman";
    this.rootKey = null;
    this.anchorAddr = null;
    this.pinSeen = null; // null until the first sync: a pin that predates this copy is stale
    this.pin = null; // {anchorKey, fresh, key}: set by a sidebar click until the tab's foreman changes
    this.lastTerm = null;
    this.loadedFor = null;
    this.loadedAt = 0;
    this.minute = 0; // the minute of the last paint, so the ages move
    this.busy = false;
    this.again = false;
    this.cur = { empty: "Waiting for foreman radar" };
    this.seen = new Map(); // `${session key}|${page id}` -> the stamp of that page when it was last opened (the ● dot compares with it)
    this.prefetching = false;
    this.slot = 0; // the next page-copy slot, round robin
    this.noTimeout = false; // true once this copy's exec rejected the `timeout` option itself (Herdr app 0.1.13)
    this.sync();
    this.reload(cx);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  // ---- what is on screen ----------------------------------------------------------------------------------------

  // The trees of the published radar, one per machine key.
  trees() {
    const doc = guard(() => shared("pi-foreman.radar"), null);
    if (!isObj(doc) || !isObj(doc.machines)) return null;
    return Object.entries(doc.machines).map(([key, nodes]) => ({ key, tops: buildTree(nodes) }));
  }

  // The session node of terminal `address`: the first machine whose radar joins it.
  nodeOf(trees, address, pid = null) {
    for (const t of trees) {
      const hit = joinAgents([{ address, pid }], t.tops, t.key === "local" ? null : t.key).get(address);
      if (hit) return { node: hit, machine: t.key };
    }
    return null;
  }

  // Decides the session on screen. The panel belongs to the tab: the agent terminal that owns the tab's pane, never the one
  // with keyboard focus. Focusing a floating child window at most selects that child's tab.
  sync() {
    const trees = this.trees();
    if (!trees) { this.cur = { empty: "Waiting for foreman radar" }; return; }
    const focus = guard(() => focused(), null);
    if (!focus) { this.cur = { empty: "No herdr-app session focused" }; return; }
    const list = guard(() => agents(), []);
    const all = guard(() => terminals(), []);
    const pidOf = (addr) => all.find((x) => x?.address === addr)?.foreground?.pid ?? null;
    const anchor = anchorAgent(list, guard(() => panes(), null), focus, this.anchorAddr);
    this.anchorAddr = anchor;
    const own = anchor ? this.nodeOf(trees, anchor, pidOf(anchor)) : null;

    // A sidebar click pins a session until the tab's foreman changes. Herdr persists the value, so one already present at the
    // first sync is stale: its `n` is recorded as seen, never applied.
    // While the panel is hidden this block is not mounted and never sees the change; the sidebar also leaves the request in
    // "pi-foreman.show-pending", which the first sync of a freshly mounted copy applies, once. Any copy clears it after reading it.
    const pin = guard(() => shared("pi-foreman.show"), null);
    const pending = guard(() => shared("pi-foreman.show-pending"), null);
    const valid = (r) => isObj(r) && Number.isInteger(r.n) && typeof r.key === "string";
    let req = null;
    if (this.pinSeen === null) {
      this.pinSeen = isObj(pin) && Number.isInteger(pin.n) ? pin.n : 0;
      if (valid(pending)) { req = pending; this.pinSeen = Math.max(this.pinSeen, pending.n); }
    } else if (isObj(pin) && Number.isInteger(pin.n) && pin.n !== this.pinSeen) {
      this.pinSeen = pin.n;
      req = valid(pin) ? pin : null;
      if (!req) this.pin = null;
    }
    if (req) this.pin = { key: req.key, anchorKey: own?.node.key ?? null, fresh: true };
    if (pending !== null && pending !== undefined) guard(() => setShared("pi-foreman.show-pending", null), null);
    if (this.pin && this.pin.anchorKey !== (own?.node.key ?? null)) this.pin = null;
    const pinned = this.pin ? this.find(trees, this.pin.key) : null;

    let root = own;
    if (pinned && !(own && allSessions([own.node]).includes(pinned.node))) root = { node: pinned.node, machine: pinned.machine };
    if (!root) { this.cur = { empty: "No agent session in this tab" }; this.rootKey = null; return; }
    if (root.node.key !== this.rootKey) { this.rootKey = root.node.key; this.tab = "foreman"; this.lastTerm = null; }

    const tabs = [{ id: "foreman", label: "Foreman", node: root.node }];
    for (const c of childPlans(root.node)) tabs.push({ id: `c:${c.node.key}`, label: c.label, node: c.node });

    if (this.pin?.fresh && pinned) {
      this.pin.fresh = false;
      this.tab = tabs.find((t) => t.id.startsWith("c:") && t.node === pinned.node)?.id ?? "foreman";
    }
    // Focus on a floating child window of this foreman selects that child's tab, once per focus change.
    const term = focus.pane ? null : focus.terminal ?? focus.agent ?? null;
    if (term && term !== this.lastTerm && term !== anchor) {
      const hit = this.nodeOf(trees, term, pidOf(term));
      const tab = hit && tabs.find((t) => t.id.startsWith("c:") && t.node.key === hit.node.key);
      if (tab) this.tab = tab.id;
    }
    this.lastTerm = term;
    if (!tabs.some((t) => t.id === this.tab)) this.tab = "foreman";

    const tab = tabs.find((t) => t.id === this.tab);
    const show = tab.node.show?.dir ? tab.node.show : null;
    const machine = root.machine === "local" ? null : root.machine;
    this.cur = { tabs, tab, machine, raw: root.machine, show, key: show ? `${root.machine}|${show.dir}` : null, root: root.node };
  }

  find(trees, key) {
    for (const t of trees) {
      const n = allSessions(t.tops).find((x) => x.key === key);
      if (n) return { node: n, machine: t.key };
    }
    return null;
  }

  // The key of a tab's session record, null when it has no show folder.
  keyOf(tab) {
    return tab.node.show?.dir ? `${this.cur.raw}|${tab.node.show.dir}` : null;
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  async read(path, machine) {
    try { return await readTextFile(path, { on: machine }); } catch { return null; }
  }

  tick(cx) {
    const before = this.cur?.key;
    this.sync();
    const minute = Math.floor(Date.now() / 60000);
    if (this.cur?.key !== before || minute !== this.minute) { this.minute = minute; cx.notify(); }
    if (this.cur?.key !== this.loadedFor || Date.now() - this.loadedAt >= POLL_MS) this.reload(cx);
  }

  // Selects this mod's block in its stack and shows the (hidden) panel around it. The Agents mod says when the layout has no block.
  openPanel() {
    const tree = guard(() => layout(), null);
    const found = isObj(tree) ? findPanelBlock(tree, MOD) : undefined; // an unreadable layout falls back to the default ids
    if (found === null) return;
    const ids = found ? { stack: found.stack ?? DEFAULT_IDS.stack, block: found.block, show: found.show ?? DEFAULT_IDS.show } : DEFAULT_IDS;
    guard(() => run("layout.select", { stack: ids.stack, child: ids.block }), null);
    guard(() => run("layout.show", { id: ids.show }), null);
  }

  watch(dir, cx) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(dir); } catch { break; }
        this.reload(cx);
      }
      this.watched.delete(dir); // the 5 s timer remains; the next tick tries the watch again
    });
  }

  reload(cx) {
    if (this.busy) { this.again = true; return; }
    const cur = this.cur;
    this.loadedFor = cur?.key ?? null;
    this.loadedAt = Date.now();
    if (!cur?.key) { this.prefetch(cx); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      const changed = await this.load({ key: cur.key, machine: cur.machine, show: cur.show, tabId: cur.tab.id }, cx);
      this.busy = false;
      if (changed) cx.notify();
      if (this.again) { this.again = false; this.reload(cx); return; }
      this.prefetch(cx);
    });
  }

  // Reads one session's index into its record; the record is ready after its first read, whatever that found.
  async load(job, cx) {
    let changed = false;
    const run = this.refresh(job, cx);
    const rec = this.recs.get(job.key); // refresh has created it and taken its seq before its first await
    const seq = rec?.seq;
    try { changed = await run; } catch { /* keep what was read */ }
    // a read superseded by a newer one of the same session found nothing final: the newer read marks the record ready
    if (rec && rec.seq === seq && !rec.ready) { rec.ready = true; changed = true; }
    return changed;
  }

  // The other tabs' sessions are read after the first paint and again on every poll, so a switch finds its record ready and a page
  // that arrives in a child opens the panel.
  prefetch(cx) {
    const cur = this.cur;
    if (!cur?.tabs || this.prefetching) return;
    const jobs = cur.tabs.filter((x) => x.node.show?.dir)
      .map((x) => ({ key: `${cur.raw}|${x.node.show.dir}`, machine: cur.machine, show: x.node.show, tabId: x.id }))
      .filter((j) => j.key !== cur.key);
    if (!jobs.length) return;
    this.prefetching = true;
    cx.spawn(async (cx) => {
      for (const j of jobs) if (await this.load(j, cx)) cx.notify();
      this.prefetching = false;
    });
  }

  // Re-reads the page index of one session. A page that is new since the last read of it (a new id or a higher version of a page) opens the panel
  // on that session's tab; the first read of a session only records what is there, so starting the app does not pop the panel.
  async refresh(job, cx) {
    const dir = job.show.dir;
    const rec = this.recs.get(job.key) ?? { text: undefined, pages: [], events: [], known: null };
    this.recs.set(job.key, rec);
    // a read that ends after a newer read of this session started commits nothing: the stale result is dropped
    const seq = rec.seq = (rec.seq ?? 0) + 1;
    const pages = joinPath(dir, PAGES_DIR);
    if (!job.machine) { this.watch(pages, cx); this.watch(dir, cx); }
    // null is a missing index (the readTextFile contract); a rejection is another failure and is told apart
    const text = await readTextFile(joinPath(pages, "pages.json"), { on: job.machine }).catch(() => FAILED);
    if (rec.seq !== seq) return false;
    if (text === FAILED) return false; // a failed read records nothing: with no known map yet, the next good read only records
    if (text === rec.text) return false;
    const idx = text === null ? null : parsePages(text);
    const prev = rec.known;
    rec.text = text;
    if (!idx && prev) return false; // a failed or unreadable read keeps the pages and what is known of them
    rec.pages = idx?.pages ?? [];
    rec.events = idx?.events ?? [];
    rec.known = new Map(rec.pages.map((p) => [p.id, p.version]));
    if (prev && newPage(prev, rec.pages)) this.arrived(job, cx);
    return true;
  }

  // A new page: select the session's tab and show the panel, when the session is still one of the tabs on screen.
  arrived(job, cx) {
    const tab = this.cur?.tabs?.find((t) => t.id === job.tabId);
    if (!tab || tab.node.show?.dir !== job.show.dir) return;
    this.tab = tab.id;
    this.sync();
    this.openPanel();
    cx.notify();
  }

  // ---- opening --------------------------------------------------------------------------------------------------

  fail(title, body) {
    guard(() => notify({ title, body, level: "error" }));
  }

  // Starts the platform opener with argv (a checked url or one of our page copies) and raises one notice when it does not work.
  async launch(argv, title) {
    try {
      const r = await this.execT(argv[0], argv.slice(1), {}, OPEN_TIMEOUT_MS);
      const bad = openFailure(r);
      if (bad) { this.fail(title, bad); return false; }
      return true;
    } catch (e) { this.fail(title, openFailure(e) || "the opener could not run"); return false; }
  }

  openUrl(url, cx) {
    if (!isSafeHttpsUrl(url)) return;
    const argv = openerArgv(osOf(), url);
    if (!argv) { this.fail("Could not open the link", "no opener for this platform"); return; }
    cx.spawn(() => this.launch(argv, "Could not open the link"));
  }

  // Opens one page of a session: reads it (local or remote, up to 1 MiB), makes relative `src` and `poster` values absolute for a local
  // session, writes the text into the next of eight slot files under the app home and opens only that copy. `p.file` was checked
  // against PAGE_FILE when the index was read; it is checked again before it goes into a path.
  openPage(tab, p, cx) {
    const key = this.keyOf(tab);
    if (!key || !PAGE_FILE.test(p.file)) return;
    const dir = joinPath(tab.node.show.dir, PAGES_DIR);
    const machine = this.cur.machine;
    const title = "Could not open the page";
    cx.spawn(async () => {
      let argv;
      try {
        const text = await this.read(joinPath(dir, p.file), machine);
        if (text === null) { this.fail(title, "the page could not be read"); return; }
        if (text.length > MAX_PAGE_CHARS) { this.fail(title, "the page is larger than 1 MiB"); return; }
        // a local session: the served page, when `foreman pages url` answers an http(s) URL; any other outcome keeps the slot copy below
        const served = machine ? null : await this.servedArgv(joinPath(dir, p.file));
        if (served) {
          if (await this.launch(served, title)) { this.seen.set(`${key}|${p.id}`, pageStamp(p)); cx.notify(); }
          return;
        }
        const base = machine ? null : dirFileUrl(dir);
        const body = base ? rewriteRelative(text, base) : text;
        const home = guard(() => appHome(), "");
        const copy = slotPath(home, this.slot);
        argv = copy ? pageOpenerArgv(osOf(), home, copy) : null;
        if (!argv) { this.fail(title, "no opener for this platform"); return; }
        this.slot = (this.slot + 1) % SLOTS;
        const have = await this.read(copy, null);
        try { await writeTextFile(copy, body, have); } catch { this.fail(title, "the copy could not be written"); return; }
      } catch { this.fail(title, "the page could not be prepared"); return; }
      // seen only once the opener worked: a failed open keeps the dot
      if (await this.launch(argv, title)) { this.seen.set(`${key}|${p.id}`, pageStamp(p)); cx.notify(); }
    });
  }

  // The opener argv of the served URL `foreman pages url <file>` prints, or null (empty answer, error, a non-http answer, no opener).
  async servedArgv(file) {
    try {
      const r = await this.execT(radarBinary(this.foremanProp, null), ["pages", "url", file], {}, URL_TIMEOUT_MS);
      if (!r || (r.code !== undefined && r.code !== 0)) return null;
      return pageUrlArgv(osOf(), String(r.stdout ?? "").trim());
    } catch { return null; }
  }

  // exec with a `timeout`; if the call throws or rejects because of the option itself (an app that predates it), it runs once more
  // without it and this copy stops passing it. Any other rejection goes to the caller.
  async execT(command, args, options, timeout) {
    if (this.noTimeout) return exec(command, args, options);
    try {
      return await exec(command, args, { ...options, timeout });
    } catch (e) {
      // Same logic as optionError in ../pi-foreman/main.js (separate mod folders, no import): only errors about the option itself.
      const text = String(e?.message ?? e);
      if (!(e instanceof TypeError || /timeout must|unknown (option|field|key)|invalid option|unexpected (option|field)/i.test(text))) throw e;
      this.noTimeout = true;
      return exec(command, args, options);
    }
  }

  // ---- drawing --------------------------------------------------------------------------------------------------

  message(t, text) {
    return div().p(14).text_size(12).text_color(t.dim).child(text);
  }

  // One page: the unseen dot, its title, the state chip and its age.
  pageRow(t, tab, p, key, cx) {
    const unseen = pageUnseen(p, (id) => this.seen.get(`${key}|${id}`));
    return h_flex().id(`page-${p.id}`).w_full().flex_none().gap(8).px(10).py(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openPage(tab, p, cx))
      .child(div().flex_none().w(10).text_color(t.ansi4).child(unseen ? "●" : ""))
      .child(div().flex_1().min_w(0).truncate().child(p.title || p.id))
      .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(chipText(p)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(p.at === null ? "" : fmtSince(Date.now() - p.at)));
  }

  // One milestone, newest first; a row with an https link in its text opens it.
  eventRow(t, e, i) {
    const url = /https:\/\/\S+/.exec(e.text)?.[0];
    const row = h_flex().id(`event-${i}`).w_full().flex_none().gap(8).px(10).py(2).text_size(12)
      .child(div().flex_none().w(36).text_size(11).text_color(t.dim).child(e.at === null ? "" : fmtSince(Date.now() - e.at)))
      .child(div().flex_1().min_w(0).child(e.text));
    return isSafeHttpsUrl(url) ? row.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.openUrl(url, cx)) : row;
  }

  render(cx) {
    const t = theme();
    // A sidebar click (shared state) re-renders this mod at once: follow it here instead of waiting for the 1 s timer, and
    // start reading a session not read yet.
    this.sync();
    if (this.cur?.key && this.cur.key !== this.loadedFor) this.reload(cx);
    const cur = this.cur ?? { empty: "Waiting for foreman radar" };
    const frame = (...kids) => v_flex().id("plan-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).children(kids);
    if (cur.empty) return frame(this.message(t, cur.empty));
    const key = cur.key;
    const rec = key ? this.recs.get(key) : null;
    const tabBtn = (id, label, on, fn) => div().id(id).px(8).py(2).rounded(5).cursor_pointer().text_size(11).truncate().max_w(160)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(fn).child(label);
    // a tab that is not on screen gets a dot on its label while one of its pages is unseen
    const dotted = (x) => {
      const k = this.keyOf(x);
      return k !== null && tabDot(this.recs.get(k)?.pages, x.id === cur.tab.id, (id) => this.seen.get(`${k}|${id}`));
    };
    const tabs = cur.tabs.length > 1 ? h_flex().flex_none().flex_wrap().px(10).py(4).gap(4).border_b(1).border_color(t.border)
      .children(cur.tabs.map((x) => tabBtn(`tab-${x.id}`, x.label + (dotted(x) ? " ●" : ""), x.id === cur.tab.id, (_e, cx) => { this.tab = x.id; cx.notify(); }))) : null;
    const head = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().truncate().min_w(0).child("Pages"))
      .when(cur.tab.id !== "foreman", (e) => e.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(cur.tab.label)));

    let body;
    if (!key) body = this.message(t, "No pages published by this session");
    else if (!rec?.ready) body = this.message(t, "Loading pages…");
    else if (!rec.pages.length && !rec.events.length) body = this.message(t, "No pages published by this session");
    else {
      const events = [...rec.events].reverse();
      body = v_flex().w_full().gap(2)
        .children(rec.pages.map((p) => this.pageRow(t, cur.tab, p, key, cx)))
        .when(events.length > 0, (e) => e.child(div().px(10).pt(8).pb(2).text_size(11).text_color(t.dim).child("Milestones"))
          .children(events.map((ev, i) => this.eventRow(t, ev, i))));
    }
    return frame(head, ...(tabs ? [tabs] : []), div().id("plan-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).child(body));
  }
}
