// pi-foreman-plan mod for herdr-app: the plan of the foreman that owns the tab, and the plans of its child sessions, rendered
// natively in the panel. Reads radar from shared("pi-foreman.radar") (published by the pi-foreman Agents mod), the two JSON files
// of the session on screen and its markdown documents; writes nothing but the clearing of the sidebar's pending open request
// (shared "pi-foreman.show-pending"); the only process it starts is the platform opener, for https links.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState } from "gpui-base";
import { readTextFile, writeTextFile, watchFolder, theme, shared, setShared, agents, panes, terminals, focused, exec, window, run, layout, appHome, settings } from "herdr";
import {
  buildTree, joinAgents, allSessions, childPlans, planHint, noteHint, anchorAgent, joinPath, dirOf, parseMeta, isReadablePath,
  compareTarget, markBlocks, diffHunks, sanitize, isSafeHttpsUrl, openerArgv, fmtSince, isLight,
  fenceInfo, validateSvg, svgSize, cachePath, findPanelBlock,
} from "./model.js";

const TICK_MS = 1000;
const OPEN_TIMEOUT_MS = 10000; // exec `timeout` of the URL opener
const POLL_MS = 5000;
const MOD = "pi-foreman-plan";
// the ids of layouts/foreman.json, used when the shown layout cannot be searched
const DEFAULT_IDS = { stack: "panel-body", block: "plan", show: "panel" };
const CODE_LINE_PX = 18;
const CODE_MAX_LINES = 30;
const DOC_CACHE_MAX = 16;

const guard = (f, fallback) => { try { return f(); } catch { return fallback; } };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// FNV-1a of a string: the content half of the parsed-document cache key.
const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
const topicOf = (path) => /^plan-(.+)\.md$/i.exec(String(path ?? "").split(/[\\/]/).pop())?.[1] ?? "";

export default class PlanPanel extends View {
  init(_props, cx) {
    this.recs = new Map(); // `${machine}|${dir}` -> what was read of one session's show dir
    this.watched = new Set(); // local dirs with a running watch loop
    this.tab = "plan";
    this.diff = false;
    this.rootKey = null;
    this.anchorAddr = null;
    this.pinSeen = null; // null until the first sync: a pin that predates this copy is stale
    this.pin = null; // {key, anchorKey}: set by a sidebar click until the tab's foreman changes
    this.lastTerm = null;
    this.loadedFor = null;
    this.loadedAt = 0;
    this.dirty = false;
    this.busy = false;
    this.again = false;
    this.cur = { empty: "Waiting for foreman radar" };
    this.held = null; // what the body shows: {tabId, key, rec}; kept while the selected tab is still being read
    this.titles = new Map(); // planKey -> last Note title seen, so the Note tab label does not change while a note is read
    this.prefetching = false;
    this.noteSeen = new Map(); // root session key -> last note version seen on the radar
    this.noTimeout = false; // true once this copy's exec rejected the `timeout` option itself (Herdr app 0.1.13)
    this.parsed = new Map(); // `${path}|${hash of text}|${hash of base}|${fences}` -> {doc, hunks}: a document is parsed once per content
    this.diagOk = new Map(); // app-home relative cache path -> true once written and checked
    this.linksOn = guard(() => typeof TextView.markdown("probe", "").on_link_click === "function", false);
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

    // A sidebar click pins a session and a document until the tab's foreman changes. Herdr persists the value, so one already
    // present at the first sync is stale: its `n` is recorded as seen, never applied.
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
    if (req) this.pin = { key: req.key, kind: req.kind === "note" ? "note" : "plan", anchorKey: own?.node.key ?? null, fresh: true };
    if (pending !== null && pending !== undefined) guard(() => setShared("pi-foreman.show-pending", null), null);
    if (this.pin && this.pin.anchorKey !== (own?.node.key ?? null)) this.pin = null;
    const pinned = this.pin ? this.find(trees, this.pin.key) : null;

    let root = own;
    if (pinned && !(own && allSessions([own.node]).includes(pinned.node))) root = { node: pinned.node, machine: pinned.machine };
    if (!root) { this.cur = { empty: "No agent session in this tab" }; this.rootKey = null; return; }
    if (root.node.key !== this.rootKey) { this.rootKey = root.node.key; this.tab = "plan"; this.lastTerm = null; }

    const tabs = [{ id: "plan", label: "Plan", node: root.node }];
    if (noteHint(root.node) !== null) tabs.push({ id: "note", label: "Note", node: root.node });
    for (const c of childPlans(root.node)) tabs.push({ id: `c:${c.node.key}`, label: c.label, node: c.node });

    if (this.pin?.fresh && pinned) {
      this.pin.fresh = false;
      const hit = tabs.find((t) => t.id.startsWith("c:") && t.node === pinned.node);
      this.tab = hit ? hit.id : pinned.node === root.node && this.pin.kind === "note" && noteHint(root.node) !== null ? "note" : "plan";
    }
    // Focus on a floating child window of this foreman selects that child's tab, once per focus change.
    const term = focus.pane ? null : focus.terminal ?? focus.agent ?? null;
    if (term && term !== this.lastTerm && term !== anchor) {
      const hit = this.nodeOf(trees, term, pidOf(term));
      const tab = hit && tabs.find((t) => t.id.startsWith("c:") && t.node.key === hit.node.key);
      if (tab) this.tab = tab.id;
    }
    this.lastTerm = term;
    if (!tabs.some((t) => t.id === this.tab)) this.tab = "plan";

    const tab = tabs.find((t) => t.id === this.tab);
    const show = tab.node.show;
    const machine = root.machine === "local" ? null : root.machine;
    this.cur = { tabs, tab, machine, raw: root.machine, planKey: root.node.show ? `${root.machine}|${root.node.show.dir}` : null, show, key: show ? `${root.machine}|${show.dir}` : null, root: root.node };
  }

