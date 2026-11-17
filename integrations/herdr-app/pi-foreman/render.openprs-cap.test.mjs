import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, openPrGroups } = await import("./model.js");

// `prs` open PRs over `repos` repositories (example names), each with a page address unless `withUrl` is false.
function feed(prs, repos = prs, withUrl = true) {
  const openPrs = [];
  for (let i = 0; i < prs; i++) {
    const r = i % repos;
    const n = 100 + i;
    openPrs.push({
      repo: `example-org/repo-${r}`, number: n, title: `Change ${n}`, state: "open", headRefName: `feat/${n}`, mergeable: "MERGEABLE",
      ...(withUrl ? { url: `https://example.test/example-org/repo-${r}/pull/${n}` } : {}),
      checks: [{ n: "build", state: "ok" }],
    });
  }
  return parseRadarDoc(JSON.stringify({ v: 1, roots: [], openPrs, openPrsAt: "2026-11-17T10:00:00Z" })).openPrs;
}

function mod(openPrs) {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  stubs.world.notices = [];
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: [], openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  return m;
}

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard");
const repoRows = (root) => walk(root).filter((e) => /^op-example-org\//.test(String(e.props?.id ?? "")) && !String(e.props.id).startsWith("op-more-"));
const moreOf = (row) => walk(row).find((e) => String(e.props?.id ?? "").startsWith("op-more-"));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

test("30 PRs in 30 repositories: every repository row and every chip is drawn, nothing is folded into +k", () => {
  const root = mod(feed(30)).render({});
  assert.equal(repoRows(root).length, 30);
  assert.equal(cards(root).length, 30);
  assert.ok(!walk(root).some((e) => String(e.props?.id ?? "").startsWith("op-more-")));
});

test("300 PRs in 300 repositories: the section finishes and draws all 300 rows", () => {
  const root = mod(feed(300)).render({});
  assert.equal(repoRows(root).length, 300);
  assert.equal(cards(root).length, 300);
});

test("300 PRs in 20 repositories: each row shows 5 chips and one +10 more", () => {
  const root = mod(feed(300, 20)).render({});
  const rows = repoRows(root);
  assert.equal(rows.length, 20);
  for (const row of rows) {
    assert.equal(cards(row).length, 5, row.props.id);
    assert.ok(texts(moreOf(row)).includes("+10 more"), row.props.id);
  }
});

test("a row past the cap: the first 5 PRs of the group are chips; +k more lists the rest in its tooltip", () => {
  const openPrs = feed(12, 1);
  const [group] = openPrGroups(openPrs, [], new Set());
  const row = repoRows(mod(openPrs).render({}))[0];
  assert.deepEqual(cards(row).map((c) => c.props.trigger.props.id), group.prs.slice(0, 5).map((p) => `pr-op-example-org/repo-0-${p.number}`));
  const more = moreOf(row);
  assert.deepEqual(texts(more), ["+7 more"]);
  assert.equal(more.props.tooltip, group.prs.slice(5).map((p) => `#${p.number}`).join(", "));
});

test("+k more opens the repository's pull list on the host of a hidden PR's page", () => {
  const m = mod(feed(6, 1));
  const opened = [];
  m.openUrl = (url) => opened.push(url);
  const more = moreOf(repoRows(m.render({}))[0]);
  more.props.on_click({}, { stop_propagation() {}, notify() {} });
  assert.deepEqual(opened, ["https://example.test/example-org/repo-0/pulls"]);
});

test("+k more with no page address for any hidden PR says so, and opens nothing", () => {
  const m = mod(feed(6, 1, false));
  const opened = [];
  m.openUrl = (url) => opened.push(url);
  const more = moreOf(repoRows(m.render({}))[0]);
  more.props.on_click({}, { stop_propagation() {}, notify() {} });
  assert.deepEqual(opened, []);
  assert.equal(stubs.world.notices.length, 1);
  assert.equal(stubs.world.notices[0].title, "No link for these pull requests");
  assert.match(stubs.world.notices[0].body, /^#\d+ have no page address yet\.$/);
});

test("a repository row that fails to build falls back to its name and count; the other rows still draw", () => {
  const { openPrRows } = Mod.prototype;
  const t = stubs.theme();
  const [ok] = feed(2, 1);
  const rows = openPrRows.call(mod([]), t, [{ repo: "example-org/broken", prs: null }, { repo: "example-org/repo-0", prs: [ok] }]);
  const broken = rows.find((r) => r.props.id === "op-example-org/broken");
  assert.ok(broken, "the broken row is still a row");
  assert.deepEqual(texts(broken), ["example-org/broken", "0 PRs"]);
  const good = rows.find((r) => r.props.id === "op-example-org/repo-0");
  assert.equal(cards(good).length, 1, "the healthy row keeps its chip");
});
