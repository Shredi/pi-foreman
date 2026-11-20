// pi-foreman mod for herdr-app: an Agents view with the foreman rows built in under each agent that is a foreman session.
// Reads `foreman radar --json` and, per agent terminal, `hc get <terminal> --json` (exec, argv only; the child records of
// pi-subagents), joins on hcTerminal, never writes; `foreman prs poll` fetches.
// The other execs are `foreman prs poll --json` per machine and the platform opener on a PR chip click, after the URL passed the https rule (model.js).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Collapsible, HoverCard } from "gpui-base";
import { agents, terminals, focused, spaces, run, theme, setAgentOrder, exec, props, window, setShared, readTextFile, shared, layout, notify } from "herdr";
import {
  parseRadarDoc, buildTree, joinAgents, joinChildren, nestedAgents, sessionTree, hcChildItems, bareChildren, displayStatus, urgentStatus, detailLine, statusLine, prDotState, splitPrs, prCard, prCardHeight, prCardKey, prTooltip, radarKey, numberCellWidth, PR_LEGEND, placeCardBox, prTones, enrichPrs, openPrGroups, openPrsAge, shownSet,
  radarBinary, parseRecords, recsKey, parseAttachTarget, remoteClick, attachNests, agentStatus, glyphSpec, isSafeHttpsUrl, openerArgv, openFailure, prUrl, fmtSince, workerStatus, childTerminals,
  slimRadar, joinPath, parseShowMeta, showRows, allSessions, findPanelBlock, clashingTabs, agentLabel, remoteNodesOf, endedRemoteNodesOf, remoteTwins, remoteTarget, drawnRemoteTargets, dropDrawnEndedMirrors, spaceGroups, mergeFeeds,
} from "./model.js";
import { SAMPLE, SAMPLE_MANY } from "./sample.mjs";

const LOCAL_MS = 3000;
const REMOTE_MS = 15000;
const RETRY_MS = 30000;
const STUCK_MS = 45000; // a poll older than this is taken as lost
const SHOW_EVERY_MS = 30000; // plan.json / note.json of a session are re-read this often (sooner when its version hint moves)
const WATCHDOG_MS = 35000; // a radar exec older than this is given up
const PRS_EVERY_MS = 30000; // `foreman prs poll` starts this long after its previous run ended
const PRS_WATCHDOG_MS = 20 * 60000; // a prs poll exec older than this is given up
const PRS_STUCK_MS = 21 * 60000; // a prs poll older than this is taken as lost
const PRESS_MS = 1500; // a clicked element shows its pending state this long (the 1 s timer then redraws it)
const RENDER_NOTICE_MS = 600000; // the render notice comes at most this often
const OPEN_PR_FOLD_AT = 15; // with more Open PRs than this, the groups without a failing check or a conflict start folded
const OPEN_PR_GROUP_LINES = 8; // a group open for a failing check or a conflict draws this many lines, then "+N more"
const LEGEND_LEAVE_MS = 1000; // the legend's content is dropped this long after the pointer left the "?"
// exec `timeout` (ms) per job; the Promise.race watchdogs stay as the backstop for an app that ignores the option (Herdr app 0.1.13)
const T_RADAR = 30000;
const T_PRS = 600000; // the cap of exec
const T_HC_LOCAL = 10000;
const T_HC_REMOTE = 15000;
const T_ATTACH = 15000;
const T_OPEN = 10000;
const T_RESTART = 120000; // a remote restart probes and starts on the other machine
const SPINNER = "mods/workspace-chrome/spinner.svg";
const CHEVRON = { open: "mods/workspace-chrome/chevron-down.svg", closed: "mods/workspace-chrome/chevron-right.svg" };
const AGENT_GLYPH = "🤖"; // the mark of an agent row, an emoji like the ⏳ / ⚙ of the status lines
const CARD = 5; // inset of a session card: 4px margin and its 1px border
const LINE = 14; // width of one connector cell

// Pi is the only harness: its logo and a leading "π - " in a terminal title say nothing, so sessions carry neither. Only agent
// rows (subagent runs and agent-marked background tasks) carry an icon; a shell task is the gear line only.
const stripPi = (s) => (typeof s === "string" ? s.replace(/^\s*π\s*(?:-\s*)?/, "") : s);

// One status mark from a glyphSpec: a spinner, the "Needs you" pill, or a dot (hollow ring or filled).
function glyph(t, spec) {
  const ink = t[spec.tone] ?? t.dim;
  switch (spec.kind) {
    case "spin":
      return svg(SPINNER).flex_none().size(13).mx(1).text_color(spec.hollow ? ink + "99" : ink).spin(spec.ms ?? 1100);
    case "square":
      return div().flex_none().size(7).mx(2).rounded(2).bg(ink);
    case "pill":
      return h_flex().flex_none().items_center().h(17).px(7).rounded(6)
        .bg(ink + "2e").border(1).border_color(ink + "55")
        .text_size(10).font_semibold().text_color(ink)
        .child("Needs you");
    default: {
      const dot = div().flex_none().size(8).mx(2).rounded(4);
      return spec.hollow ? dot.border(1.5).border_color(ink) : dot.bg(ink);
    }
  }
}

const statusGlyph = (t, status) => glyph(t, glyphSpec(status));

const tones = prTones;

// One dot per PR: its colour is the PR's state, and it pulses (opacity, native loop) while a job runs or the checks are not settled.
// A ready PR (`mark: "check"`) gets a check mark in the same box instead: a bold text glyph in its green, never pulsing.
// A PR that waits on required checks (`hollow`) gets a still ring instead: an amber border, no fill.
function prDot(t, st) {
  const color = tones(t)[st.fill];
  if (st.mark === "check") return h_flex().relative().flex_none().size(14).mx(1).items_center().justify_center()
    .text_size(12).font_semibold().text_color(color).child("✓");
  if (st.hollow) return div().relative().flex_none().size(14).mx(1)
    .child(div().absolute().top(4).left(4).size(6).rounded(3).border(1.5).border_color(color));
  return div().relative().flex_none().size(14).mx(1)
    .child(div().absolute().top(4).left(4).size(6).rounded(3).bg(color)
      .when(st.pulse, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })));
}

// An Open PRs line needs attention when a finished check failed (its dot is red) or the PR conflicts with its base (the conflict mark).
const prFailing = (pr) => prDotState(pr).fill === "red";
const prConflict = (pr) => prDotState(pr).conflict === true;

// Conflict marker, independent of the dot: a small red disc with a bang.
const conflictMark = (t) => h_flex().flex_none().size(11).rounded(6).bg(t.blocked).items_center().justify_center()
  .text_size(8).font_semibold().text_color(t.chrome).child("!");

// A section heading ("Open PRs", the space groups): one look for all of them. `rule` draws a 1px line above it, with more space above the
// line than a repository group gets (its own rule is 5 px down), so the section start does not look like one more repository divider.
const sectionHead = (t, id, label, { rule = false } = {}) => h_flex().id(id).px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(13).font_semibold()
  .when(rule, (el) => el.mt(10).border_t(1).border_color(t.border))
  .child(div().truncate().text_color(t.foreground).child(label));

// A failed or garbled radar read (the binary busy, a half-written file) keeps the last good data for a few rounds, so costs,
// waits and PR chips do not vanish from every row at once; after MISS_MAX misses the machine shows as having no radar.
const MISS_MAX = 5;
const keepRadar = (prev) => (prev?.ok && (prev.misses ?? 0) < MISS_MAX
  ? { ...prev, misses: (prev.misses ?? 0) + 1, tried: Date.now() }
  : { ok: false, tried: Date.now() });

// Short stable hash of a card's content: part of the HoverCard id, so a card whose content changed is a new element.
const hashOf = (s) => {
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0;
  return x.toString(36);
};

