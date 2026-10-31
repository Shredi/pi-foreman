import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRadar, parseRadarDoc, buildTree, joinAgents, sessionRows, sortPrs, prSummary, splitPrs, prUrl, isSafeHttpsUrl,
  openerArgv, radarBinary, treeItems, openPrGroups, shownNodes, allSessions, fmtCost,
  fmtSince, workerStatus, childTerminals, glyphSpec,
} from "./model.js";

const cost = (c) => ({ in: 0, out: 0, cost: c, uncached: 0 });
const dot = (n, state, extra = {}) => ({ n, state, label: "ci", src: "pr", ...extra });
const session = (key, name, over = {}) => ({
  key, kind: "session", name, role: null, rung: null, state: "working", sym: "working", glyph: "working", paneId: null,
  hcTerminal: null, pid: null, cwd: null, age_s: 5, blocked_s: null, own: cost(0), tot: cost(0), children: [], waits: [], ...over,
});
const run = (name, role, model, over = {}) => ({
  key: `run:${name}`, kind: "run", name, role, rung: null, model, state: "working", glyph: "working", own: cost(0), tot: cost(0),
  ended_s: null, children: [], ...over,
});

// top (t1) -> mid (nested, t2) -> leaf (nested, no terminal); top has two workers; top has 3 PRs, mid 2, leaf 0
const doc = () => ({
  v: 1, roots: [
    session("fm-top", "top", {
      hcTerminal: "t1", pid: 100, own: cost(1.5), tier: "heavy",
      asks: [{ n: 3, topic: "approve plan" }], state: "blocked", glyph: "blocked", blocked_s: 130,
      dots: [dot(10, "ok"), dot(10, "ok"), dot(12, "fail"), dot(11, "run")],
      repoUrl: "https://example.test/acme/widgets",
      children: [
        run("builder", "builder", "claude-sonnet-4-5"),
        run("old", "reviewer", "opus", { ended_s: 3, state: "done" }),
        session("fm-mid", "mid", {
          hcTerminal: "t2", own: cost(2), dots: [dot(20, "ok"), dot(21, "run")],
          children: [session("fm-leaf", "leaf", { own: cost(0.25), state: "idle", glyph: "idle" })],
        }),
      ],
    }),
    session("fm-gone", "gone", { hcTerminal: "t9", state: "done", glyph: "idle", dots: [dot(30, "fail")], repoUrl: "https://example.test/acme/gadgets" }),
  ],
  openPrs: [
    { repo: "acme/gears", number: 7, title: "Tune gears", url: "https://example.test/acme/gears/pull/7", state: "open", checks: [{ n: 7, state: "ok", label: "ci" }] },
    { number: "x" }, null, { repo: "acme/gears" },
  ],
});
const text = () => JSON.stringify(doc());

test("parseRadar: bad input gives []", () => {
  for (const bad of ["", "nope", "null", "[]", "{}", '{"roots":5}', undefined, null, 42, '{"roots":[1,null,"x"]}']) {
    assert.deepEqual(parseRadar(bad), [], String(bad));
  }
  assert.equal(parseRadarDoc("nope"), null);
  assert.deepEqual(parseRadarDoc('{"roots":[]}'), { nodes: [], openPrs: [] });
});

test("parseRadar: normalizes nodes, PR dots grouped per PR", () => {
  const [top] = parseRadar(text());
  assert.equal(top.name, "top");
  assert.equal(top.hcTerminal, "t1");
  assert.equal(top.prs.length, 3);
  assert.deepEqual(top.prs.find((p) => p.number === 10).checks, ["ok", "ok"]);
  assert.deepEqual(top.prs.find((p) => p.number === 11).checks, ["pending"]);
});

test("buildTree: two nesting levels, top-most sessions only", () => {
  const tops = buildTree(parseRadar(text()));
  assert.deepEqual(tops.map((t) => t.name), ["top", "gone"]);
  const top = tops[0];
  assert.deepEqual(top.sessions.map((s) => s.name), ["mid"]);
  assert.deepEqual(top.workers.map((w) => w.name), ["builder", "old"]);
  assert.deepEqual(top.sessions[0].sessions.map((s) => s.name), ["leaf"]);
});

