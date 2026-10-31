// pi-foreman mod for herdr-app: an Agents view with the foreman rows built in under each agent that is a foreman session.
// Reads `foreman radar --json` and, per agent terminal, `hc get <terminal> --json` (exec, argv only; the child records of
// pi-subagents), joins on hcTerminal, never writes, never fetches.
// The only other exec is the platform opener on a PR chip click, after the URL passed the https rule (model.js).

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, focused, spaces, run, theme, setAgentOrder, exec, props, window } from "herdr";
import {
  parseRadarDoc, buildTree, joinAgents, sessionRows, treeItems, openPrGroups, openPrsAge, shownNodes,
  radarBinary, parseRecords, agentStatus, agentsText, agentLines, glyphSpec, isSafeHttpsUrl, openerArgv, prUrl, fmtSince, workerStatus, childTerminals,
} from "./model.js";

const LOCAL_MS = 3000;
const REMOTE_MS = 15000;
const RETRY_MS = 30000;
const SPINNER = "mods/workspace-chrome/spinner.svg";

// Program logo at a square size; tinted logos are vector art that takes the text colour.
function progIcon(program, px, ink) {
  const src = program && program.icon;
  if (!src) return null;
  const logo = program.tint ? svg(src).text_color(ink).size(px) : image(src).w(px).h(px);
  return logo.flex_none();
}

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

function checkDot(t, state) {
  const color = state === "ok" ? (t.done ?? t.working) : state === "fail" ? t.blocked : t.dim;
  return div().size(7).mx(1).flex_none().rounded(4)
    .when(state === "pending", (el) => el.border(1.5).border_color(color))
    .when(state !== "pending", (el) => el.bg(color));
}

// Tree guides, one cell per depth. A mark is "│" (a sibling continues), "├" / "└" (this row hangs here) or "" (blank).
const CELL = { "│": { side: true, foot: false }, "├": { side: true, foot: true }, "└": { side: true, foot: true } };
function guideCells(t, marks) {
  return marks.map((mark) => {
    const look = CELL[mark] ?? { side: false, foot: false };
    let cell = div().flex_none().self_start().w(9).h(17).mt(-4).mr(4);
    if (look.side) cell = cell.border_l(1.5).border_color(t.input);
    if (look.foot) cell = cell.border_b(1.5).rounded_bl(6);
    return cell;
  });
}

// Marks of a childTerminals row: blank or a line for each ancestor level, an elbow for the row itself.
function childMarks(last) {
  return last.map((isLast, level) => (level < last.length - 1 ? (isLast ? "" : "│") : isLast ? "└" : "├"));
}

const guard = (f, fallback) => { try { return f(); } catch { return fallback; } };

