// pi-foreman mod for herdr-app: an Agents view with the foreman rows built in under each agent that is a foreman session.
// Reads `foreman radar --json` and, per agent terminal, `hc get <terminal> --json` (exec, argv only; the child records of
// pi-subagents), joins on hcTerminal, never writes, never fetches.
// The only other exec is the platform opener on a PR chip click, after the URL passed the https rule (model.js).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Collapsible, HoverCard } from "gpui-base";
import { agents, terminals, focused, spaces, run, theme, setAgentOrder, exec, props, window } from "herdr";
import {
  parseRadarDoc, buildTree, joinAgents, joinChildren, sessionTree, hcChildItems, bareChildren, displayStatus, urgentStatus, detailLine, prDotState, prCard, prTones, enrichPrs, openPrGroups, openPrsAge, shownNodes, shownKeys,
  radarBinary, parseRecords, agentStatus, glyphSpec, isSafeHttpsUrl, openerArgv, prUrl, fmtSince, workerStatus, childTerminals,
} from "./model.js";

const LOCAL_MS = 3000;
const REMOTE_MS = 15000;
const RETRY_MS = 30000;
const STUCK_MS = 45000; // a poll older than this is taken as lost
const WATCHDOG_MS = 35000; // a radar exec older than this is given up
const SPINNER = "mods/workspace-chrome/spinner.svg";
const RING = "mods/pi-foreman/ring.svg";
const CHEVRON = { open: "mods/workspace-chrome/chevron-down.svg", closed: "mods/workspace-chrome/chevron-right.svg" };
const AGENT_ICON = "mods/pi-foreman/agent.svg";
const LINE = 14; // width of one connector cell

