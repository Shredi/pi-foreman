// pi-foreman mod for herdr-app: an Agents view with the foreman rows built in under each agent that is a foreman session.
// Reads `foreman radar --json` and, per agent terminal, `hc get <terminal> --json` (exec, argv only; the child records of
// pi-subagents), joins on hcTerminal, never writes; `foreman prs poll` fetches.
// The other execs are `foreman prs poll --json` per machine and the platform opener on a PR chip click, after the URL passed the https rule (model.js).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Collapsible, HoverCard } from "gpui-base";
import { agents, terminals, focused, spaces, run, theme, setAgentOrder, exec, props, window, setShared, readTextFile, shared, layout, notify } from "herdr";
import {
  parseRadarDoc, buildTree, joinAgents, joinChildren, nestedAgents, sessionTree, hcChildItems, bareChildren, displayStatus, urgentStatus, detailLine, statusLine, prDotState, chipPrs, prCard, prCardHeight, placeCardBox, prTones, enrichPrs, openPrGroups, openPrsAge, shownSet,
  radarBinary, parseRecords, parseAttachTarget, remoteClick, attachNests, agentStatus, glyphSpec, isSafeHttpsUrl, openerArgv, openFailure, prUrl, fmtSince, workerStatus, childTerminals,
  slimRadar, joinPath, parseShowMeta, showRows, allSessions, findPanelBlock, clashingTabs, agentLabel, UNREVIEWED, remoteNodesOf, remoteTwins, remoteTarget, drawnRemoteTargets,
} from "./model.js";

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
// exec `timeout` (ms) per job; the Promise.race watchdogs stay as the backstop for an app that ignores the option (Herdr app 0.1.13)
const T_RADAR = 30000;
const T_PRS = 600000; // the cap of exec
const T_HC_LOCAL = 10000;
const T_HC_REMOTE = 15000;
const T_ATTACH = 15000;
const T_OPEN = 10000;
const SPINNER = "mods/workspace-chrome/spinner.svg";
const RING = "mods/pi-foreman/ring.svg";
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

// One dot per PR: the outer ring spins while a job runs, the inner fill says how the finished jobs went.
function prDot(t, st) {
  const color = tones(t)[st.fill];
  return div().relative().flex_none().size(14).mx(1)
    .when(st.ring, (el) => el.child(svg(RING).absolute().top(0).left(0).size(14).text_color(color).spin(1100)))
    .child(div().absolute().top(4).left(4).size(6).rounded(3).bg(color));
}