test("buildTree: parent links join flat roots, cycles are broken", () => {
  const d = { roots: [session("a", "a", { parent: "b" }), session("b", "b", { parent: "a" }), session("c", "c", { parent: "a" }), session("d", "d")] };
  const tops = buildTree(parseRadar(JSON.stringify(d)));
  assert.ok(tops.length >= 1);
  const flat = allSessions(tops);
  assert.equal(flat.length, 4);
  assert.equal(new Set(flat).size, 4);
  const linked = buildTree(parseRadar(JSON.stringify({ roots: [session("p", "p"), session("q", "q", { parent: "p" })] })));
  assert.deepEqual(linked.map((t) => t.name), ["p"]);
  assert.deepEqual(linked[0].sessions.map((s) => s.name), ["q"]);
});

test("joinAgents: hcTerminal, remote prefix, done filter, pid mismatch", () => {
  const tree = buildTree(parseRadar(text()));
  const agents = [{ address: "t1" }, { address: "t2" }, { address: "t9" }, { address: "t5" }, { address: "box/t1" }];
  const local = joinAgents(agents, tree);
  assert.deepEqual([...local.keys()].sort(), ["t1", "t2"]); // t9 is done, t5 unknown, box/t1 is remote
  assert.equal(local.get("t1").name, "top");
  const remote = joinAgents(agents, tree, "box");
  assert.deepEqual([...remote.keys()], ["box/t1"]);
  assert.equal(joinAgents([{ address: "t1", pid: 100 }], tree).size, 1);
  assert.equal(joinAgents([{ address: "t1", pid: 101 }], tree).size, 0); // both have a pid, they differ
  assert.equal(joinAgents([{ address: "t1", foreground: { pid: 101 } }], tree).size, 0);
  assert.equal(joinAgents([{ address: "t2", pid: 101 }], tree).size, 1); // node t2 has no pid
  assert.equal(joinAgents("bad", tree).size, 0);
  assert.equal(joinAgents(agents, null).size, 0);
});

test("sessionRows: label, tier, summed cost, session count, ask", () => {
  const [top] = buildTree(parseRadar(text()));
  const r = sessionRows(top);
  assert.equal(r.label, "top");
  assert.equal(r.tier, "heavy");
  assert.equal(r.cost, 3.75);
  assert.equal(r.costText, "$3.75");
  assert.equal(r.sessions, 3);
  assert.equal(r.ask, "ask 3: approve plan (2m)");
  assert.equal(r.blocked, true);
  assert.equal(r.status, "blocked");
  assert.deepEqual(r.prs.map((p) => p.number), [12, 11, 10]);
  assert.equal(r.summary, "3 PRs · 1 failing · 1 pending");
});

test("sessionRows: waits when nothing asks; empty input", () => {
  const n = buildTree(parseRadar(JSON.stringify({ roots: [session("w", "w", { waits: [{ note: "timer", kind: "t", age_s: 240 }, { note: "ci run", kind: "ci", age_s: 5 }, { kind: "x" }] })] })))[0];
  const r = sessionRows(n);
  assert.equal(r.ask, "wait: timer 4m · ci run 5s +1");
  assert.equal(r.blocked, false);
  assert.equal(r.sessions, 1);
  assert.equal(r.costText, "");
  assert.equal(sessionRows(null).label, "");
  assert.equal(fmtCost(150.4), "$150");
});

test("treeItems: workers then sessions, guides, finished workers dropped, skip", () => {
  const [top] = buildTree(parseRadar(text()));
  const items = treeItems(top);
  assert.deepEqual(items.map((i) => i.label), ["builder sonnet-4-5", "mid", "leaf"]);
  assert.deepEqual(items.map((i) => i.lines), [["├"], ["└"], ["", "└"]]);
  assert.equal(items[0].running, true);
  assert.equal(items[1].costText, "$2.00");
  assert.deepEqual(items[1].inline.map((p) => p.number), [21, 20]);
  assert.deepEqual(treeItems(top, new Set([top.sessions[0]])).map((i) => i.label), ["builder sonnet-4-5"]);
});