const guard = (f, fallback) => { try { return f(); } catch { return fallback; } };
// The counts an Open PRs group is sorted and folded by; `prs` is null for a group without a PR list.
const openPrInfo = (g) => {
  const prs = Array.isArray(g?.prs) ? g.prs : null;
  return { g, prs, failing: (prs ?? []).filter(prFailing).length, conflicts: (prs ?? []).filter(prConflict).length };
};
// A throw about the `timeout` option itself (a synchronous TypeError for the options argument, or an option message), never a run that
// timed out or a network text such as `dial tcp ...: i/o timeout`. Same logic as in ../pi-foreman-plan/main.js (separate mod folders, no import).
const optionError = (e) => e instanceof TypeError || /timeout must|unknown (option|field|key)|invalid option|unexpected (option|field)/i.test(String(e?.message ?? e));
const why = (e) => String(e?.message ?? e ?? "").slice(0, 200);
// No foreman on this machine: Herdr 0.1.14's texts for a program that does not start (mods.rs `cannot run`, the core's `cannot start ... program not found`).
// A setup state, not a failed poll: the radar shows its own hint, so the PR poll stays silent.
const missingBinary = (e) => /cannot (start|run) [^:]+: (program not found|No such file or directory)/.test(String(e?.message ?? e ?? ""));
const isObjLike = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export default class ForemanAgents extends View {
  init(p, cx) {
    this.changed = {};
    this.feed = []; // radar openPrs of all machines, merged: twins of session PRs (title, description, jobs)
    this.renderOpen = false; // set by render, cleared at its end: still set at the tick, the last render did not finish
    this.renderBroke = false; // a render started while the previous one was still open
    this.prFault = false; // a PR part fell back to its guard since the last tick
    this.folded = new Set(); // tree item ids the user folded
    this.radar = new Map(); // machine key -> {ok, tree, openPrs, tried}
    this.busy = new Map(); // key -> when its task started
    const given = guard(() => props() ?? p ?? {}, {});
    this.foremanProp = given.foreman;
    this.hcProp = given.hc;
    // The sample view (docs/development.md): the radar comes from sample.mjs once; nothing is polled and nothing is started.
    this.sample = given.sample === true;
    this.manyPrs = given.manyPrs === true; // with the sample: the 52-PR feed of sample.mjs (SAMPLE_MANY) instead of the legend's
    if (this.sample) {
      const doc = parseRadarDoc(JSON.stringify(this.manyPrs ? SAMPLE_MANY.radar : SAMPLE.radar));
      this.radar.set("local", { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: null, tried: Date.now() });
    }
    this.recs = new Map(); // agent address -> {recs, tried}
    this.childPi = new Set(); // pane-less pi child terminals (set by render), polled for records too
    this.remoteTargets = new Set(); // `<machine>/<t>` of the remote sessions drawn as registry rows (set by render), polled for records too
    this.noteSeen = new Map(); // `${machine}|${session key}` -> last note version seen on the radar
    this.shows = new Map(); // `${machine}|${dir}` -> what was read of a session's plan.json / note.json
    this.prsRan = new Map(); // busy key -> when its prs poll last ended
    this.noTimeout = false; // true once this copy's exec rejected the `timeout` option itself (Herdr app 0.1.13)
    this.failed = new Set(); // keys of runs whose last try failed: one error notice per failure, not per retry
    this.pressed = new Map(); // element id -> when it was clicked: the next render shows it pending (visible feedback, same frame)
    this.seenChips = new Set();
    this.clocks = new Map(); // id -> a shown age and how to read it again (see clock)
    this.expanded = new Set(); // repositories whose capped Open PRs group shows all its lines
    this.legendHot = false; // the pointer rests on the legend's "?": only then is its content built
    this.legendLeft = null; // when it left (the content goes LEGEND_LEAVE_MS later)
    this.hotCard = null; // id of the PR chip the pointer last rested on, cleared when that chip is no longer drawn: the only chip whose hover card is built
    this.poll(cx);
    this.pollPrs(cx, Date.now());
    cx.timer.every(1000, (cx) => { this.poll(cx); this.pollPrs(cx, Date.now()); this.unpress(cx); this.tickClocks(cx); });
  }

  // A click gives feedback in the render it causes: the element lights up and shows "…" until PRESS_MS has passed.
  press(id, cx) {
    this.pressed ??= new Map();
    this.pressed.set(id, Date.now());
    cx?.notify?.();
  }

  pressing(id) {
    const at = this.pressed?.get(id);
    return at !== undefined && Date.now() - at < PRESS_MS;
  }

  unpress(cx) {
    let gone = false;
    for (const [id, at] of this.pressed ?? []) if (Date.now() - at >= PRESS_MS) { this.pressed.delete(id); gone = true; }
    if (gone) cx.notify();
  }

  // A shown age that comes from now (a row's time in its status, a plan or note age, the Open PRs header) is a clock: render records the text it
  // drew and how to get it again, and the 1 s timer redraws only when one of them reads differently. Their steps are minutes.
  clock(id, text, now) {
    const shown = text(now);
    this.clocks ??= new Map();
    this.clocks.set(id, { text, shown });
    return shown;
  }

  tickClocks(cx) {
    const now = Date.now();
    let changed = false;
    for (const c of this.clocks?.values() ?? []) if (c.text(now) !== c.shown) changed = true;
    if (this.legendHot && this.legendLeft !== null && now - this.legendLeft >= LEGEND_LEAVE_MS) { this.legendHot = false; changed = true; }
    if (changed) cx.notify();
  }

  machines() {
    const names = guard(() => spaces().map((s) => s.machine).filter((m) => typeof m === "string" && m), []);
    return [null, ...new Set(names)];
  }

  // exec with a `timeout`. If the call throws or rejects because of the option itself (an app that predates it), it runs once more
  // without it and this copy stops passing it; every other rejection (no binary, a run stopped by the timeout) goes to the caller.
  async execT(command, args, options, timeout) {
    if (this.sample) return { code: 1, stdout: "" };
    if (this.noTimeout) return exec(command, args, options);
    try {
      return await exec(command, args, { ...options, timeout });
    } catch (e) {
      if (!optionError(e)) throw e;
      this.noTimeout = true;
      return exec(command, args, options);
    }
  }

  // One error notice when a run starts failing; none while it keeps failing, so a machine without foreman does not toast every round.
  fail(key, title, e) {
    this.failed ??= new Set();
    if (this.failed.has(key)) return;
    this.failed.add(key);
    guard(() => notify({ title, body: why(e), level: "error" }));
  }

  // `guard` for the PR parts: a fallback also sets `prFault`, which the next tick turns into the render notice.
  prGuard(f, fallback) {
    try { return f(); } catch { this.prFault = true; return fallback; }
  }

  // The Agents view did not finish drawing: a render cut short (`renderOpen` still set at the tick) or a PR part that fell back since
  // the last tick. Read and cleared here, on the tick only, so no host call is made from render. One warning per RENDER_NOTICE_MS at
  // most; it names the state, never an error text.
  renderNotice() {
    const broke = this.renderBroke === true || this.prFault === true || this.renderOpen === true;
    this.renderBroke = false;
    this.prFault = false;
    this.renderOpen = false;
    const now = Date.now();
    if (!broke || (this.renderNoticeAt !== undefined && now - this.renderNoticeAt < RENDER_NOTICE_MS)) return;
    this.renderNoticeAt = now;
    guard(() => notify({
      title: "The Agents view did not finish drawing",
      body: "Parts of it, such as the pull requests, may be incomplete or out of date. Many open pull requests or a slow computer can cause this.",
      level: "warning",
    }));
  }

  poll(cx) {
    if (this.sample) return;
    this.renderNotice();
    const now = Date.now();
    for (const machine of this.machines()) {
      const key = machine ?? "local";
      const rec = this.radar.get(key);
      const every = !rec ? 0 : !rec.ok ? RETRY_MS : machine ? REMOTE_MS : LOCAL_MS;
      // A task that never came back (a cancelled task leaves its promise pending) frees its key after 45 s.
      if (this.busy.has(key) && now - this.busy.get(key) > STUCK_MS) this.busy.delete(key);
      if (this.busy.has(key) || (rec && now - rec.tried < every)) continue;
      this.busy.set(key, now);
      cx.spawn(async (cx) => {
        let next;
        try {
          const r = await Promise.race([
            this.execT(radarBinary(this.foremanProp, machine), ["radar", "--json"], { on: machine }, T_RADAR),
            cx.sleep(WATCHDOG_MS).then(() => ({ code: -1, stdout: "" })),
          ]);
          const doc = r.code === 0 ? parseRadarDoc(r.stdout, machine) : null;
          next = doc ? { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() } : null;
        } catch {
          next = null;
        }
        next = next ?? keepRadar(this.radar.get(key));
        this.radar.set(key, next);
        this.busy.delete(key);
        this.publish();
        // Stored always (fresh ages and `tried`); redrawn only when what it shows changed (ages by their label, see radarKey).
        this.radarKeys ??= new Map();
        const shown = radarKey(next);
        const same = this.radarKeys.get(key) === shown;
        this.radarKeys.set(key, shown);
        if (!same) cx.notify();
      });
    }
    this.pollRecords(cx, now);
    this.pollShows(cx, now);
    this.noteNotice();
  }

  // A tracked session's note version that rose while the layout has no pi-foreman-plan block: the note is written but nothing shows
  // it, so say once per version how to add the panel. This mod runs in every layout; the plan mod only where the block exists. The
  // first sight of a session only records its version. The layout walk is cached by layout name.
  noteNotice() {
    let blockless;
    for (const [mk, rec] of this.radar) {
      if (!rec.ok) continue;
      for (const n of allSessions(rec.tree)) {
        const v = Number.isInteger(n.show?.note) ? n.show.note : null;
        if (v === null) continue;
        const id = `${mk}|${n.key}`;
        this.noteSeen ??= new Map();
        const seen = this.noteSeen.get(id);
        this.noteSeen.set(id, v);
        if (seen === undefined || v <= seen) continue;
        blockless ??= this.layoutLacksPlan();
        if (!blockless) continue;
        guard(() => notify({
          title: "Foreman note: no plan panel in this layout",
          body: "Add a block {\"mod\": \"pi-foreman-plan\"} to a stack in your layout (layouts/<name>.json), for example next to the files block in a hidden panel; see docs/herdr.md#notes.",
          level: "info",
        }));
      }
    }
  }

  // True only when the layout is readable and has no pi-foreman-plan block; an unreadable layout counts as having one.
  layoutLacksPlan() {
    const raw = guard(() => shared("layout"), undefined);
    const name = typeof raw === "string" ? raw : isObjLike(raw) && typeof raw.name === "string" ? raw.name : "";
    if (this.layoutCache?.name === name) return this.layoutCache.lacks;
    const tree = guard(() => layout(), null);
    const lacks = isObjLike(tree) ? findPanelBlock(tree, "pi-foreman-plan") === null : false;
    this.layoutCache = { name, lacks };
    return lacks;
  }

  // The sessions of every machine's radar as shared state for the plan panel, rewritten only when they changed (shared values
  // are persisted and every mod re-renders on a write).
  publish() {
    const machines = {};
    for (const [key, rec] of this.radar) if (rec.ok) machines[key] = slimRadar(rec.nodes ?? []);
    const text = JSON.stringify(machines);
    if (text === this.published) return;
    this.published = text;
    // Deliberately app-global: the plan panel (another mod, any copy) reads this key; every copy writes the same radar view.
    guard(() => setShared("pi-foreman.radar", { machines }));
  }

  // plan.json / note.json of each session with a `show` pointer, for the age on its plan and note rows: re-read when the
  // version hint changed, else every 30 s. A missing or bad file leaves the row without an age.
  pollShows(cx, now) {
    for (const [mk, rec] of this.radar) {
      if (!rec.ok) continue;
      const machine = mk === "local" ? null : mk;
      for (const n of allSessions(rec.tree)) {
        const s = n.show;
        if (!s || (s.plan === undefined && s.note === undefined)) continue;
        const id = `${mk}|${s.dir}`;
        const hint = `${s.plan ?? ""}/${s.note ?? ""}`;
        this.shows ??= new Map();
        const have = this.shows.get(id);
        const bk = `show:${id}`;
        if (this.busy.has(bk) && now - this.busy.get(bk) > STUCK_MS) this.busy.delete(bk);
        if (this.busy.has(bk) || (have && have.hint === hint && now - have.read < SHOW_EVERY_MS)) continue;
        this.busy.set(bk, now);
        cx.spawn(async (cx) => {
          const one = async (name) => {
            try { const text = await readTextFile(joinPath(s.dir, name), { on: machine }); return text === null ? null : parseShowMeta(text); } catch { return null; }
          };
          const plan = s.plan === undefined ? null : await one("plan.json");
          const note = s.note === undefined ? null : await one("note.json");
          const before = this.shows.get(id);
          this.shows.set(id, { hint, read: Date.now(), plan, note });
          this.busy.delete(bk);
          if (JSON.stringify([before?.plan ?? null, before?.note ?? null]) !== JSON.stringify([plan, note])) cx.notify();
        });
      }
    }
  }

  // A click on a plan or note row: pin the panel to that session and document, bring the plan panel forward.
  // The header button passes no node: it only brings the panel forward.
  openPanel(node, kind) {
    // Deliberately app-global: the pin is read by the plan panel, a different mod, wherever it sits.
    if (node) {
      const req = { key: node.key, kind, n: Date.now() };
      guard(() => setShared("pi-foreman.show", req));
      // Deliberately app-global too: the plan block is not mounted while its panel is hidden, so it cannot see the change above;
      // it reads this request when it mounts and clears it (a mounted copy clears it on the change).
      guard(() => setShared("pi-foreman.show-pending", req));
    }
    guard(() => run("layout.select", { stack: "panel-body", child: "plan" }));
    guard(() => run("layout.show", { id: "panel" }));
  }

  // `foreman prs poll --json` per machine, 30 s after its previous run ended: it polls the tracked PRs and the PR search and writes
  // the store files the radar reads. The mod only runs it; a failure raises one error notice and the next round tries again.
  pollPrs(cx, now) {
    if (this.sample) return;
    for (const machine of this.machines()) {
      const key = `prs:${machine ?? "local"}`;
      if (this.busy.has(key) && now - this.busy.get(key) > PRS_STUCK_MS) this.busy.delete(key);
      this.prsRan ??= new Map();
      const ended = this.prsRan.get(key);
      if (this.busy.has(key) || (ended !== undefined && now - ended < PRS_EVERY_MS)) continue;
      this.busy.set(key, now);
      cx.spawn(async (cx) => {
        try {
          const r = await Promise.race([
            this.execT(radarBinary(this.foremanProp, machine), ["prs", "poll", "--json"], { on: machine }, T_PRS),
            cx.sleep(PRS_WATCHDOG_MS).then(() => ({ code: -1, stdout: "", watchdog: true })),
          ]);
          if (r?.watchdog) this.fail(key, "Foreman PR poll timed out", `on ${machine ?? "this computer"}`);
          else this.failed?.delete(key);
        } catch (e) {
          if (missingBinary(e)) this.failed?.delete(key);
          else this.fail(key, "Foreman PR poll failed", e);
        }
        this.prsRan.set(key, Date.now());
        this.busy.delete(key);
      });
    }
  }

  // One `hc get` per agent terminal per interval; a failure leaves no records.
  pollRecords(cx, now) {
    // Only pi terminals (listing field `app`) can have pi-subagents records.
    const paned = guard(() => agents().filter((a) => a?.app === "pi").map((a) => a.address).filter((x) => typeof x === "string" && x), []);
    const list = [...new Set([...paned, ...this.childPi, ...(this.remoteTargets ?? [])])];
    for (const addr of this.recs.keys()) if (!list.includes(addr)) this.recs.delete(addr);
    for (const addr of list) {
      const rec = this.recs.get(addr);
      const cut = addr.indexOf("/");
      const machine = cut > 0 ? addr.slice(0, cut) : null;
      if (this.busy.has(`hc:${addr}`) && now - this.busy.get(`hc:${addr}`) > STUCK_MS) this.busy.delete(`hc:${addr}`);
      if (this.busy.has(`hc:${addr}`) || (rec && now - rec.tried < (machine ? REMOTE_MS : LOCAL_MS))) continue;
      this.busy.set(`hc:${addr}`, now);
      cx.spawn(async (cx) => {
        let recs = [];
        let attach = "";
        try {
          const r = await this.execT(radarBinary(this.hcProp, machine, "hc"), ["get", addr.slice(cut + 1), "--json"], { on: machine }, machine ? T_HC_REMOTE : T_HC_LOCAL);
          if (r.code === 0) { recs = parseRecords(r.stdout); attach = parseAttachTarget(r.stdout); }
        } catch { /* no hc here: no records */ }
        this.busy.delete(`hc:${addr}`);
        if (this.childPi.has(addr) || this.remoteTargets?.has(addr) || guard(() => agents().some((a) => a?.address === addr), false)) {
          const before = this.recs.get(addr);
          this.recs.set(addr, { recs, attach, tried: Date.now() });
          if (recsKey(before?.recs) !== recsKey(recs) || (before?.attach ?? "") !== attach) cx.notify();
        }
      });
    }
  }

  track(list, now) {
    for (const a of list) {
      const s = a.status !== "done" ? a.status : "idle";
      if (this.changed[a.address]?.s !== s) this.changed[a.address] = { s, at: now };
    }
  }

  // A click on a remote session card: focus the local `hc attach` terminal of it, else start one (`hc run`, removed once it exits).
  openRemote(node, cx) {
    const plan = guard(() => remoteClick(node, this.terms, (a) => this.recs.get(a)?.attach ?? ""), null);
    if (!plan) return;
    if (plan.kind === "focus") {
      const pane = guard(() => agents().find((a) => a?.address === plan.address)?.pane, undefined);
      run(pane === undefined ? "terminal.peek" : "pane.focus", pane === undefined ? { terminal: plan.address } : { pane });
      return;
    }
    const hc = radarBinary(this.hcProp, null, "hc");
    cx.spawn(async () => {
      try {
        await this.execT(hc, ["run", "--json", "--bg", "--no-notify", "--rm", "--name", plan.name, "--", hc, "attach", plan.target], {}, T_ATTACH);
      } catch (e) { guard(() => notify({ title: "Could not open the remote session", body: why(e), level: "error" })); }
    });
  }

  // The Restart action of an ended child row radar flagged `restartable`: `foreman session restart <child id>` (a new kept terminal; no
  // tab or pane is closed). The card joins the new terminal by its address once the registry holds it.
  restartChild(child, cx) {
    const bin = radarBinary(this.foremanProp, null);
    cx.spawn(async () => {
      try {
        const r = await this.execT(bin, ["session", "restart", child], {}, T_RESTART);
        if (r && typeof r.code === "number" && r.code !== 0) guard(() => notify({ title: "Could not restart the session", body: String(r.stderr || r.stdout || "").trim().split("\n")[0].slice(0, 200) || `exit ${r.code}`, level: "error" }));
      } catch (e) { guard(() => notify({ title: "Could not restart the session", body: why(e), level: "error" })); }
    });
  }

  openUrl(url, cx) {
    if (!isSafeHttpsUrl(url)) return;
    const p = guard(() => window().platform, "");
    const argv = openerArgv(p === "macos" ? "darwin" : p === "windows" ? "win32" : "linux", url);
    const fail = (body) => guard(() => notify({ title: "Could not open the link", body, level: "error" }));
    if (!argv) { fail("no opener for this platform"); return; }
    cx.spawn(async () => {
      try {
        const r = await this.execT(argv[0], argv.slice(1), {}, T_OPEN);
        const bad = openFailure(r);
        if (bad) fail(bad);
      } catch (e) { fail(openFailure(e) || "the opener could not run"); }
    });
  }

  // A PR is a line: number, the conflict mark and the dot, the title. A click opens its page when radar gave a URL (or a repository URL to
  // derive it from). Resting on the line opens the hover card; the tooltip names the state in words. `line` is {title, numW}: the title and the width of the number cell.
  prChip(t, pr, href, key, line = {}) {
    return this.prGuard(() => this.prChipRaw(t, pr, href, key, line), h_flex().flex_none().px(6).text_size(10.5).text_color(t.muted).child(`⎇ #${pr?.number ?? "?"}`));
  }

  prChipRaw(t, pr, href, key, line) {
    const st = prDotState(pr);
    const red = st.fill === "red";
    const label = `⎇ #${pr.number}`;
    // The marks cell has a fixed width (the conflict slot stays as blank space without a conflict), so the titles stand at one x.
    const chip = h_flex().w_full().h(18).px(4).gap(4).items_center().rounded(4).text_size(10.5).font_medium()
      .text_color(red ? t.blocked : t.muted)
      .child(div().flex_none().w(line.numW ?? 52).whitespace_nowrap().child(label))
      .child(h_flex().flex_none().w(30).gap(2).items_center()
        .child(st.conflict ? conflictMark(t) : div().flex_none().size(11))
        .child(prDot(t, st)))
      .when(Boolean(line.title), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(red ? t.foreground : t.muted).child(line.title)));
    const id = `pr-${key}-${pr.number}`;
    // The pointer on the line tells where it is: the card goes below it, above it near the bottom, else beside it (never over it).
    const onMove = (e, cx) => guard(() => {
      // The size is the one render stored (this.vp); a live read from the handler refreshes it after a resize when the host allows it.
      const b = e?.bounds, pos = e?.position, loc = e?.local_position, vp = guard(() => globalThis.window?.viewport_size?.(), null) ?? this.vp;
      // The pointer rests on this line: its card is built by the render that follows (the line id is stable across data changes).
      let redraw = this.hotCard !== id;
      this.hotCard = id;
      if (b && pos && loc && vp) {
        const { anchor, maxH } = placeCardBox({ x: pos.x - loc.x, y: pos.y - loc.y, w: b.width, h: b.height }, { w: vp.width, h: vp.height }, { w: 300, h: prCardHeight(prCard(pr)) });
        this.cardAnchor ??= new Map();
        this.cardMaxH ??= new Map();
        if (this.cardAnchor.get(id) !== anchor || this.cardMaxH.get(id) !== maxH) { this.cardAnchor.set(id, anchor); this.cardMaxH.set(id, maxH); redraw = true; }
      }
      if (redraw) cx.notify?.();
    }, undefined);
    const trigger = chip.id(id).tooltip(prTooltip(pr)).on_mouse_move(onMove)
      .when(Boolean(href), (el) => el.cursor_pointer()
        .hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation?.(); this.press(id, cx); this.openUrl(href, cx); }))
      .when(!href, (el) => el.on_click((_e, cx) => {
        cx.stop_propagation?.();
        guard(() => notify({ title: "No link for this pull request", body: `#${pr.number} has no page address yet.`, level: "info" }));
      }));
    this.seenChips?.add(id);
    // The id carries a short key of the card's content (prCardKey): a card is not reused when its content changed.
    // Only the hot line builds its card (cardView is about 15 elements, each one host call); the others hold an empty element.
    return HoverCard.new(`card-${key}-${pr.number}-${hashOf(prCardKey(pr))}`).open_delay(300).close_delay(200)
      .anchor(this.cardAnchor?.get(id) ?? "top_center")
      .trigger(trigger).content(this.hotCard === id ? (this.prGuard(() => this.cardView(t, prCard(pr), this.cardMaxH?.get(id)), null) ?? div()) : div());
  }

  // The hover card of a PR: title, description excerpt, conflict line, the jobs grouped failed / running / passed.
  // `maxH` bounds the card to the room on its side of the chip; what does not fit is clipped (gpui-kit style.rs:95 max_h, gpui `overflow_hidden`).
  cardView(t, c, maxH = 0) {
    const color = tones(t);
    const tone = { failed: color.red, running: color.amber, waiting: color.amber, passed: color.green };
    const shell = v_flex().w(300).p(10).gap(7).bg(t.popover).border(1).border_color(t.border).rounded(8)
      .text_size(11).text_color(t.muted)
      .when(maxH > 0, (el) => el.max_h(maxH).overflow_hidden());
    const title = div().text_size(12).font_semibold().text_color(t.foreground).child(c.title);
    const excerpt = div().text_color(t.muted).child(c.excerpt);
    const conflict = h_flex().gap(5).items_center().text_color(t.blocked).child(conflictMark(t)).child(c.conflict);
    const jobs = v_flex().gap(5)
      .children(c.groups.map((g) => v_flex().gap(2)
        .child(h_flex().gap(5).items_center().font_semibold().text_color(tone[g.key])
          .child(div().flex_none().size(6).rounded(3).bg(tone[g.key])).child(`${g.label} (${g.count})`))
        .children(g.names.map((n) => div().pl(11).truncate().child(n)))
        .when(g.more > 0, (el) => el.child(div().pl(11).text_color(t.dim).child(`+${g.more} more`)))))
      .when(Boolean(c.status), (el) => el.child(div().text_color(t.foreground).child(c.status)))
      .when(Boolean(c.note), (el) => el.child(div().text_color(t.dim).child(c.note)))
      .when(c.groups.length === 0 && !c.status && !c.note, (el) => el.child(div().text_color(t.dim).child("no job data")));
    const state = div().text_color(t.foreground).child(c.state);
    return shell.child(title).child(state).when(Boolean(c.excerpt), (el) => el.child(excerpt))
      .when(Boolean(c.conflict), (el) => el.child(conflict)).child(jobs);
  }

  // Session PRs with the title, description and job names of their twin in radar's open-PRs list.
  enrich(prs) {
    return this.prGuard(() => enrichPrs(prs, this.feed), prs);
  }

  // The PRs of a session row: one line each (number, marks, dot, title), in sorted order, indented like the row's sub-rows. Hover and click are the line's.
  prLines(t, item, below, ind) {
    const lines = this.enrich(below);
    const numW = numberCellWidth(lines);
    return v_flex().flex_none().pl(ind + 20).pr(8).gap(1)
      .children(lines.map((p) => this.prChip(t, p, prUrl(item.node, p), item.id, { title: p.title ?? "", numW })));
  }

  // The one tree below a paned agent: its own agents (radar runs, hc records), its child sessions (radar children and joined
  // pane-less hc terminals) and theirs, all through sessionTree. `f` is the joined radar node or null; `live` the
  // hc child items of the agent.
  agentItems(f, hcStatus, recs, skip, live, skipKeys, recsOf = null, remoteOf = null) {
    if (!f) return { root: null, items: bareChildren(recs, live) };
    const root = sessionTree(f, { hcStatus, recs, recsOf, remoteOf, skip, skipKeys, extra: live });
    return { root, items: root ? root.children : [] };
  }

  // The fold slot of a row with children: an svg chevron. A caller whose own row takes the click passes `state` ({folded}): the chevron
  // then only shows that state. Without it the slot toggles `this.folded` on its own click.
  foldSlot(t, id, kids, state = null) {
    const folded = state ? state.folded : this.folded.has(id);
    return h_flex().flex_none().size(16).items_center().justify_center().rounded(4)
      .when(kids && !state, (el) => el.id(`fold:${id}`).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation?.(); if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id); cx.notify(); }))
      .when(kids, (el) => el.child(svg(folded ? CHEVRON.closed : CHEVRON.open).size(11).text_color(t.dim)));
  }

  // The children of a row in their container, every child wrapped with its drawn connector cells.
  childBody(t, items, ml) {
    return v_flex().flex_none().ml(ml + 2).children(items.map((c, i) => this.link(t, c, i === items.length - 1)));
  }

  // A child with its connector column. The head cell is as tall as the row (tee: line through plus the stub to the icon;
  // elbow: line to the middle, rounded corner, stub); below it, the pass cell carries the line past the child's own extras and
  // descendants when later siblings follow. Drawn with divs: the lines stay 1px and meet the next row, no stretched svg.
  link(t, item, last, carded = false) {
    const h = item.type === "session" ? 26 + CARD : 20; // a session's row sits in its card: CARD of margin, border and padding above it
    const mid = item.type === "session" ? CARD + 13 : 10;
    const ink = t.dim + "66";
    const head = div().id(`conn:${last ? "elbow" : "tee"}:${item.id}`).relative().flex_none().w(LINE).h(h)
      .when(!last, (el) => el.child(div().absolute().top(0).left(6).w(1).h(h).bg(ink)).child(div().absolute().top(mid).left(7).w(LINE - 7).h(1).bg(ink)))
      .when(last, (el) => el.child(div().absolute().top(0).left(6).w(LINE - 6).h(mid + 1).border_l(1).border_b(1).border_color(ink).rounded_bl(4)));
    const pass = div().id(`conn:pass:${item.id}`).relative().flex_1().w(LINE)
      .child(div().absolute().top(0).bottom(0).left(6).w(1).bg(ink));
    const column = v_flex().flex_none().w(LINE).self_stretch().child(head).when(!last, (el) => el.child(pass));
    return h_flex().flex_none().items_stretch().child(column).child(this.node(t, item, 0, carded).flex_1().min_w(0));
  }

  // Under a session row: one line per PR (`splitPrs(item.prs).below` via prLines), then the show lines, then the status line.
  // `x` is the left of the connector line when children follow (see rail): every extras row then carries it, so the line runs
  // unbroken from the row's chevron through these rows to the first child.
  extras(t, item, ind, x = null) {
    if (item.type !== "session") return [];
    const detail = detailLine(item.node, item.recs);
    const line = statusLine(detail);
    const blocked = detail.blocked;
    const meta = item.node?.show ? this.shows?.get(`${this.machineOf?.get(item.node) ?? "local"}|${item.node.show.dir}`) : null;
    const shows = item.node?.show ? showRows(item.node.show, meta, Date.now()) : [];
    if (shows.length) this.clock(`show:${item.id}`, (n) => showRows(item.node.show, meta, n).map((r) => r.text).join("\n"), Date.now());
    const below = splitPrs(item.prs ?? []).below;
    const rows = [
      ...(below.length ? [this.prGuard(() => this.prLines(t, item, below, ind), div())] : []),
      ...(shows.length ? [h_flex().pl(ind + 20).pr(8).h(18).flex_none().items_center().gap(10)
        .children(shows.map((r) => {
          const id = `show:${r.kind}:${item.id}`;
          const on = this.pressing(id);
          return div().id(id).flex_none().cursor_pointer().text_size(10.5).text_color(on ? t.working : t.dim).hover((el) => el.text_color(t.foreground))
            .on_click((_e, cx) => { this.press(id, cx); this.openPanel(item.node, r.kind); }).child(on ? `${r.text} …` : r.text);
        }))] : []),
      ...(line.text ? [h_flex().pl(ind + 20).pr(8).h(line.icon ? 16 : 20).flex_none().items_center().gap(6)
        .child(div().truncate().text_size(line.icon ? 10 : 11.5).text_color(blocked ? t.blocked : line.icon ? t.dim : t.muted).child(line.icon ? `${line.icon} ${line.text}` : line.text))] : []),
    ];
    return x === null ? rows : rows.map((r, i) => div().relative().flex_none().child(r).child(this.rail(t, `${item.id}/x${i}`, x)));
  }

  // The vertical connector: a 1px line `x` from the left, from `top` to the bottom of its (relatively placed) parent.
  rail(t, id, x, top = 0) {
    return div().id(`rail:${id}`).absolute().top(top).bottom(0).left(x).w(1).bg(t.dim + "66");
  }

  // One tree row: fold slot (svg chevron), label, cost, PR chips, status glyph; folded, the glyph is the most urgent below.
  // `x` (left of the connector line) is set when the children below are shown: the line starts under the chevron.
  nodeRow(t, item, ind, x = null, carded = false) {
    const root = item.top === true;
    const kids = item.children.length > 0;
    const slot = this.foldSlot(t, item.id, kids);
    const session = item.type === "session";
    const row = h_flex().id(`row:${item.id}`).flex_none().h(session ? (root ? 22 : 26) : 20).pl(ind).pr(8).gap(3).items_center()
      .text_size(session ? 12.5 : 11)
      .child(slot);
    if (item.type === "more") return row.child(div().flex_1().truncate().text_color(t.dim).child(item.label));
    if (!session) { // in a card the card's header row shows the state; an agent outside one (under the root) keeps its glyph
      return row.child(div().flex_none().text_size(11).child(AGENT_GLYPH))
        .child(div().flex_1().min_w(0).truncate().text_color(item.status === "blocked" ? t.blocked : t.muted).child(item.label))
        .when(!carded, (el) => el.child(statusGlyph(t, displayStatus(item, this.folded))));
    }
    const glyphRight = statusGlyph(t, displayStatus(item, this.folded));
    const active = item.address !== undefined && item.address === this.shown;
    const nameId = `name:${item.id}`;
    const nameOn = this.pressing(nameId);
    // A click anywhere on the row opens the session (the fold slot and the PR lines keep their own clicks); the name's own handler stops it there.
    const open = item.address !== undefined ? (_e, cx) => { this.press(nameId, cx); return item.pane === undefined ? run("terminal.peek", { terminal: item.address }) : run("pane.focus", { pane: item.pane }); }
      : item.node?.machine && item.node?.hcTerminal ? (_e, cx) => { this.press(nameId, cx); this.openRemote(item.node, cx); } : null;
    const name = div().id(nameId).flex_1().min_w(0).truncate().text_color(nameOn ? t.working : item.dim ? t.dim : active ? t.foreground : root ? t.foreground : t.muted).child(nameOn ? `${stripPi(item.label)} …` : stripPi(item.label));
    return row
      .when(active && root, (el) => el.bg(t.raised).rounded(6)) // a card carries the selection itself (see node)
      .when(open !== null, (el) => el.cursor_pointer().on_click(open))
      .child(open !== null ? name.cursor_pointer().on_click((e, cx) => { cx.stop_propagation?.(); return open(e, cx); }) : name)
      .when(Boolean(item.elsewhere), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(item.elsewhere)))
      .when(Boolean(item.restart), (el) => el.child(div().id(`restart:${item.id}`).flex_none().cursor_pointer().text_size(10.5).text_color(t.working).child(this.pressing(`restart:${item.id}`) ? "Restart …" : "Restart")
        .on_click((_e, cx) => { cx.stop_propagation?.(); this.press(`restart:${item.id}`, cx); this.restartChild(item.restart, cx); })))
      .when(Boolean(item.tier), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(item.tier)))
      .when(Boolean(item.costText), (el) => el.child(div().mr(3).text_size(11).text_color(root ? t.muted : t.dim).child(item.costText)))
      .when(root && item.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${item.sessions} sessions`)))
      .child(glyphRight)
      .when(x !== null, (el) => el.relative().child(this.rail(t, `${item.id}/row`, x, Math.floor(((root ? 22 : 26) + 16) / 2))));
  }

  // A tree node: a session is a small bordered card holding its row, extras and its own agent rows (connector inside the card);
  // its child sessions follow the card in a Collapsible, outside: a card inside a card would cost the nested rows another inset
  // of width per level in a narrow sidebar. With child sessions shown, the connector runs on through the card's bottom border
  // via a stub below it, and their connector column sits CARD further right to stay on the chevron's line.
  node(t, item, ind, carded = false) {
    const kids = item.children.length > 0;
    const open = kids && !this.folded.has(item.id);
    const x = open ? ind + 8 : null;
    const node = Collapsible.new().flex().flex_col().flex_none().open(open);
    if (item.type !== "session") return node.child(this.nodeRow(t, item, ind, null, carded)).when(kids, (el) => el.content(this.childBody(t, item.children, ind)));
    const agents = item.children.filter((c) => c.type !== "session");
    const sessions = item.children.filter((c) => c.type === "session");
    const after = open && sessions.length > 0; // the line leaves the card at the bottom
    const active = item.address !== undefined && item.address === this.shown;
    const card = v_flex().id(`card:${item.id}`).flex_none().mx(4).mt(2).mb(after ? 0 : 2).pt(2).pb(after ? 0 : 2).rounded(6).border(1).border_color(active ? t.working : t.border)
      .when(active, (el) => el.bg(t.raised))
      .child(this.nodeRow(t, item, ind, x)).children(this.extras(t, item, ind, x))
      .when(open && agents.length > 0, (el) => el.child(v_flex().flex_none().ml(ind + 2).children(agents.map((c, i) => this.link(t, c, !after && i === agents.length - 1, true)))));
    return node.child(card)
      // top -1: the stub overlaps the card's 1px bottom border, so the line has no gap there
      .when(after, (el) => el.child(div().relative().flex_none().h(2).child(this.rail(t, `${item.id}/gap`, x + CARD, -1))))
      .when(sessions.length > 0, (el) => el.content(this.childBody(t, sessions, ind + CARD)));
  }

  // One agent of the list: name, machine tag, time in this status, status.
  agentLine(t, a, now, status, items = [], root = null) {
    const kids = items.length > 0;
    const fid = `agent:${a.address}`;
    const host = a.address.includes("/") ? a.address.slice(0, a.address.indexOf("/")) : "";
    const since = this.changed[a.address]?.at;
    const quiet = a.status === "idle" && !a.focused;
    const name = stripPi(agentLabel(a, this.clashes)) || a.program?.name || a.address;
    const focusPane = (_e, cx) => { this.press(fid, cx); run("pane.focus", { pane: a.pane }); };
    const row = h_flex().id(`agent:${a.address}`).flex_none().h(30).px(8).gap(5).items_center().rounded(8).cursor_pointer();
    const shownStatus = kids && this.folded.has(fid) ? urgentStatus([status, ...items.map((c) => c.urgent)]) : status;
    return row
      .when(kids && !this.folded.has(fid), (el) => el.relative().child(this.rail(t, `${fid}/row`, 16, 23)))
      .child(this.foldSlot(t, fid, kids))
      .when(a.focused === true || this.pressing(fid), (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(focusPane)
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(name))
      .when(Boolean(root?.tier), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(root.tier)))
      .when(Boolean(root?.costText), (el) => el.child(div().text_size(11).text_color(t.muted).child(root.costText)))
      .when(root !== null && root.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${root.sessions} sessions`)))
      .when(host !== "", (el) => el.child(div().text_size(10).text_color(t.dim).child(host)))
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.clock(`since:${a.address}`, (n) => fmtSince(n - since), now))))
      .child(statusGlyph(t, shownStatus));
  }

  // An agent row with its tree: the children sit in a container under the row folded by the row's chevron.
  // A joined radar node is the agent's own row: its cost, tier, ask and PR lines sit on and under that row (no second session row).
  agentBlock(t, a, now, status, items, root = null) {
    const kids = items.length > 0;
    return Collapsible.new().flex().flex_col().flex_none().open(kids && !this.folded.has(`agent:${a.address}`))
      .child(this.agentLine(t, a, now, status, items, root))
      .children(root ? this.extras(t, root, 8, kids && !this.folded.has(`agent:${a.address}`) ? 16 : null) : [])
      .when(kids, (el) => el.content(this.childBody(t, items, 8)));
  }

  // "Open PRs": PRs no agent works on, one foldable group per repository (openPrGroup). Groups with a failing check or a conflict come
  // first and start open, drawing OPEN_PR_GROUP_LINES lines at most (the problem ones first) and then a "+N more" line; with more than
  // OPEN_PR_FOLD_AT PRs the others start folded. Folding by hand (`this.folded`, `this.unfolded`) lasts while Herdr is open. A group that fails to build is replaced by a plain row (its name and count), so one repository does not
  // take the section down.
  openPrRows(t, groups, age = "") {
    if (!groups.length) return [];
    this.folded ??= new Set();
    this.unfolded ??= new Set();
    const rows = [sectionHead(t, "op-head", "Open PRs", { rule: true })
      .when(age !== "", (el) => el.child(div().text_size(10).text_color(t.dim).child(age)))];
    const info = groups.map((g) => guard(() => openPrInfo(g), { g, prs: null, failing: 0, conflicts: 0 }));
    const total = info.reduce((n, i) => n + (i.prs?.length ?? 0), 0);
    const attention = (i) => i.failing > 0 || i.conflicts > 0;
    for (const i of [...info.filter(attention), ...info.filter((x) => !attention(x))]) {
      const auto = total > OPEN_PR_FOLD_AT && !attention(i);
      rows.push(this.prGuard(() => this.openPrGroup(t, i, auto), null) ?? this.openPrRowFallback(t, i.g));
    }
    return rows;
  }

  // One repository of Open PRs: a heading (chevron, name, "N PRs" with " · k failing" and " · c conflicts" when there are some) and, unless
  // folded, one line per PR. The heading row is the click target; the group's element keeps the id `op-<repo>` with its lines inside.
  openPrGroup(t, { g, prs, failing, conflicts }, auto) {
    const fid = `opg:${g.repo}`;
    this.expanded ??= new Set();
    const folded = this.folded.has(fid) || (auto && !this.unfolded.has(fid));
    const n = prs.length; // throws for a group without a PR list: the caller's fallback row takes it
    const toggle = (_e, cx) => {
      if (folded) { this.folded.delete(fid); this.unfolded.add(fid); } else { this.folded.add(fid); this.unfolded.delete(fid); this.expanded.delete(g.repo); }
      cx.notify();
    };
    const counts = h_flex().flex_none().text_size(10).text_color(t.dim).child(`${n} ${n === 1 ? "PR" : "PRs"}`)
      .when(failing > 0, (el) => el.child(div().text_color(t.blocked).child(` · ${failing} failing`)))
      .when(conflicts > 0, (el) => el.child(div().text_color(t.blocked).child(` · ${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`)));
    const head = h_flex().id(`oph-${g.repo}`).pl(8).pr(8).h(22).flex_none().gap(4).items_center().cursor_pointer()
      .hover((x) => x.bg(t.hover)).on_click(toggle)
      .child(this.foldSlot(t, fid, true, { folded }))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(g.repo))
      .child(counts);
    const group = v_flex().id(`op-${g.repo}`).flex_none().mt(5).pt(3).border_t(1).border_color(t.border).child(head);
    if (folded) return group;
    // A group open for a failing check or a conflict is capped: the conflicting PRs first (they are few and sort among the quiet ones), then the
    // failing, then the rest in order, then "+N more" until a click shows all.
    const capped = (failing > 0 || conflicts > 0) && n > OPEN_PR_GROUP_LINES && !this.expanded.has(g.repo);
    const shown = capped ? [...prs.filter(prConflict), ...prs.filter((p) => !prConflict(p) && prFailing(p)), ...prs.filter((p) => !prConflict(p) && !prFailing(p))].slice(0, OPEN_PR_GROUP_LINES) : prs;
    const numW = numberCellWidth(prs);
    const more = (_e, cx) => { this.expanded.add(g.repo); cx.notify(); };
    return group.child(v_flex().flex_none().pl(20).pr(8).gap(1)
      .children(shown.map((p) => this.prChip(t, p, p.href, `op-${g.repo}`, { title: p.title ?? "", numW })))
      .when(capped, (el) => el.child(h_flex().id(`opm-${g.repo}`).flex_none().h(18).px(4).items_center().rounded(4).cursor_pointer().text_size(10.5).text_color(t.dim)
        .hover((x) => x.bg(t.hover)).on_click(more).child(`+${n - shown.length} more`))));
  }

  // The plain row of a repository whose row failed to build: its name and how many PRs it has.
  openPrRowFallback(t, g) {
    const n = Array.isArray(g?.prs) ? g.prs.length : 0;
    return h_flex().id(`op-${g?.repo}`).pl(8).pr(8).py(2).flex_none().items_center().gap_x(5).text_size(11)
      .child(div().text_color(t.dim).truncate().max_w(140).child(String(g?.repo ?? "")))
      .child(div().text_color(t.dim).child(`${n} ${n === 1 ? "PR" : "PRs"}`));
  }

  // The legend: a "?" in the title bar; resting on it lists every PR dot with its words. The content is built only while the pointer rests there.
  legend(t) {
    const trigger = h_flex().id("legend-open").h(22).w(22).mr(4).items_center().justify_center().rounded(11).cursor_pointer().text_size(11).text_color(t.muted)
      .hover((el) => el.bg(t.hover).text_color(t.foreground))
      .on_hover((hovered, cx) => this.legendOver("trigger", hovered, cx))
      .child("?");
    return HoverCard.new("legend-card").open_delay(200).close_delay(200).anchor("top_center")
      .trigger(trigger).content(this.legendHot ? this.legendView(t).on_hover((hovered, cx) => this.legendOver("card", hovered, cx)) : div());
  }

  // The pointer is on the "?" or on the open card: the content stays while it is on either, and goes LEGEND_LEAVE_MS after it left both.
  legendOver(part, hovered, cx) {
    this.legendIn ??= new Set();
    if (hovered) this.legendIn.add(part); else this.legendIn.delete(part);
    if (this.legendIn.size > 0) { this.legendLeft = null; if (!this.legendHot) { this.legendHot = true; cx?.notify?.(); } } else this.legendLeft = Date.now();
  }

  legendView(t) {
    const rows = PR_LEGEND.map((e) => {
      const st = prDotState(e.sample);
      return h_flex().gap(6).items_center()
        .child(h_flex().flex_none().w(30).gap(2).items_center().child(e.key === "pr-conflict" ? conflictMark(t) : div().flex_none().size(11)).child(prDot(t, st)))
        .child(div().flex_1().min_w(0).child(e.words));
    });
    return v_flex().w(300).p(10).gap(4).bg(t.popover).border(1).border_color(t.border).rounded(8).text_size(11).text_color(t.muted)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("Pull request dots"))
      .children(rows);
  }

  render(cx) {
    if (this.renderOpen) this.renderBroke = true; // the previous render never reached its end
    this.renderOpen = true;
    const t = theme();
    // The feeds of all machines as one list, one entry per PR (a merge that fails falls back to the plain concatenation)
    const perMachine = [...this.radar.values()].map((r) => (r.ok ? r.openPrs : []));
    this.feed = this.prGuard(() => mergeFeeds(perMachine), perMachine.flat());
    const list = guard(() => (this.sample ? SAMPLE.agents : agents()).filter((a) => typeof a?.address === "string"), []);
    const listedStatus = new Map(list.map((a) => [a.address, a.status]));
    const all = guard(() => (this.sample ? SAMPLE.terminals : terminals()).filter((x) => x && typeof x === "object"), []);
    this.terms = all;
    const shown = guard(() => focused()?.agent, null);
    this.shown = shown;
    this.seenChips = new Set(); // the PR chips this render draws (see prChipRaw)
    this.clocks = new Map(); // the shown ages this render draws (see clock)
    const spaceList = guard(() => (this.sample ? SAMPLE.spaces : spaces()), []);
    // The window's measurements are legal from render by contract (typings.rs), so the hover-card placement reads the size here.
    this.vp = guard(() => globalThis.window?.viewport_size?.(), null) ?? this.vp;
    const now = Date.now();
    guard(() => this.track(list, now));
    this.clashes = guard(() => clashingTabs(list), new Set());
    // Deliberately app-global: the one order of the Agents list, the same from every copy.
    if (!this.sample) guard(() => setAgentOrder(list.map((a) => a.address)));

    // Join each machine's radar to its agents; the pid comes from the terminal record when it has one.
    const withPid = list.map((a) => ({ ...a, pid: all.find((x) => x.address === a.address)?.foreground?.pid ?? null }));
    const joined = new Map();
    const tops = [];
    this.machineOf = new Map();
    // A local session whose hc terminal is live is never ended (a late heartbeat only dims it): isEnded reads this mark.
    const liveTerms = new Set([...all.filter((x) => x.state === "live"), ...list].map((x) => x.address));
    for (const [key, rec] of this.radar) {
      if (!rec.ok) continue;
      for (const n of allSessions(rec.tree)) {
        this.machineOf.set(n, key);
        n.liveHc = key === "local" && !n.machine && Boolean(n.hcTerminal) && liveTerms.has(n.hcTerminal);
      }
      tops.push(...rec.tree);
      for (const [addr, n] of joinAgents(withPid, rec.tree, key === "local" ? null : key)) joined.set(addr, n);
    }
    // Pane-less child terminals (`hc run` sessions) join radar nodes the same way; such a node is drawn under its child line only.
    // Only the child terminals that get drawn (those under a listed agent) can join.
    const drawn = new Map(list.map((a) => [a.address, childTerminals(all, a.address)]));
    const kids = [...new Map([...drawn.values()].flat().map((r) => [r.term.address, r.term])).values()]
      .filter((x) => typeof x.address === "string" && !listedStatus.has(x.address));
    const childJoined = new Map();
    for (const [key, rec] of this.radar) {
      if (rec.ok) for (const [addr, n] of joinChildren(kids, rec.tree, key === "local" ? null : key, new Set([...joined.values(), ...childJoined.values()]))) childJoined.set(addr, n);
    }
    this.childPi = new Set(kids.filter((x) => x.app === "pi" || x.agent === "pi" || childJoined.has(x.address)).map((x) => x.address));
    const skip = new Set([...joined.values(), ...childJoined.values()]);
    // A remote session the local registry draws as a row: its hc records come from the remote terminal, polled while the row is drawn
    // (whatever local mirror terminals exist), and that terminal and its local mirror are no rows of their own.
    const localTree = this.radar.get("local")?.ok ? this.radar.get("local").tree : [];
    const remoteNodes = guard(() => remoteNodesOf(localTree), []);
    this.remoteTargets = new Set(remoteNodes.map((x) => x.target));
    // The ended ones: their live mirror is a dimmed row (hcChildItems); they are not polled.
    const endedNodes = guard(() => endedRemoteNodesOf(localTree), []);
    const recsOfNode = (n) => (remoteTarget(n) ? this.recs.get(remoteTarget(n))?.recs ?? [] : []);
    // The remote node joined to a registry node's remote terminal: its agents, runs and child sessions show under that node's row.
    const remoteOf = (n) => joined.get(remoteTarget(n)) ?? null;
    // Item 25: a session drawn as a joined row anywhere is not drawn again as a radar child (matched by key).
    const skipKeys = new Set([...skip].map((n) => n.key).filter(Boolean));
    // A listed agent that is an hc child of another one is drawn once, nested under its parent (see withRows), not as a top-level row.
    const nested = guard(() => nestedAgents(list, all), new Set());
    // A hand-made `hc attach` of a session radar shows (as a remote node) is no row of its own: that card is its row.
    const radarTargets = new Set();
    const knownMachines = new Set();
    for (const [key, rec] of this.radar) {
      if (!rec.ok) continue;
      for (const n of guard(() => allSessions(rec.tree), [])) {
        if (n.machine) knownMachines.add(n.machine);
        if (typeof n.hcTerminal === "string" && n.hcTerminal && (n.machine || key !== "local")) radarTargets.add(n.hcTerminal.includes("/") ? n.hcTerminal : `${n.machine || key}/${n.hcTerminal}`);
      }
    }
    for (const addr of guard(() => attachNests(list, all, radarTargets, (a) => this.recs.get(a)?.attach ?? ""), new Set())) nested.add(addr);
    // The local attach terminal a registry node stored (radar's `attach`) is that node's card, listed with a pane or not.
    for (const x of [...remoteNodes, ...endedNodes]) if (x.attach && list.some((a) => a.address === x.attach)) nested.add(x.attach);
    const twins = guard(() => remoteTwins(list, remoteNodes), new Set());
    const listedBy = new Map(list.map((a) => [a.address, a]));
    // `<machine>/<t>` targets already drawn as a session (radar nodes, listed agents): an attach of one is not drawn again.
    const drawnTargets = new Set(list.map((a) => a.address));
    for (const [key, rec] of this.radar) {
      if (!rec.ok) continue;
      for (const n of guard(() => allSessions(rec.tree), [])) {
        if (typeof n.hcTerminal !== "string" || !n.hcTerminal) continue;
        drawnTargets.add(key !== "local" && !n.hcTerminal.includes("/") ? `${key}/${n.hcTerminal}` : n.hcTerminal);
      }
    }
    const machineOf = (g) => spaceList.find((s) => s.id === g.space)?.machine ?? null;
    const header = (g, rule) => {
      const machine = machineOf(g);
      const rec = this.radar.get(machine ?? "local");
      const out = [sectionHead(t, g.id, g.label, { rule })];
      if (rec && !rec.ok && !(machine && knownMachines.has(machine))) out.push(div().px(8).h(18).flex_none().text_size(10.5).text_color(t.dim).child(`No foreman radar on ${machine ?? "this computer"} (set props.foreman)`));
      return out;
    };
    const recsOf = (a) => this.recs.get(a.address)?.recs ?? [];
    const statusOf = (a) => guard(() => agentStatus(a.status, joined.get(a.address) ?? null, recsOf(a)), a.status);
    const drawnItems = [];
    const withRows = (a) => {
      const f = joined.get(a.address);
      const resolve = (term) => {
        const tabbed = listedBy.get(term.address);
        if (tabbed) {
          return { node: joined.get(tabbed.address) ?? null, recs: recsOf(tabbed), own: tabbed.status, status: statusOf(tabbed), pane: tabbed.pane, label: stripPi(agentLabel(tabbed, this.clashes)) };
        }
        const node = childJoined.get(term.address) ?? null;
        const recs = this.recs.get(term.address)?.recs ?? [];
        const own = workerStatus(term.status, listedStatus.get(term.address));
        return { node, recs, own, attach: this.recs.get(term.address)?.attach ?? "", status: guard(() => agentStatus(own, node, recs), own) };
      };
      const live = guard(() => hcChildItems(all, a.address, resolve, { skip, skipKeys, drawnTargets, remoteNodes, endedNodes, recsOf: recsOfNode, remoteOf }), []);
      const { root, items } = guard(() => dropDrawnEndedMirrors(this.agentItems(f ?? null, listedStatus.get(a.address) ?? null, recsOf(a), skip, live, skipKeys, recsOfNode, remoteOf)), { root: null, items: [] });
      drawnItems.push(...(root ? [root] : []), ...items);
      const block = this.agentBlock(t, a, now, statusOf(a), items, root);
      return f ? [block, div().h(4).flex_none()] : [block];
    };
    // A remote terminal that a drawn registry node follows is no row of its own: that node's row shows it. The rows of
    // everything else are drawn first, so what registry rows are drawn is known; a twin none of them carries keeps its row.
    const candidates = list.filter((x) => !nested.has(x.address));
    const blocks = new Map(candidates.filter((a) => !twins.has(a.address)).map((a) => [a.address, withRows(a)]));
    const drawnRemote = drawnRemoteTargets(drawnItems);
    const kept = candidates.filter((a) => !(twins.has(a.address) && drawnRemote.has(a.address)));
    for (const a of kept) if (!blocks.has(a.address)) blocks.set(a.address, withRows(a));
    const rows = spaceGroups(kept).flatMap((g, i) => [...header(g, i > 0), ...g.members.flatMap((a) => blocks.get(a.address))]);
    // A child node counts as shown only where it is drawn (drawnItems): an ended one with nothing live below leaves the tree, and its PRs stay in Open PRs.
    const orphanGroups = this.prGuard(() => openPrGroups(this.feed, tops, shownSet([...joined.values()], drawnItems))
      .map((g) => ({ ...g, prs: this.enrich(g.prs) })), []);
    const listedAt = Math.max(0, ...[...this.radar.values()].map((r) => (r.ok && r.openPrsAt) || 0));
    const age = listedAt ? this.clock("open-prs-age", (n) => openPrsAge(listedAt, n), now) : "";
    rows.push(...this.prGuard(() => this.openPrRows(t, orphanGroups, age), []));
    const needs = list.filter((a) => statusOf(a) === "blocked").length;

    const title = h_flex().flex_none().items_end().h(38).px(14).pb(6)
      .child(div().text_size(12).font_semibold().text_color(t.dim).child("Agents"))
      .child(div().flex_1())
      .child(this.prGuard(() => this.legend(t), div()))
      .child(h_flex().id("plan-open").h(22).px(8).items_center().rounded(11).cursor_pointer().text_size(11).text_color(t.muted)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.press("plan-open", cx); this.openPanel(null, null); }).child(this.pressing("plan-open") ? "📄 Plan …" : "📄 Plan"));
    const empty = div().px(14).pb(4).text_size(12).text_color(t.dim).child("No agent status yet.");
    const scroller = v_flex().id("foreman-list").flex_1().min_h(0).px(6).gap(1)
      .overflow_y_scrollbar().mode("always").children(rows);
    const footer = h_flex().flex_none().items_center().h(26).px(14).text_size(10.5).text_color(t.dim)
      .child(`${list.length} agents · ${needs} need you`);

    // A hot chip this render did not draw is no longer hot: its card is not built any more.
    if (this.hotCard !== null && !this.seenChips.has(this.hotCard)) this.hotCard = null;
    const body = [title];
    if (list.length === 0) body.push(empty);
    body.push(scroller, footer);
    const view = v_flex().min_h(0).size_full().text_size(13).bg(t.chrome).border_t(1).border_color(t.border).children(body);
    this.renderOpen = false; // the render reached its end
    return view;
  }
}