// Conflict marker, independent of the dot: a small red disc with a bang.
const conflictMark = (t) => h_flex().flex_none().size(11).rounded(6).bg(t.blocked).items_center().justify_center()
  .text_size(8).font_semibold().text_color(t.chrome).child("!");

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
    this.feed = []; // radar openPrs: twins of session PRs (title, description, jobs)
    this.folded = new Set(); // tree item ids the user folded
    this.radar = new Map(); // machine key -> {ok, tree, openPrs, tried}
    this.busy = new Map(); // key -> when its task started
    const given = guard(() => props() ?? p ?? {}, {});
    this.foremanProp = given.foreman;
    this.hcProp = given.hc;
    this.recs = new Map(); // agent address -> {recs, tried}
    this.childPi = new Set(); // pane-less pi child terminals (set by render), polled for records too
    this.remoteTargets = new Set(); // `<machine>/<t>` of the remote sessions drawn as registry rows (set by render), polled for records too
    this.noteSeen = new Map(); // `${machine}|${session key}` -> last note version seen on the radar
    this.shows = new Map(); // `${machine}|${dir}` -> what was read of a session's plan.json / note.json
    this.prsRan = new Map(); // busy key -> when its prs poll last ended
    this.noTimeout = false; // true once this copy's exec rejected the `timeout` option itself (Herdr app 0.1.13)
    this.failed = new Set(); // keys of runs whose last try failed: one error notice per failure, not per retry
    this.pressed = new Map(); // element id -> when it was clicked: the next render shows it pending (visible feedback, same frame)
    this.poll(cx);
    this.pollPrs(cx, Date.now());
    cx.timer.every(1000, (cx) => { this.poll(cx); this.pollPrs(cx, Date.now()); this.unpress(cx); });
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

  machines() {
    const names = guard(() => spaces().map((s) => s.machine).filter((m) => typeof m === "string" && m), []);
    return [null, ...new Set(names)];
  }

  // exec with a `timeout`. If the call throws or rejects because of the option itself (an app that predates it), it runs once more
  // without it and this copy stops passing it; every other rejection (no binary, a run stopped by the timeout) goes to the caller.
  async execT(command, args, options, timeout) {
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

  poll(cx) {
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
          const doc = r.code === 0 ? parseRadarDoc(r.stdout) : null;
          next = doc ? { ok: true, tree: buildTree(doc.nodes), nodes: doc.nodes, openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() } : null;
        } catch {
          next = null;
        }
        next = next ?? keepRadar(this.radar.get(key));
        this.radar.set(key, next);
        this.busy.delete(key);
        this.publish();
        cx.notify();
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
          this.shows.set(id, { hint, read: Date.now(), plan, note });
          this.busy.delete(bk);
          cx.notify();
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
        if (this.childPi.has(addr) || this.remoteTargets?.has(addr) || guard(() => agents().some((a) => a?.address === addr), false)) this.recs.set(addr, { recs, attach, tried: Date.now() });
        cx.notify();
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

  // A PR is a chip: pill with the number, a conflict marker when it conflicts, and its one two-part dot; a click opens its
  // page when radar gave a URL (or a repository URL to derive it from). Resting on the chip opens the hover card.
  prChip(t, pr, href, key, more = []) {
    return guard(() => this.prChipRaw(t, pr, href, key, more), h_flex().flex_none().px(6).text_size(10.5).text_color(t.muted).child(`⎇ #${pr?.number ?? "?"}`));
  }

  // `more`: further PRs of the same row; the chip then reads "#n +k" and its hover card lists them.
  prChipRaw(t, pr, href, key, more) {
    const st = prDotState(pr);
    const chip = h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(9)
      .border(1).border_color(st.fill === "red" ? t.blocked : t.border).bg(t.raised)
      .text_size(10.5).font_medium().text_color(st.fill === "red" ? t.blocked : t.muted)
      .child(div().child(`⎇ #${pr.number}${more.length ? ` +${more.length}` : ""}`))
      .when(st.conflict, (el) => el.child(conflictMark(t)))
      .when(pr.unreviewed === true, (el) => el.child(div().text_color(tones(t).amber).child(UNREVIEWED)))
      .child(prDot(t, st));
    const c = { ...prCard(pr), more: more.length ? `also ${more.map((p) => `#${p.number}`).join(", ")}` : "" };
    const id = `pr-${key}-${pr.number}`;
    // The pointer on the chip tells where it is: the card goes below it, above it near the bottom, else beside it (never over it).
    const onMove = (e, cx) => guard(() => {
      // The size is the one render stored (this.vp); a live read from the handler refreshes it after a resize when the host allows it.
      const b = e?.bounds, pos = e?.position, loc = e?.local_position, vp = guard(() => globalThis.window?.viewport_size?.(), null) ?? this.vp;
      if (!b || !pos || !loc || !vp) return;
      const { anchor, maxH } = placeCardBox({ x: pos.x - loc.x, y: pos.y - loc.y, w: b.width, h: b.height }, { w: vp.width, h: vp.height }, { w: 300, h: prCardHeight(c) });
      this.cardAnchor ??= new Map();
      this.cardMaxH ??= new Map();
      if (this.cardAnchor.get(id) !== anchor || this.cardMaxH.get(id) !== maxH) { this.cardAnchor.set(id, anchor); this.cardMaxH.set(id, maxH); cx.notify?.(); }
    }, undefined);
    // The tooltip names the state in words (the dot's colours); the hover card adds the details.
    const trigger = chip.id(id).tooltip(c.state).on_mouse_move(onMove)
      .when(Boolean(href), (el) => el.cursor_pointer()
        .hover((x) => x.border_color(t.working).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation?.(); this.press(id, cx); this.openUrl(href, cx); }))
      .when(!href, (el) => el.on_click((_e, cx) => {
        cx.stop_propagation?.();
        guard(() => notify({ title: "No link for this pull request", body: `#${pr.number} has no page address yet.`, level: "info" }));
      }));
    // The id carries a hash of the card's content: a card is not reused when its content changed.
    return HoverCard.new(`card-${key}-${pr.number}-${hashOf(JSON.stringify(c))}`).open_delay(300).close_delay(200)
      .anchor(this.cardAnchor?.get(id) ?? "top_center")
      .trigger(trigger).content(guard(() => this.cardView(t, c, this.cardMaxH?.get(id)), div().child("")));
  }

  // The hover card of a PR: title, description excerpt, conflict line, the jobs grouped failed / running / passed.
  // `maxH` bounds the card to the room on its side of the chip; what does not fit is clipped (gpui-kit style.rs:95 max_h, gpui `overflow_hidden`).
  cardView(t, c, maxH = 0) {
    const color = tones(t);
    const tone = { failed: color.red, running: color.amber, passed: color.green };
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
      .when(Boolean(c.conflict), (el) => el.child(conflict)).child(jobs)
      .when(Boolean(c.more), (el) => el.child(div().text_color(t.dim).child(c.more)));
  }

  // Session PRs with the title, description and job names of their twin in radar's open-PRs list.
  enrich(prs) {
    return guard(() => enrichPrs(prs, this.feed), prs);
  }

  // The PR chips of a session row, on the right of its title row for every row: up to two chips, more as one chip "#n +k".
  rowChips(t, item) {
    const { chips, more } = chipPrs(item.prs ?? []);
    const shown = this.enrich(chips);
    const rest = this.enrich(more);
    return shown.map((p) => this.prChip(t, p, prUrl(item.node, p), item.id, rest).mr(3));
  }

  // The one tree below a paned agent: its own agents (radar runs, hc records), its child sessions (radar children and joined
  // pane-less hc terminals) and theirs, all through sessionTree. `f` is the joined radar node or null; `live` the
  // hc child items of the agent.
  agentItems(f, hcStatus, recs, skip, live, skipKeys, recsOf = null, remoteOf = null) {
    if (!f) return { root: null, items: bareChildren(recs, live) };
    const root = sessionTree(f, { hcStatus, recs, recsOf, remoteOf, skip, skipKeys, extra: live });
    return { root, items: root ? root.children : [] };
  }

  // The fold slot of a row with children: an svg chevron.
  foldSlot(t, id, kids) {
    const folded = this.folded.has(id);
    return h_flex().flex_none().size(16).items_center().justify_center().rounded(4)
      .when(kids, (el) => el.id(`fold:${id}`).cursor_pointer().hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { if (this.folded.has(id)) this.folded.delete(id); else this.folded.add(id); cx.notify(); }))
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

  // Under a session row: the show, ask / background / wait lines of its node (the PR chips sit in the row, see nodeRow).
  // `x` is the left of the connector line when children follow (see rail): every extras row then carries it, so the line runs
  // unbroken from the row's chevron through these rows to the first child.
  extras(t, item, ind, x = null) {
    if (item.type !== "session") return [];
    const detail = detailLine(item.node, item.recs);
    const line = statusLine(detail);
    const blocked = detail.blocked;
    const shows = item.node?.show ? showRows(item.node.show, this.shows?.get(`${this.machineOf?.get(item.node) ?? "local"}|${item.node.show.dir}`), Date.now()) : [];
    const rows = [
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
    const name = div().id(nameId).flex_1().min_w(0).truncate().text_color(nameOn ? t.working : item.dim ? t.dim : active ? t.foreground : root ? t.foreground : t.muted).child(nameOn ? `${stripPi(item.label)} …` : stripPi(item.label));
    return row
      .when(active && root, (el) => el.bg(t.raised).rounded(6)) // a card carries the selection itself (see node)
      .child(item.address !== undefined ? name.cursor_pointer().on_click((_e, cx) => { this.press(nameId, cx); return item.pane === undefined ? run("terminal.peek", { terminal: item.address }) : run("pane.focus", { pane: item.pane }); })
        : item.node?.machine && item.node?.hcTerminal ? name.cursor_pointer().on_click((_e, cx) => { this.press(nameId, cx); this.openRemote(item.node, cx); }) : name)
      .when(Boolean(item.elsewhere), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(item.elsewhere)))
      .when(Boolean(item.tier), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(item.tier)))
      .when(Boolean(item.costText), (el) => el.child(div().mr(3).text_size(11).text_color(root ? t.muted : t.dim).child(item.costText)))
      .when(root && item.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${item.sessions} sessions`)))
      .children(guard(() => this.rowChips(t, item), []))
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
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(fmtSince(now - since))))
      .children(root ? guard(() => this.rowChips(t, root), []) : [])
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

  // "Open PRs": PRs no agent works on, one row per repo.
  openPrRows(t, groups, age = "") {
    if (!groups.length) return [];
    const rows = [h_flex().id("op-head").px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(11).font_medium()
      .child(div().text_color(t.dim).child("Open PRs"))
      .when(age !== "", (el) => el.child(div().text_size(10).text_color(t.dim).child(age)))];
    for (const g of groups) {
      rows.push(h_flex().id(`op-${g.repo}`).pl(8).pr(8).py(2).flex_none().flex_wrap().items_center().gap_x(5).gap_y(4).text_size(11)
        .child(div().text_color(t.dim).truncate().max_w(140).child(g.repo))
        .children(g.prs.map((p) => this.prChip(t, p, p.href, `op-${g.repo}`)))
        .children(g.prs.filter((p) => p.title).slice(0, 1).map((p) => div().min_w(0).truncate().text_color(t.dim).child(p.title))));
    }
    return rows;
  }

  render(cx) {
    const t = theme();
    this.feed = [...this.radar.values()].flatMap((r) => (r.ok ? r.openPrs : []));
    const list = guard(() => agents().filter((a) => typeof a?.address === "string"), []);
    const listedStatus = new Map(list.map((a) => [a.address, a.status]));
    const all = guard(() => terminals().filter((x) => x && typeof x === "object"), []);
    this.terms = all;
    const shown = guard(() => focused()?.agent, null);
    this.shown = shown;
    const spaceList = guard(() => spaces(), []);
    // The window's measurements are legal from render by contract (typings.rs), so the hover-card placement reads the size here.
    this.vp = guard(() => globalThis.window?.viewport_size?.(), null) ?? this.vp;
    const now = Date.now();
    guard(() => this.track(list, now));
    this.clashes = guard(() => clashingTabs(list), new Set());
    // Deliberately app-global: the one order of the Agents list, the same from every copy.
    guard(() => setAgentOrder(list.map((a) => a.address)));

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
    const groupsOf = (members) => {
      const out = [];
      for (const a of members) {
        const id = `sp-${a.space}`;
        const tail = out[out.length - 1];
        if (tail && tail.id === id) tail.members.push(a);
        else out.push({ id, space: a.space, label: a.space_name || "", members: [a] });
      }
      return out;
    };
    const machineOf = (g) => spaceList.find((s) => s.id === g.space)?.machine ?? null;
    const header = (g) => {
      const machine = machineOf(g);
      const rec = this.radar.get(machine ?? "local");
      const out = [h_flex().id(g.id).px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(11).font_medium()
        .child(div().truncate().text_color(t.dim).child(g.label))];
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
      const live = guard(() => hcChildItems(all, a.address, resolve, { skip, skipKeys, drawnTargets, remoteNodes, recsOf: recsOfNode, remoteOf }), []);
      const { root, items } = guard(() => this.agentItems(f ?? null, listedStatus.get(a.address) ?? null, recsOf(a), skip, live, skipKeys, recsOfNode, remoteOf), { root: null, items: [] });
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
    const rows = groupsOf(kept).flatMap((g) => [...header(g), ...g.members.flatMap((a) => blocks.get(a.address))]);
    const openPrs = [...this.radar.values()].flatMap((r) => (r.ok ? r.openPrs : []));
    const orphanGroups = guard(() => openPrGroups(openPrs, tops, shownSet([...joined.values(), ...childJoined.values()], drawnItems))
      .map((g) => ({ ...g, prs: this.enrich(g.prs) })), []);
    const listedAt = Math.max(0, ...[...this.radar.values()].map((r) => (r.ok && r.openPrsAt) || 0));
    rows.push(...guard(() => this.openPrRows(t, orphanGroups, listedAt ? openPrsAge(listedAt, now) : ""), []));
    const needs = list.filter((a) => statusOf(a) === "blocked").length;

    const title = h_flex().flex_none().items_end().h(38).px(14).pb(6)
      .child(div().text_size(12).font_semibold().text_color(t.dim).child("Agents"))
      .child(div().flex_1())
      .child(h_flex().id("plan-open").h(22).px(8).items_center().rounded(11).cursor_pointer().text_size(11).text_color(t.muted)
        .hover((el) => el.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.press("plan-open", cx); this.openPanel(null, null); }).child(this.pressing("plan-open") ? "📄 Plan …" : "📄 Plan"));
    const empty = div().px(14).pb(4).text_size(12).text_color(t.dim).child("No agent status yet.");
    const scroller = v_flex().id("foreman-list").flex_1().min_h(0).px(6).gap(1)
      .overflow_y_scrollbar().mode("always").children(rows);
    const footer = h_flex().flex_none().items_center().h(26).px(14).text_size(10.5).text_color(t.dim)
      .child(`${list.length} agents · ${needs} need you`);

    const body = [title];
    if (list.length === 0) body.push(empty);
    body.push(scroller, footer);
    return v_flex().min_h(0).size_full().text_size(13).bg(t.chrome).border_t(1).border_color(t.border).children(body);
  }
}