// Pi is the only harness: its logo and a leading "π - " in a terminal title say nothing, so sessions carry neither. Only agent
// rows (subagent runs) carry an icon.
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
    this.poll(cx);
    cx.timer.every(1000, (cx) => this.poll(cx));
  }

  machines() {
    const names = guard(() => spaces().map((s) => s.machine).filter((m) => typeof m === "string" && m), []);
    return [null, ...new Set(names)];
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
            exec(radarBinary(this.foremanProp, machine), ["radar", "--json"], { on: machine }),
            cx.sleep(WATCHDOG_MS).then(() => ({ code: -1, stdout: "" })),
          ]);
          const doc = r.code === 0 ? parseRadarDoc(r.stdout) : null;
          next = doc ? { ok: true, tree: buildTree(doc.nodes), openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() } : null;
        } catch {
          next = null;
        }
        next = next ?? keepRadar(this.radar.get(key));
        this.radar.set(key, next);
        this.busy.delete(key);
        cx.notify();
      });
    }
    this.pollRecords(cx, now);
  }

  // One `hc get` per agent terminal per interval; a failure leaves no records.
  pollRecords(cx, now) {
    // Only pi terminals (listing field `app`) can have pi-subagents records.
    const paned = guard(() => agents().filter((a) => a?.app === "pi").map((a) => a.address).filter((x) => typeof x === "string" && x), []);
    const list = [...new Set([...paned, ...this.childPi])];
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
        try {
          const r = await exec(radarBinary(this.hcProp, machine, "hc"), ["get", addr.slice(cut + 1), "--json"], { on: machine });
          if (r.code === 0) recs = parseRecords(r.stdout);
        } catch { /* no hc here: no records */ }
        this.busy.delete(`hc:${addr}`);
        if (this.childPi.has(addr) || guard(() => agents().some((a) => a?.address === addr), false)) this.recs.set(addr, { recs, tried: Date.now() });
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

  openUrl(url, cx) {
    if (!isSafeHttpsUrl(url)) return;
    const p = guard(() => window().platform, "");
    const argv = openerArgv(p === "macos" ? "darwin" : p === "windows" ? "win32" : "linux", url);
    if (!argv) return;
    cx.spawn(async () => { try { await exec(argv[0], argv.slice(1)); } catch { /* no opener: nothing to do */ } });
  }

  // A PR is a chip: pill with the number, a conflict marker when it conflicts, and its one two-part dot; a click opens its
  // page when radar gave a URL (or a repository URL to derive it from). Resting on the chip opens the hover card.
  prChip(t, pr, href, key) {
    return guard(() => this.prChipRaw(t, pr, href, key), h_flex().flex_none().px(6).text_size(10.5).text_color(t.muted).child(`⎇ #${pr?.number ?? "?"}`));
  }

  prChipRaw(t, pr, href, key) {
    const st = prDotState(pr);
    const chip = h_flex().flex_none().h(18).px(6).gap(4).items_center().rounded(9)
      .border(1).border_color(st.fill === "red" ? t.blocked : t.border).bg(t.raised)
      .text_size(10.5).font_medium().text_color(st.fill === "red" ? t.blocked : t.muted)
      .child(div().child(`⎇ #${pr.number}`))
      .when(st.conflict, (el) => el.child(conflictMark(t)))
      .child(prDot(t, st));
    const trigger = !href ? chip : chip.id(`pr-${key}-${pr.number}`).cursor_pointer()
      .hover((x) => x.border_color(t.working).text_color(t.foreground))
      .on_click((_e, cx) => this.openUrl(href, cx));
    // The id carries a hash of the card's content: a card is not reused when its content changed.
    const c = prCard(pr);
    return HoverCard.new(`card-${key}-${pr.number}-${hashOf(JSON.stringify(c))}`).open_delay(300).close_delay(200)
      .trigger(trigger).content(guard(() => this.cardView(t, c), div().child("")));
  }

  // The hover card of a PR: title, description excerpt, conflict line, the jobs grouped failed / running / passed.
  cardView(t, c) {
    const color = tones(t);
    const tone = { failed: color.red, running: color.amber, passed: color.green };
    const shell = v_flex().w(300).p(10).gap(7).bg(t.popover).border(1).border_color(t.border).rounded(8)
      .text_size(11).text_color(t.muted);
    const title = div().text_size(12).font_semibold().text_color(t.foreground).child(c.title);
    const excerpt = div().text_color(t.muted).child(c.excerpt);
    const conflict = h_flex().gap(5).items_center().text_color(t.blocked).child(conflictMark(t)).child(c.conflict);
    const jobs = v_flex().gap(5)
      .children(c.groups.map((g) => v_flex().gap(2)
        .child(h_flex().gap(5).items_center().font_semibold().text_color(tone[g.key])
          .child(div().flex_none().size(6).rounded(3).bg(tone[g.key])).child(`${g.label} (${g.count})`))
        .children(g.names.map((n) => div().pl(11).truncate().child(n)))
        .when(g.more > 0, (el) => el.child(div().pl(11).text_color(t.dim).child(`+${g.more} more`)))))
      .when(c.groups.length === 0, (el) => el.child(div().text_color(t.dim).child("no job data")));
    return shell.child(title).when(Boolean(c.excerpt), (el) => el.child(excerpt))
      .when(Boolean(c.conflict), (el) => el.child(conflict)).child(jobs);
  }

  // Session PRs with the title, description and job names of their twin in radar's open-PRs list.
  enrich(prs) {
    return guard(() => enrichPrs(prs, this.feed), prs);
  }

  // A PR line: every chip, wrapping onto further lines; a summary after them.
  prLine(t, node, prs, summary, key, indent) {
    return h_flex().pl(indent).pr(8).py(2).flex_none().flex_wrap().items_center().gap_x(5).gap_y(4).text_size(11)
      .children(this.enrich(prs).map((p) => this.prChip(t, p, prUrl(node, p), key)))
      .when(Boolean(summary), (el) => el.child(div().text_color(t.dim).child(summary)));
  }

  // The one tree below a paned agent: its own agents (radar runs, hc records), its child sessions (radar children and joined
  // pane-less hc terminals) and theirs, all through sessionTree. `f` is the joined radar node or null; `live` the
  // hc child items of the agent.
  agentItems(f, hcStatus, recs, skip, live) {
    if (!f) return { root: null, items: bareChildren(recs, live) };
    const root = sessionTree(f, { hcStatus, recs, skip, extra: live });
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
  link(t, item, last) {
    const h = item.type === "session" ? 26 : 20;
    const mid = Math.floor(h / 2);
    const ink = t.dim + "66";
    const head = div().id(`conn:${last ? "elbow" : "tee"}:${item.id}`).relative().flex_none().w(LINE).h(h)
      .when(!last, (el) => el.child(div().absolute().top(0).left(6).w(1).h(h).bg(ink)).child(div().absolute().top(mid).left(7).w(LINE - 7).h(1).bg(ink)))
      .when(last, (el) => el.child(div().absolute().top(0).left(6).w(LINE - 6).h(mid + 1).border_l(1).border_b(1).border_color(ink).rounded_bl(4)));
    const pass = div().id(`conn:pass:${item.id}`).relative().flex_1().w(LINE)
      .child(div().absolute().top(0).bottom(0).left(6).w(1).bg(ink));
    const column = v_flex().flex_none().w(LINE).self_stretch().child(head).when(!last, (el) => el.child(pass));
    return h_flex().flex_none().items_stretch().child(column).child(this.node(t, item, 0).flex_1().min_w(0));
  }

  // Under a session row: the ask / background / wait line of its node and its PR chips (all on a line at the top, more than
  // two on a line below for the others).
  extras(t, item, ind) {
    if (item.type !== "session") return [];
    const root = item.top === true;
    const line = detailLine(item.node);
    const prs = root ? item.prs : item.below;
    return [
      ...(line.text ? [h_flex().pl(ind + 20).pr(8).h(20).flex_none().items_center().text_size(11.5)
        .child(div().truncate().text_color(line.blocked ? t.blocked : t.muted).child(line.text))] : []),
      ...(prs.length ? [this.prLine(t, item.node, prs, root ? item.summary : "", item.id, ind + 20)] : []),
    ];
  }

  // One tree row: fold slot (svg chevron), label, cost, PR chips, status glyph; folded, the glyph is the most urgent below.
  nodeRow(t, item, ind) {
    const root = item.top === true;
    const kids = item.children.length > 0;
    const slot = this.foldSlot(t, item.id, kids);
    const session = item.type === "session";
    const row = h_flex().id(`row:${item.id}`).flex_none().h(session ? (root ? 22 : 26) : 20).pl(ind).pr(8).gap(3).items_center()
      .text_size(session ? 12.5 : 11)
      .child(slot);
    if (item.type === "more") return row.child(div().flex_1().truncate().text_color(t.dim).child(item.label));
    const glyphRight = statusGlyph(t, displayStatus(item, this.folded));
    if (!session) {
      return row.child(svg(AGENT_ICON).flex_none().size(12).text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(item.status === "blocked" ? t.blocked : t.muted).child(item.label))
        .child(glyphRight);
    }
    const active = item.address !== undefined && item.address === this.shown;
    const name = div().id(`name:${item.id}`).flex_1().min_w(0).truncate().text_color(active ? t.foreground : root ? t.foreground : t.muted).child(stripPi(item.label));
    return row
      .when(active, (el) => el.bg(t.raised).rounded(6))
      .child(item.address === undefined ? name : name.cursor_pointer().on_click(() => run("terminal.peek", { terminal: item.address })))
      .when(Boolean(item.tier), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(item.tier)))
      .when(Boolean(item.costText), (el) => el.child(div().mr(3).text_size(11).text_color(root ? t.muted : t.dim).child(item.costText)))
      .when(root && item.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${item.sessions} sessions`)))
      .children(root ? [] : this.enrich(item.inline).map((p) => this.prChip(t, p, prUrl(item.node, p), item.id).mr(3)))
      .child(glyphRight);
  }

  // A tree node: its row, its extras, and the children in a Collapsible.
  node(t, item, ind) {
    const kids = item.children.length > 0;
    const body = this.childBody(t, item.children, ind);
    return Collapsible.new().flex().flex_col().flex_none().open(kids && !this.folded.has(item.id))
      .child(this.nodeRow(t, item, ind))
      .children(this.extras(t, item, ind))
      .when(kids, (el) => el.content(body));
  }

  // One agent of the list: name, machine tag, time in this status, status.
  agentLine(t, a, now, status, items = [], root = null) {
    const kids = items.length > 0;
    const fid = `agent:${a.address}`;
    const host = a.address.includes("/") ? a.address.slice(0, a.address.indexOf("/")) : "";
    const since = this.changed[a.address]?.at;
    const quiet = a.status === "idle" && !a.focused;
    const tab = typeof a.tab_name === "string" && !/^\d+$/.test(a.tab_name) ? a.tab_name : "";
    const name = stripPi(tab || a.title) || a.program?.name || a.address;
    const focusPane = () => run("pane.focus", { pane: a.pane });
    const row = h_flex().id(`agent:${a.address}`).flex_none().h(30).px(8).gap(5).items_center().rounded(8).cursor_pointer();
    const shownStatus = kids && this.folded.has(fid) ? urgentStatus([status, ...items.map((c) => c.urgent)]) : status;
    return row
      .child(this.foldSlot(t, fid, kids))
      .when(a.focused === true, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(focusPane)
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(name))
      .when(Boolean(root?.tier), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(root.tier)))
      .when(Boolean(root?.costText), (el) => el.child(div().text_size(11).text_color(t.muted).child(root.costText)))
      .when(root !== null && root.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${root.sessions} sessions`)))
      .when(host !== "", (el) => el.child(div().text_size(10).text_color(t.dim).child(host)))
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(fmtSince(now - since))))
      .child(statusGlyph(t, shownStatus));
  }

  // An agent row with its tree: the children sit in a container under the row folded by the row's chevron.
  // A joined radar node is the agent's own row: its cost, tier, ask and PR lines sit on and under that row (no second session row).
  agentBlock(t, a, now, status, items, root = null) {
    const kids = items.length > 0;
    return Collapsible.new().flex().flex_col().flex_none().open(kids && !this.folded.has(`agent:${a.address}`))
      .child(this.agentLine(t, a, now, status, items, root))
      .children(root ? this.extras(t, root, 8) : [])
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
    const shown = guard(() => focused()?.agent, null);
    this.shown = shown;
    const spaceList = guard(() => spaces(), []);
    const now = Date.now();
    guard(() => this.track(list, now));
    guard(() => setAgentOrder(list.map((a) => a.address)));

    // Join each machine's radar to its agents; the pid comes from the terminal record when it has one.
    const withPid = list.map((a) => ({ ...a, pid: all.find((x) => x.address === a.address)?.foreground?.pid ?? null }));
    const joined = new Map();
    const tops = [];
    for (const [key, rec] of this.radar) {
      if (!rec.ok) continue;
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
    this.childPi = new Set(kids.filter((x) => x.app === "pi" || childJoined.has(x.address)).map((x) => x.address));
    const skip = new Set([...joined.values(), ...childJoined.values()]);
    const groups = [];
    for (const a of list) {
      const id = `sp-${a.space}`;
      const tail = groups[groups.length - 1];
      if (tail && tail.id === id) tail.members.push(a);
      else groups.push({ id, space: a.space, label: a.space_name || "", members: [a] });
    }
    const machineOf = (g) => spaceList.find((s) => s.id === g.space)?.machine ?? null;
    const header = (g) => {
      const machine = machineOf(g);
      const rec = this.radar.get(machine ?? "local");
      const out = [h_flex().id(g.id).px(8).pt(8).h(30).flex_none().gap(6).items_center().text_size(11).font_medium()
        .child(div().truncate().text_color(t.dim).child(g.label))];
      if (rec && !rec.ok) out.push(div().px(8).h(18).flex_none().text_size(10.5).text_color(t.dim).child(`No foreman radar on ${machine ?? "this computer"} (set props.foreman)`));
      return out;
    };
    const recsOf = (a) => this.recs.get(a.address)?.recs ?? [];
    const statusOf = (a) => guard(() => agentStatus(a.status, joined.get(a.address) ?? null, recsOf(a)), a.status);
    const drawnItems = [];
    const withRows = (a) => {
      const f = joined.get(a.address);
      const resolve = (term) => {
        const node = childJoined.get(term.address) ?? null;
        const recs = this.recs.get(term.address)?.recs ?? [];
        const own = workerStatus(term.status, listedStatus.get(term.address));
        return { node, recs, own, status: guard(() => agentStatus(own, node, recs), own) };
      };
      const live = guard(() => hcChildItems(all, a.address, resolve, { skip }), []);
      const { root, items } = guard(() => this.agentItems(f ?? null, listedStatus.get(a.address) ?? null, recsOf(a), skip, live), { root: null, items: [] });
      drawnItems.push(...(root ? [root] : []), ...items);
      const block = this.agentBlock(t, a, now, statusOf(a), items, root);
      return f ? [block, div().h(4).flex_none()] : [block];
    };
    const rows = groups.flatMap((g) => [...header(g), ...g.members.flatMap(withRows)]);
    const openPrs = [...this.radar.values()].flatMap((r) => (r.ok ? r.openPrs : []));
    const orphanGroups = guard(() => openPrGroups(openPrs, tops, new Set([...shownNodes(new Map([...joined, ...childJoined])), ...shownKeys(drawnItems)]))
      .map((g) => ({ ...g, prs: this.enrich(g.prs) })), []);
    const listedAt = Math.max(0, ...[...this.radar.values()].map((r) => (r.ok && r.openPrsAt) || 0));
    rows.push(...guard(() => this.openPrRows(t, orphanGroups, listedAt ? openPrsAge(listedAt, now) : ""), []));
    const needs = list.filter((a) => statusOf(a) === "blocked").length;

    const title = h_flex().flex_none().items_end().h(38).px(14).pb(6)
      .child(div().text_size(12).font_semibold().text_color(t.dim).child("Agents"));
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