export default class ForemanAgents extends View {
  init(p, cx) {
    this.changed = {};
    this.radar = new Map(); // machine key -> {ok, tree, openPrs, tried}
    this.busy = new Set();
    const given = guard(() => props() ?? p ?? {}, {});
    this.foremanProp = given.foreman;
    this.hcProp = given.hc;
    this.recs = new Map(); // agent address -> {recs, tried}
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
      if (this.busy.has(key) || (rec && now - rec.tried < every)) continue;
      this.busy.add(key);
      cx.spawn(async (cx) => {
        let next;
        try {
          const r = await exec(radarBinary(this.foremanProp, machine), ["radar", "--json"], { on: machine });
          const doc = r.code === 0 ? parseRadarDoc(r.stdout) : null;
          next = doc ? { ok: true, tree: buildTree(doc.nodes), openPrs: doc.openPrs, openPrsAt: doc.openPrsAt ?? null, tried: Date.now() } : { ok: false, tried: Date.now() };
        } catch {
          next = { ok: false, tried: Date.now() };
        }
        this.radar.set(key, next);
        this.busy.delete(key);
        cx.notify();
      });
    }
    this.pollRecords(cx, now);
  }

  // One `hc get` per agent terminal per interval; a failure leaves no records.
  pollRecords(cx, now) {
    const list = guard(() => agents().map((a) => a?.address).filter((x) => typeof x === "string" && x), []);
    for (const addr of this.recs.keys()) if (!list.includes(addr)) this.recs.delete(addr);
    for (const addr of list) {
      const rec = this.recs.get(addr);
      const cut = addr.indexOf("/");
      const machine = cut > 0 ? addr.slice(0, cut) : null;
      if (this.busy.has(`hc:${addr}`) || (rec && now - rec.tried < (machine ? REMOTE_MS : LOCAL_MS))) continue;
      this.busy.add(`hc:${addr}`);
      cx.spawn(async (cx) => {
        let recs = [];
        try {
          const r = await exec(radarBinary(this.hcProp, machine, "hc"), ["get", addr.slice(cut + 1), "--json"], { on: machine });
          if (r.code === 0) recs = parseRecords(r.stdout);
        } catch { /* no hc here: no records */ }
        this.recs.set(addr, { recs, tried: Date.now() });
        this.busy.delete(`hc:${addr}`);
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

  // A PR is a chip: pill with the number and the check dots, red border on a failing check; a click opens its page when
  // radar gave a URL (or a repository URL to derive it from), else the chip is plain.
  prChip(t, pr, href, key) {
    const failed = pr.checks.includes("fail");
    const chip = h_flex().flex_none().h(18).px(6).gap(3).items_center().rounded(9)
      .border(1).border_color(failed ? t.blocked : t.border).bg(t.raised)
      .text_size(10.5).font_medium().text_color(failed ? t.blocked : t.muted)
      .child(div().child(`⎇ #${pr.number}`))
      .children(pr.checks.map((c) => checkDot(t, c)));
    if (!href) return chip;
    return chip.id(`pr-${key}-${pr.number}`).cursor_pointer()
      .hover((x) => x.border_color(t.working).text_color(t.foreground))
      .on_click((_e, cx) => this.openUrl(href, cx));
  }

  // A PR line: every chip, wrapping onto further lines; a summary after them.
  prLine(t, node, prs, summary, key, indent) {
    return h_flex().pl(indent).pr(8).py(2).flex_none().flex_wrap().items_center().gap_x(5).gap_y(4).text_size(11)
      .children(prs.map((p) => this.prChip(t, p, prUrl(node, p), key)))
      .when(Boolean(summary), (el) => el.child(div().text_color(t.dim).child(summary)));
  }

  // One short line per running async agent: small spinner (red when blocked), then the text.
  agentRows(t, lines, indent) {
    return lines.map((l) => h_flex().pl(indent).pr(8).h(18).flex_none().items_center().gap(5).text_size(11)
      .child(l.glyph ? svg(SPINNER).size(9).flex_none().text_color(l.glyph === "blocked" ? t.blocked : t.working).spin(900) : div().flex_none().w(9))
      .child(div().flex_1().truncate().text_color(l.glyph === "blocked" ? t.blocked : t.muted).child(l.text)));
  }

  topRows(t, node, hcStatus = null, recs = []) {
    const r = sessionRows(node, hcStatus, recs);
    const line = () => h_flex().pl(33).pr(8).h(20).flex_none().items_center().gap(4).text_size(11.5);
    const rows = [line()
      .child(div().truncate().text_color(t.foreground).child(r.label))
      .when(Boolean(r.tier), (el) => el.child(div().ml(4).text_size(10.5).text_color(t.dim).child(r.tier)))
      .child(div().flex_1())
      .when(Boolean(r.costText), (el) => el.child(div().text_color(t.muted).child(r.costText)))
      .when(r.sessions > 1, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${r.sessions} sessions`)))];
    if (r.ask) rows.push(line().child(div().truncate().text_color(r.blocked ? t.blocked : t.muted).child(r.ask)));
    rows.push(...this.agentRows(t, agentLines(node, recs), 41));
    if (r.prs.length) rows.push(this.prLine(t, node, r.prs, r.summary, node.key || node.name, 33));
    return rows;
  }

  treeRows(t, node, skip) {
    return treeItems(node, skip).flatMap((it, i) => {
      if (it.worker) {
        return [h_flex().pl(39).pr(8).h(24).flex_none().items_center().text_size(12)
          .children(guideCells(t, it.lines))
          .child(div().flex_1().truncate().text_color(t.muted).child(it.label))
          .child(it.running ? svg(SPINNER).size(10).mx(2).flex_none().text_color(t.working).spin(900) : statusGlyph(t, it.status))];
      }
      const key = `${it.node.key || it.node.name}-${i}`;
      const row = h_flex().pl(39).pr(8).h(26).flex_none().items_center().text_size(12.5)
        .children(guideCells(t, it.lines))
        .child(div().flex_1().truncate().text_color(t.foreground).child(it.label))
        .when(Boolean(it.costText), (el) => el.child(div().mr(6).text_size(11).text_color(t.dim).child(it.costText)))
        .children(it.inline.map((p) => this.prChip(t, p, prUrl(it.node, p), key).mr(6)))
        .child(statusGlyph(t, it.status));
      const agents = this.agentRows(t, it.agents, 39 + it.lines.length * 13 + 8);
      const below = it.below.length ? [this.prLine(t, it.node, it.below, "", key, 39 + it.lines.length * 13)] : [];
      return [row, ...agents, ...below];
    });
  }

  // One live hc child terminal: guides, optional logo, name, status.
  childLine(t, row, shown, listed) {
    const k = row.term;
    const active = k.address === shown;
    const logo = progIcon(k.program, 14, t.foreground);
    const label = k.name || k.program?.name || k.template || k.address;
    const line = h_flex().id(`child:${k.address}`).flex_none().h(26).pl(40).pr(8).items_center().rounded(8).text_size(12.5);
    return line
      .hover((el) => el.bg(t.hover))
      .when(active, (el) => el.bg(t.raised))
      .on_click(() => run("terminal.peek", { terminal: k.address }))
      .children(guideCells(t, childMarks(row.last)))
      .when(logo !== null, (el) => el.child(div().mr(7).child(logo)))
      .child(div().flex_1().truncate().text_color(active ? t.foreground : t.muted).child(label))
      .child(statusGlyph(t, workerStatus(k.status, listed.get(k.address))));
  }

  // One agent of the list: logo, name, machine tag, time in this status, status.
  agentLine(t, a, now, status) {
    const logo = progIcon(a.program, 16, t.foreground);
    const host = a.address.includes("/") ? a.address.slice(0, a.address.indexOf("/")) : "";
    const since = this.changed[a.address]?.at;
    const quiet = a.status === "idle" && !a.focused;
    const tab = typeof a.tab_name === "string" && !/^\d+$/.test(a.tab_name) ? a.tab_name : "";
    const name = tab || a.title || a.program?.name || a.address;
    const focusPane = () => run("pane.focus", { pane: a.pane });
    const row = h_flex().id(`agent:${a.address}`).flex_none().h(30).px(8).gap(9).items_center().rounded(8).cursor_pointer();
    return row
      .when(a.focused === true, (el) => el.bg(t.selected))
      .hover((el) => el.bg(t.hover))
      .on_click(focusPane)
      .when(logo !== null, (el) => el.child(logo))
      .child(div().flex_1().min_w(0).truncate().text_color(quiet ? t.muted : t.foreground).child(name))
      .when(host !== "", (el) => el.child(div().text_size(10).text_color(t.dim).child(host)))
      .when(Boolean(since), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(fmtSince(now - since))))
      .child(statusGlyph(t, status));
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
    const list = guard(() => agents().filter((a) => typeof a?.address === "string"), []);
    const listedStatus = new Map(list.map((a) => [a.address, a.status]));
    const all = guard(() => terminals().filter((x) => x && typeof x === "object"), []);
    const shown = guard(() => focused()?.agent, null);
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
    const skip = new Set(joined.values());
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
    const withRows = (a) => {
      const f = joined.get(a.address);
      const head = this.agentLine(t, a, now, statusOf(a));
      const live = childTerminals(all, a.address).map((row) => this.childLine(t, row, shown, listedStatus));
      if (!f) {
        const text = guard(() => agentsText(null, recsOf(a)), "");
        const line = text ? [h_flex().pl(33).pr(8).h(20).flex_none().items_center().text_size(11.5).child(div().truncate().text_color(t.muted).child(text))] : [];
        return [head, ...line, ...guard(() => this.agentRows(t, agentLines(null, recsOf(a)), 41), []), ...live];
      }
      const foreman = [...guard(() => this.topRows(t, f, listedStatus.get(a.address) ?? null, recsOf(a)), []), ...guard(() => this.treeRows(t, f, skip), [])];
      return [head, ...foreman, ...live, div().h(4).flex_none()];
    };
    const rows = groups.flatMap((g) => [...header(g), ...g.members.flatMap(withRows)]);
    const openPrs = [...this.radar.values()].flatMap((r) => (r.ok ? r.openPrs : []));
    const orphanGroups = guard(() => openPrGroups(openPrs, tops, shownNodes(joined)), []);
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