test("PR sort and summary for 0, 1, 2 and 5 PRs; inline split at 2", () => {
  const pr = (number, ...checks) => ({ number, checks });
  assert.equal(prSummary([]), "");
  assert.equal(prSummary(undefined), "");
  assert.equal(prSummary([pr(1, "ok")]), "1 PR · all green");
  assert.equal(prSummary([pr(1, "ok"), pr(2, "pending")]), "2 PRs · 1 pending");
  const five = [pr(1, "ok"), pr(2, "pending"), pr(3, "fail", "ok"), pr(4, "ok", "ok"), pr(5, "fail")];
  assert.deepEqual(sortPrs(five).map((p) => p.number), [5, 3, 2, 4, 1]);
  assert.equal(prSummary(five), "5 PRs · 2 failing · 1 pending");
  assert.deepEqual(sortPrs([]), []);
  assert.deepEqual(splitPrs([pr(1, "ok"), pr(2, "fail")]), { inline: [pr(2, "fail"), pr(1, "ok")], below: [] });
  assert.equal(splitPrs(five).inline.length, 0);
  assert.equal(splitPrs(five).below.length, 5);
  assert.deepEqual(splitPrs([]), { inline: [], below: [] });
});

test("isSafeHttpsUrl accept/reject table", () => {
  const ok = ["https://example.test/acme/widgets/pull/3", "https://example.test:8443/a/b?x=1#top", "https://a.test/p%20q"];
  const bad = [
    "http://example.test/a", "javascript:alert(1)", "https://example.test/a b", "https://example.test/a&b", "https://example.test/a|b",
    "https://example.test/a^b", "https://example.test/<a>", 'https://example.test/"a"', "https://example.test/'a'", "https://example.test/a\nb",
    "https://example.test/a\tb", "https://example.test/a\u0000", "https://", "https:///x", "HTTPS://example.test/", "", null, undefined, 5, {},
    "file:///etc/passwd", "https://example.test/`a`", "https://example.test/a\\b",
  ];
  for (const u of ok) assert.equal(isSafeHttpsUrl(u), true, u);
  for (const u of bad) assert.equal(isSafeHttpsUrl(u), false, String(u));
});

test("openerArgv per platform, never a shell", () => {
  const u = "https://example.test/acme/widgets/pull/3";
  assert.deepEqual(openerArgv("darwin", u), ["open", u]);
  assert.deepEqual(openerArgv("linux", u), ["xdg-open", u]);
  assert.deepEqual(openerArgv("win32", u), ["rundll32", "url.dll,FileProtocolHandler", u]);
  assert.equal(openerArgv("freebsd", u), null);
  assert.equal(openerArgv("darwin", "http://example.test/"), null);
  assert.equal(openerArgv("win32", "https://example.test/a&calc"), null);
});

test("prUrl: own URL, else https repository URL, else none", () => {
  const [top] = buildTree(parseRadar(text()));
  assert.equal(prUrl(top, top.prs.find((p) => p.number === 12)), "https://example.test/acme/widgets/pull/12");
  assert.equal(prUrl({}, { number: 4, checks: [] }), "");
  assert.equal(prUrl({ repoUrl: "http://example.test/x" }, { number: 4 }), "");
  assert.equal(prUrl({}, { number: 4, url: "https://example.test/x/pull/4" }), "https://example.test/x/pull/4");
  assert.equal(prUrl({}, { number: 4, url: "javascript:1" }), "");
  assert.equal(prUrl(null, null), "");
  // a repository given as ssh/git remote is not derived from
  const [n] = parseRadar(JSON.stringify({ roots: [session("r", "r", { repo: "git@example.test:acme/w.git", dots: [dot(1, "ok")] })] }));
  assert.equal(prUrl(n, n.prs[0]), "");
});

test("radarBinary: string, object by machine, default", () => {
  assert.equal(radarBinary("/opt/fm/foreman", null), "/opt/fm/foreman");
  assert.equal(radarBinary("/opt/fm/foreman", "box"), "foreman");
  assert.equal(radarBinary({ local: "/a/foreman", box: "/b/foreman" }, null), "/a/foreman");
  assert.equal(radarBinary({ local: "/a/foreman", box: "/b/foreman" }, "box"), "/b/foreman");
  assert.equal(radarBinary({ local: "/a/foreman" }, "other"), "foreman");
  assert.equal(radarBinary(undefined, null), "foreman");
  assert.equal(radarBinary(7, "x"), "foreman");
});

