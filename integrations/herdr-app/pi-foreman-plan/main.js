// pi-foreman-plan mod for herdr-app: the plan of the foreman that owns the tab, and the plans of its child sessions, rendered
// natively in the panel. Reads radar from shared("pi-foreman.radar") (published by the pi-foreman Agents mod), the two JSON files
// of the session on screen and its markdown documents; writes nothing; the only process it starts is the platform opener, for
// https links.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { readTextFile, watchFolder, theme, shared, agents, panes, terminals, focused, exec, window } from "herdr";
import {
  buildTree, joinAgents, allSessions, childPlans, planHint, noteHint, anchorAgent, joinPath, dirOf, parseMeta, isReadablePath,
  compareTarget, markBlocks, diffHunks, sanitize, isSafeHttpsUrl, openerArgv, fmtSince,
} from "./model.js";

const TICK_MS = 1000;
const POLL_MS = 5000;

const guard = (f, fallback) => { try { return f(); } catch { return fallback; } };
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const topicOf = (path) => /^plan-(.+)\.md$/i.exec(String(path ?? "").split(/[\\/]/).pop())?.[1] ?? "";

export default class PlanPanel extends View {
  init(_props, cx) {
    this.recs = new Map(); // `${machine}|${dir}` -> what was read of one session's show dir
    this.watched = new Set(); // local dirs with a running watch loop
    this.tab = "plan";
    this.diff = false;
    this.rootKey = null;
    this.anchorAddr = null;
    this.pinSeen = 0;
    this.pin = null; // {key, anchorKey}: set by a sidebar click until the tab's foreman changes
    this.lastTerm = null;
    this.loadedFor = null;
    this.loadedAt = 0;
    this.dirty = false;
    this.busy = false;
    this.again = false;
    this.cur = { empty: "Waiting for foreman radar" };
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

    // A sidebar click pins a session and a document until the tab's foreman changes.
    const pin = guard(() => shared("pi-foreman.show"), null);
    if (isObj(pin) && Number.isInteger(pin.n) && pin.n !== this.pinSeen) {
      this.pinSeen = pin.n;
      this.pin = typeof pin.key === "string" ? { key: pin.key, kind: pin.kind === "note" ? "note" : "plan", anchorKey: own?.node.key ?? null, fresh: true } : null;
    }
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
    this.cur = { tabs, tab, machine, show, key: show ? `${root.machine}|${show.dir}` : null, root: root.node };
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
    if (this.cur?.key !== before) cx.notify();
    if (this.cur?.key !== this.loadedFor || Date.now() - this.loadedAt >= POLL_MS) this.reload(cx);
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
    if (!cur?.key) return;
    this.busy = true;
    const force = this.dirty;
    this.dirty = false;
    cx.spawn(async (cx) => {
      let changed = false;
      try { changed = await this.refresh(cur, force, cx); } catch { /* keep what was read */ }
      this.busy = false;
      if (changed) cx.notify();
      if (this.again) { this.again = false; this.reload(cx); }
    });
  }

