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
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
const repoRows = (root) => walk(root).filter((e) => /^op-example-org\//.test(String(e.props?.id ?? "")));
const unfoldAll = (m, repos) => { m.unfolded = new Set(Array.from({ length: repos }, (_, r) => `opg:example-org/repo-${r}`)); return m; };
const noMore = (root) => !walk(root).some((e) => /^op-more-/.test(String(e.props?.id ?? "")) || texts(e).some((s) => /\+\d+ more/.test(s)));
const texts = (el) => walk(el).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));

test("30 PRs in 30 repositories: every repository group is drawn, folded (more than 15 PRs), no +k more", () => {
  const root = mod(feed(30)).render({});
  assert.equal(repoRows(root).length, 30);
  assert.equal(cards(root).length, 0);
  assert.ok(noMore(root));
});

test("30 PRs in 30 repositories, all opened: every PR is a line", () => {
  const root = unfoldAll(mod(feed(30)), 30).render({});
  assert.equal(repoRows(root).length, 30);
  assert.equal(cards(root).length, 30);
  assert.ok(noMore(root));
});

test("300 PRs in 300 repositories: the section finishes and draws all 300 groups", () => {
  const root = mod(feed(300)).render({});
  assert.equal(repoRows(root).length, 300);
});

test("300 PRs in 20 repositories, all opened: each group has its 15 lines, no cap and no +k more", () => {
  const root = unfoldAll(mod(feed(300, 20)), 20).render({});
  const rows = repoRows(root);
  assert.equal(rows.length, 20);
  for (const row of rows) assert.equal(cards(row).length, 15, row.props.id);
  assert.ok(noMore(root));
});

test("12 PRs in one repository (15 or fewer): the group is open and every PR is a line, in the group's order", () => {
  const openPrs = feed(12, 1);
  const [group] = openPrGroups(openPrs, [], new Set());
  const row = repoRows(mod(openPrs).render({}))[0];
  assert.deepEqual(cards(row).map((c) => c.props.trigger.props.id), group.prs.map((p) => `pr-op-example-org/repo-0-${p.number}`));
  assert.ok(noMore(row));
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