test("open PRs: openPrs parsed, malformed dropped, done and unjoined sessions land there, joined ones do not", () => {
  const parsed = parseRadarDoc(text());
  assert.equal(parsed.openPrs.length, 1);
  assert.equal(parsed.openPrs[0].number, 7);
  const tops = buildTree(parsed.nodes);
  const joined = joinAgents([{ address: "t1" }], tops);
  const groups = openPrGroups(parsed.openPrs, tops, shownNodes(joined));
  const flat = groups.flatMap((g) => g.prs.map((p) => [g.repo, p.number]));
  assert.deepEqual(flat.sort(), [["acme/gadgets", 30], ["acme/gears", 7]].sort());
  assert.equal(groups.find((g) => g.repo === "acme/gadgets").prs[0].href, "https://example.test/acme/gadgets/pull/30");
  assert.equal(groups.find((g) => g.repo === "acme/gears").prs[0].title, "Tune gears");
  // no PR of the joined top-most session (10, 11, 12, 20, 21) appears
  assert.ok(!flat.some(([, n]) => [10, 11, 12, 20, 21].includes(n)));
  // without a join, those land in the section too
  const unjoined = openPrGroups([], tops, new Set()).flatMap((g) => g.prs.map((p) => p.number));
  assert.ok(unjoined.includes(12) && unjoined.includes(30));
});

test("open PRs: empty input gives no groups; a PR is listed once", () => {
  assert.deepEqual(openPrGroups(undefined, undefined), []);
  assert.deepEqual(openPrGroups([], [], new Set()), []);
  const o = [{ repo: "acme/gears", number: 7, checks: [], url: "", title: "", state: "open" }, { repo: "acme/gears", number: 7, checks: [], url: "", title: "", state: "open" }];
  assert.equal(openPrGroups(o, [])[0].prs.length, 1);
  assert.deepEqual(openPrGroups([{ repo: "acme/gears", number: 8, checks: [], state: "merged" }], []), []);
});

test("fmtSince and workerStatus", () => {
  assert.deepEqual([0, 59999, 60000, 3600000, 86400000, 3 * 86400000, -5, "x"].map(fmtSince), ["<1m", "<1m", "1m", "1h", "1d", "3d", "<1m", "<1m"]);
  assert.equal(workerStatus("error", undefined), "blocked");
  assert.equal(workerStatus("working", "done"), "idle");
  assert.equal(workerStatus("working", undefined), "working");
});

test("childTerminals: depth, last flags, live only, cycle safe", () => {
  const t = (address, parent, state = "live") => ({ address, parent, state });
  const all = [t("a", "root"), t("b", "root"), t("a1", "a"), t("a2", "a"), t("x", "root", "gone"), t("a1x", "a1"), null, t("root", "b")];
  const rows = childTerminals(all, "root").map((r) => [r.term.address, r.depth, r.last.join()]);
  assert.deepEqual(rows, [
    ["a", 1, "false"], ["a1", 2, "false,false"], ["a1x", 3, "false,false,true"], ["a2", 2, "false,true"], ["b", 1, "true"],
  ]);
  assert.deepEqual(childTerminals(undefined, "r"), []);
});


test("glyphSpec maps each status to a drawing", () => {
  assert.deepEqual(glyphSpec("working"), { kind: "spin", tone: "working", hollow: false });
  assert.deepEqual(glyphSpec("blocked"), { kind: "pill", tone: "blocked", hollow: false });
  assert.deepEqual(glyphSpec("idle"), { kind: "dot", tone: "idle", hollow: true });
  assert.deepEqual(glyphSpec("done"), { kind: "dot", tone: "done", hollow: false });
});

test("glyphSpec falls back to a dim dot for unknown input", () => {
  for (const bad of ["weird", undefined, null, 5, "toString", "__proto__"]) {
    assert.deepEqual(glyphSpec(bad), { kind: "dot", tone: "dim", hollow: false });
  }
});