  // Re-reads the two JSON files; the documents only when the JSON bytes changed or the plan folder's watch fired.
  async refresh(cur, force, cx) {
    const dir = cur.show.dir;
    const rec = this.recs.get(cur.key) ?? { rev: 0, planJson: undefined, noteJson: undefined };
    this.recs.set(cur.key, rec);
    if (!cur.machine) this.watch(dir, false, cx);
    const [pj, nj] = await Promise.all([this.read(joinPath(dir, "plan.json"), cur.machine), this.read(joinPath(dir, "note.json"), cur.machine)]);
    let changed = false;
    if (force || pj !== rec.planJson) {
      const meta = pj === null ? null : parseMeta(pj);
      const docPath = meta && isReadablePath(meta.path) ? meta.path : null;
      const target = meta ? compareTarget(meta) : null;
      const text = docPath ? await this.read(docPath, cur.machine) : null;
      const base = text === null || !target ? null
        : await this.read(joinPath(dir, target === "ruled" ? "plan.ruled.md" : "plan.prev.md"), cur.machine);
      if (docPath && !cur.machine) this.watch(dirOf(docPath), true, cx);
      const next = { meta, path: docPath, text, base, target };
      if (pj !== rec.planJson || JSON.stringify(next) !== JSON.stringify(rec.planDoc)) {
        rec.planJson = pj;
        rec.planDoc = next;
        rec.plan = text === null ? null : markBlocks(text, base);
        rec.hunks = text === null ? null : diffHunks(text, base);
        rec.rev++;
        changed = true;
      }
    }
    if (force || nj !== rec.noteJson) {
      const meta = nj === null ? null : parseMeta(nj);
      const text = meta ? await this.read(joinPath(dir, "note.md"), cur.machine) : null;
      if (nj !== rec.noteJson || text !== rec.noteText) {
        rec.noteJson = nj;
        rec.noteMeta = meta;
        rec.noteText = text;
        rec.note = text === null ? null : markBlocks(text, null);
        rec.rev++;
        changed = true;
      }
    }
    return changed;
  }

  // ---- links ----------------------------------------------------------------------------------------------------

  openUrl(url, cx) {
    if (!isSafeHttpsUrl(url)) return;
    const p = guard(() => window().platform, "");
    const argv = openerArgv(p === "macos" ? "darwin" : p === "windows" ? "win32" : "linux", url);
    if (!argv) return;
    cx.spawn(async () => { try { await exec(argv[0], argv.slice(1)); } catch { /* no opener: nothing to do */ } });
  }

  // ---- drawing --------------------------------------------------------------------------------------------------

  md(id, text) {
    const el = TextView.markdown(id, this.linksOn ? sanitize(text) : sanitize(text, { links: false })).selectable(true);
    return this.linksOn ? el.on_link_click((url, cx) => this.openUrl(url, cx)) : el;
  }

  block(t, b, i, rec, tabId) {
    const el = this.md(`b-${rec.rev}-${tabId}-${i}`, b.text);
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
    const cur = this.cur ?? { empty: "Waiting for foreman radar" };
    const frame = (...kids) => v_flex().id("plan-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13).children(kids);
    if (cur.empty) return frame(this.message(t, cur.empty));
    const rec = cur.key ? this.recs.get(cur.key) : null;
    const isNote = cur.tab.id === "note";
    const tabBtn = (id, label, on, fn) => div().id(id).px(8).py(2).rounded(5).cursor_pointer().text_size(11).truncate().max_w(160)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(fn).child(label);
    const tabs = cur.tabs.length > 1 ? h_flex().flex_none().flex_wrap().px(10).py(4).gap(4).border_b(1).border_color(t.border)
      .children(cur.tabs.map((x) => tabBtn(`tab-${x.id}`, x.id === "note" && rec?.noteMeta?.title ? `Note: ${rec.noteMeta.title}` : x.label, x.id === this.tab, (_e, cx) => { this.tab = x.id; cx.notify(); }))) : null;

    const meta = isNote ? rec?.noteMeta : rec?.planDoc?.meta;
    const doc = isNote ? rec?.note : rec?.plan;
    const adds = !isNote && doc ? doc.adds : 0;
    const topic = isNote ? "" : topicOf(rec?.planDoc?.path) || (cur.tab.id.startsWith("c:") ? cur.tab.label : "");
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
    if (!doc) body = this.message(t, isNote ? "No note published by this session" : "No plan published by this session");
    else if (this.diff && !isNote) body = this.diffView(t, rec.hunks, doc.note);
    else body = v_flex().w_full().gap(2)
      .when(Boolean(doc.note), (e) => e.child(div().px(10).py(2).text_size(11).text_color(t.dim).child(doc.note)))
      .children(doc.blocks.map((b, i) => this.block(t, b, i, rec, cur.tab.id)));
    return frame(
      head,
      ...(tabs ? [tabs] : []),
      div().id("plan-body").flex_1().min_h(0).overflow_y_scrollbar().p(10).child(body),
    );
  }
}