  find(trees, key) {
    for (const t of trees) {
      const n = allSessions(t.tops).find((x) => x.key === key);
      if (n) return { node: n, machine: t.key };
    }
    return null;
  }

  // ---- reading --------------------------------------------------------------------------------------------------

  async read(path, machine) {
    try { return await readTextFile(path, { on: machine }); } catch { return null; }
  }

  tick(cx) {
    const before = this.cur?.key;
    this.sync();
    this.noteWatch(cx);
    if (this.cur?.key !== before) cx.notify();
    if (this.cur?.key !== this.loadedFor || Date.now() - this.loadedAt >= POLL_MS) this.reload(cx);
  }

  // A note newer than the one seen before on the tab's foreman opens the panel on the Note tab. The first sight of a session only
  // records its version, so starting the app does not pop the panel.
  noteWatch(cx) {
    const root = this.cur?.root;
    const v = root ? noteHint(root) : null;
    if (!root || v === null) return;
    const seen = this.noteSeen.get(root.key);
    this.noteSeen.set(root.key, v);
    if (seen === undefined || v <= seen) return;
    this.tab = "note";
    this.sync();
    this.openPanel();
    this.reload(cx);
    cx.notify();
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

  watch(dir, plan, cx) {
    if (this.watched.has(dir)) return;
    this.watched.add(dir);
    cx.spawn(async (cx) => {
      for (;;) {
        try { await watchFolder(dir); } catch { break; }
        if (plan) this.dirty = true;
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
    const force = this.dirty;
    this.dirty = false;
    cx.spawn(async (cx) => {
      const changed = await this.load(cur, force, cx);
      this.busy = false;
      if (changed) cx.notify();
      if (this.again) { this.again = false; this.reload(cx); return; }
      this.prefetch(cx);
    });
  }

  // Reads one session's documents into its record; the record is ready after its first read, whatever that found.
  async load(job, force, cx) {
    let changed = false;
    const run = this.refresh(job, force, cx);
    const rec = this.recs.get(job.key); // refresh has created it and taken its seq before its first await
    const seq = rec?.seq;
    try { changed = await run; } catch { /* keep what was read */ }
    // a read superseded by a newer one of the same session found nothing final: the newer read marks the record ready
    if (rec && rec.seq === seq && !rec.ready) { rec.ready = true; changed = true; }
    return changed;
  }

  // The other tabs' sessions are read once, after the first paint, so a switch to one of them finds its record ready.
  prefetch(cx) {
    const cur = this.cur;
    if (!cur?.tabs || this.prefetching) return;
    const jobs = cur.tabs.filter((x) => x.node.show)
      .map((x) => ({ key: `${cur.raw}|${x.node.show.dir}`, machine: cur.machine, show: x.node.show }))
      .filter((j) => j.key !== cur.key && !this.recs.get(j.key)?.ready);
    if (!jobs.length) return;
    this.prefetching = true;
    cx.spawn(async (cx) => {
      for (const j of jobs) if (!this.recs.get(j.key)?.ready && await this.load(j, false, cx)) cx.notify();
      this.prefetching = false;
    });
  }

  // Re-reads the two JSON files; the documents only when the JSON bytes changed or the plan folder's watch fired.
  async refresh(cur, force, cx) {
    const dir = cur.show.dir;
    const rec = this.recs.get(cur.key) ?? { rev: 0, planJson: undefined, noteJson: undefined };
    this.recs.set(cur.key, rec);
    // a read that ends after a newer read of this session started commits nothing: the stale result is dropped
    const seq = rec.seq = (rec.seq ?? 0) + 1;
    if (!cur.machine) this.watch(dir, false, cx);
    const [pj, nj] = await Promise.all([this.read(joinPath(dir, "plan.json"), cur.machine), this.read(joinPath(dir, "note.json"), cur.machine)]);
    if (rec.seq !== seq) return false;
    let changed = false;
    if (force || pj !== rec.planJson) {
      const meta = pj === null ? null : parseMeta(pj);
      const docPath = meta && isReadablePath(meta.path) ? meta.path : null;
      const target = meta ? compareTarget(meta) : null;
      const text = docPath ? await this.read(docPath, cur.machine) : null;
      const base = text === null || !target ? null
        : await this.read(joinPath(dir, target === "ruled" ? "plan.ruled.md" : "plan.prev.md"), cur.machine);
      if (rec.seq !== seq) return false;
      if (docPath && !cur.machine) this.watch(dirOf(docPath), true, cx);
      const next = { meta, path: docPath, text, base, target };
      if (pj !== rec.planJson || JSON.stringify(next) !== JSON.stringify(rec.planDoc)) {
        rec.planJson = pj;
        rec.planDoc = next;
        const parsed = text === null ? null : this.parse(docPath, text, base, meta);
        rec.plan = parsed?.doc ?? null;
        rec.hunks = parsed?.hunks ?? null;
        rec.rev++;
        await this.decorateLater(parsed, meta, dir, cur.machine, cx);
        rec.rev++;
        changed = true;
      }
    }
    if (force || nj !== rec.noteJson) {
      const meta = nj === null ? null : parseMeta(nj);
      const text = meta ? await this.read(joinPath(dir, "note.md"), cur.machine) : null;
      if (rec.seq !== seq) return false;
      if (nj !== rec.noteJson || text !== rec.noteText) {
        rec.noteJson = nj;
        rec.noteMeta = meta;
        rec.noteText = text;
        const parsed = text === null ? null : this.parse(joinPath(dir, "note.md"), text, null, meta);
        rec.note = parsed?.doc ?? null;
        rec.rev++;
        await this.decorateLater(parsed, meta, dir, cur.machine, cx);
        rec.rev++;
        changed = true;
      }
    }
    return changed;
  }

  // A document whose fences still need decorating is painted first as plain markdown (one notify), the editors and diagrams
  // follow when decorate is done (the caller's notify).
  async decorateLater(parsed, meta, dir, machine, cx) {
    if (!parsed || parsed.decorated) return;
    if (parsed.doc.blocks.some((b) => b.kind === "fence")) cx.notify();
    await this.decorate(parsed.doc, meta, dir, machine);
    parsed.decorated = true;
  }

  // The parsed document (blocks, diff hunks) of one path and content, kept per copy: a switch back to unchanged content, or a
  // version bump over the same text, skips the parse. The fences' picture list is part of the key, since it decides the decoration.
  parse(path, text, base, meta) {
    const key = `${path}|${hashOf(text)}|${base === null ? "" : hashOf(base)}|${(meta?.fences ?? []).join(",")}`;
    const hit = this.parsed.get(key);
    if (hit) { this.parsed.delete(key); this.parsed.set(key, hit); return hit; }
    const made = { doc: markBlocks(text, base), hunks: diffHunks(text, base), decorated: false };
    this.parsed.set(key, made);
    if (this.parsed.size > DOC_CACHE_MAX) this.parsed.delete(this.parsed.keys().next().value);
    return made;
  }

  // Fence blocks get what drawing needs, made here because host state objects belong in tasks, never in render: a code fence a
  // read-only highlighted Editor; a mermaid fence whose hash the harness listed a picture (the checked SVG copied under the app
  // home), or a `mermaid` code block when there is none.
  async decorate(doc, meta, dir, machine) {
    if (!doc) return;
    const t = guard(() => theme(), {});
    const font = guard(() => settings().font_family, undefined);
    const syntax = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 };
    for (const b of doc.blocks) {
      if (b.kind !== "fence") continue;
      const f = fenceInfo(doc.lines, b);
      b.fence = f;
      const entry = f.sha && meta?.fences.includes(f.sha) ? meta.diagrams.find((d) => d.sha === f.sha) : null;
      if (entry) b.diagram = await this.cacheDiagram(entry, dir, machine);
      if (b.diagram) continue;
      const language = f.mermaid ? "mermaid" : f.lang;
      b.lines = Math.min(CODE_MAX_LINES, Math.max(1, f.text.split("\n").length));
      b.editor = guard(() => EditorState.new({ ...(language ? { language } : {}), value: f.text, readonly: true, line_numbers: false, folding: false,
        font_family: font, font_size: 12, syntax }), null);
    }
  }

  // Copies the dark and light SVG of a diagram into mods/pi-foreman-plan/cache/ of the app home (named by sha and theme only) after
  // the allow-list check; `{dark, light, w, h}` with app-home relative paths, or null when anything is wrong with it.
  async cacheDiagram(entry, dir, machine) {
    const out = {};
    for (const th of ["dark", "light"]) {
      const rel = cachePath(entry.sha, th);
      if (!rel) return null;
      const text = await this.read(joinPath(dir, entry[th]), machine);
      if (text === null || validateSvg(text) !== null) return null;
      if (!this.diagOk.get(rel)) {
        const abs = joinPath(guard(() => appHome(), ""), rel);
        if (!abs.startsWith("/") && !/^[A-Za-z]:/.test(abs)) return null;
        const have = await this.read(abs, null);
        if (have !== text) {
          try { await writeTextFile(abs, text, have); } catch { return null; }
        }
        this.diagOk.set(rel, true);
      }
      out[th] = rel;
      if (th === "dark") Object.assign(out, svgSize(text) ?? { w: 600, h: 400 });
    }
    return out;
  }

  // ---- links ----------------------------------------------------------------------------------------------------

  openUrl(url, cx) {
    if (!isSafeHttpsUrl(url)) return;
    const p = guard(() => window().platform, "");
    const argv = openerArgv(p === "macos" ? "darwin" : p === "windows" ? "win32" : "linux", url);
    if (!argv) return;
    cx.spawn(async () => { try { await this.execT(argv[0], argv.slice(1), {}, OPEN_TIMEOUT_MS); } catch { /* no opener: nothing to do */ } });
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

  md(id, text) {
    const el = TextView.markdown(id, this.linksOn ? sanitize(text) : sanitize(text, { links: false })).selectable(true);
    return this.linksOn ? el.on_link_click((url, cx) => this.openUrl(url, cx)) : el;
  }

  // The body of one block: a picture, a highlighted code block, or the markdown of the text.
  body(t, b, i, rec, tabId) {
    if (b.diagram) {
      const rel = b.diagram[isLight(t.background) ? "light" : "dark"];
      return svg(rel).w_full().max_w(b.diagram.w).h(Math.min(b.diagram.h, 1200)).flex_none();
    }
    if (b.editor) return Editor.new(b.editor).w_full().h(b.lines * CODE_LINE_PX + 10).flex_none().rounded(4);
    return this.md(`b-${rec.rev}-${tabId}-${i}`, b.text);
  }

  block(t, b, i, rec, tabId) {
    const el = this.body(t, b, i, rec, tabId);
    const card = v_flex().w_full().gap(4).px(10).py(6).rounded(6);
    if (b.mark === "new") card.bg(t.ansi2 + "18").border_l(3).border_color(t.ansi2).child(div().text_size(10).text_color(t.ansi2).child("NEW"));
    else if (b.mark === "changed") card.bg(t.ansi3 + "18").border_l(3).border_color(t.ansi3).child(div().text_size(10).text_color(t.ansi3).child("CHANGED"));
    return card.child(el);
  }

  diffView(t, hunks, note) {
    if (hunks === null || hunks === undefined) return div().p(6).text_size(12).text_color(t.dim).child(note || "No earlier version to compare");
    if (hunks.length === 0) return div().p(6).text_size(12).text_color(t.dim).child("No changes against the compared version");
    return v_flex().w_full().font_family("JetBrains Mono").text_size(11).children(hunks.flatMap((h, n) => [
      div().id(`h-${n}`).w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(`@@ ${h.heading || "(top)"} @@`),
      ...h.rows.map((r) => h_flex().w_full().h(20).flex_none().gap(10).px(12)
        .when(r.k === "+", (e) => e.bg(t.ansi2 + "18")).when(r.k === "-", (e) => e.bg(t.ansi1 + "18"))
        .child(div().w(10).text_color(t.dim).child(r.k)).child(div().flex_1().min_w(0).truncate().child(r.s))),
    ]));
  }

  message(t, text) {
    return div().p(14).text_size(12).text_color(t.dim).child(text);
  }

  render(cx) {
    const t = theme();
    // A sidebar click (shared state) re-renders this mod at once: follow it here instead of waiting for the 1 s timer, and
    // start reading a session not read yet. Until that read is done the frame keeps what it showed (see `shown`).
    this.sync();
    if (this.cur?.key && this.cur.key !== this.loadedFor) this.reload(cx);
    const cur = this.cur ?? { empty: "Waiting for foreman radar" };
    const frame = (...kids) => v_flex().id("plan-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).children(kids);
    if (cur.empty) return frame(this.message(t, cur.empty));
    // What the frame shows is the selected tab's document once it is read. Until then it keeps the document shown before, so a
    // switch neither blanks the body nor moves the tab row or the header. The held document is released at once when the target
    // has no document (nothing to read): then the real state shows, empty message included. "Loading" shows only when nothing
    // was shown yet.
    const want = cur.key ? this.recs.get(cur.key) : null;
    if (want?.ready || !this.held?.key || !cur.key) this.held = { tabId: cur.tab.id, key: cur.key, rec: want ?? null };
    const shown = this.held;
    const rec = shown.rec;
    const planRec = cur.planKey ? this.recs.get(cur.planKey) : null;
    if (planRec?.noteMeta?.title) this.titles.set(cur.planKey, planRec.noteMeta.title);
    const noteTitle = cur.planKey ? this.titles.get(cur.planKey) : undefined;
    const isNote = shown.tabId === "note";
    const tabBtn = (id, label, on, fn) => div().id(id).px(8).py(2).rounded(5).cursor_pointer().text_size(11).truncate().max_w(160)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(fn).child(label);
    const tabs = cur.tabs.length > 1 ? h_flex().flex_none().flex_wrap().px(10).py(4).gap(4).border_b(1).border_color(t.border)
      .children(cur.tabs.map((x) => tabBtn(`tab-${x.id}`, x.id === "note" && noteTitle ? `Note: ${noteTitle}` : x.label, x.id === this.tab, (_e, cx) => { this.tab = x.id; cx.notify(); }))) : null;

    const meta = isNote ? rec?.noteMeta : rec?.planDoc?.meta;
    const doc = isNote ? rec?.note : rec?.plan;
    const adds = !isNote && doc ? doc.adds : 0;
    const topic = isNote ? "" : topicOf(rec?.planDoc?.path) || (shown.tabId.startsWith("c:") ? (cur.tabs.find((x) => x.id === shown.tabId)?.label ?? "") : "");
    const head = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().truncate().min_w(0).child(isNote ? "Note" : "Plan"))
      .when(Boolean(topic), (e) => e.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(topic)))
      .when(adds > 0, (e) => e.child(div().flex_none().px(5).py(1).rounded(4).bg(t.ansi2 + "30").text_size(10).text_color(t.ansi2).child(`${adds} ${adds === 1 ? "addition" : "additions"}`)))
      .child(div().flex_1())
      .when(!isNote, (e) => e.child(tabBtn("t-r", "Rendered", !this.diff, (_e, cx) => { this.diff = false; cx.notify(); }))
        .child(tabBtn("t-d", "Diff", this.diff, (_e, cx) => { this.diff = true; cx.notify(); })))
      .when(Boolean(meta?.v), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`v${meta.v}`)))
      .when(Boolean(meta?.at), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(fmtSince(Date.now() - meta.at))));

    let body;
    if (!doc && shown.key && !rec?.ready) body = this.message(t, isNote ? "Loading note…" : "Loading plan…");
    else if (!doc) body = this.message(t, isNote ? "No note published by this session" : "No plan published by this session");
    else if (this.diff && !isNote) body = this.diffView(t, rec.hunks, doc.note);
    else body = v_flex().w_full().gap(2)
      .when(Boolean(doc.note), (e) => e.child(div().px(10).py(2).text_size(11).text_color(t.dim).child(doc.note)))
      .children(doc.blocks.map((b, i) => this.block(t, b, i, rec, shown.tabId)));
    return frame(
      head,
      ...(tabs ? [tabs] : []),
      div().id("plan-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).child(body),
    );
  }
}
