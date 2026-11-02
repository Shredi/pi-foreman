import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree, prCard, prDotState, enrichPrs, jobOf } = await import("./model.js");

// Shape of `foreman radar --json` openPrs[] / session dots, with neutral owner/repo data.
const REAL = {
  v: 1,
  roots: [{
    key: "f", kind: "session", name: "session-x", state: "idle", sym: "idle", own: { cost: 1 }, tot: {}, age_s: 5, children: [],
    dots: [{ n: 55, state: "run", label: "#55", src: "pr", url: "https://example.test/acme/widgets/pull/55" }, { n: 50, state: "run", label: "#50", src: "pr" }],
  }],
  openPrsAt: "2026-10-31T22:51:38Z",
  openPrs: [
    {
      repo: "acme/widgets", number: 55, title: "Keep the widget state across a restart", url: "https://example.test/acme/widgets/pull/55",
      state: "open", author: "octo", headRefName: "feat/keep", mergeable: "MERGEABLE", bodyText: "The widget now keeps its state when it restarts.",
      checks: [
        { n: "test (ubuntu-latest)", state: "ok", label: "test (ubuntu-latest)" },
        { n: "test (macos-latest)", state: "run", label: "test (macos-latest)" },
        { n: "lint", state: "fail", label: "lint" },
        { n: "bench-smoke", state: "none", label: "bench-smoke" },
      ],
    },
    {
      repo: "acme/widgets", number: 51, title: "Lock the shared cache", url: "https://example.test/acme/widgets/pull/51",
      state: "open", author: "octo", headRefName: "feat/lock", baseRefName: "main", mergeable: "CONFLICTING", bodyText: "Lock.",
      checks: [{ n: "test (ubuntu-latest)", state: "ok", label: "test (ubuntu-latest)" }],
    },
  ],
};

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const texts = (root) => walk(root).flatMap((e) => (e.kids ?? []).filter((k) => typeof k === "string"));
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard").map((e) => e.contentEl);

function mod(doc = REAL) {
  const d = parseRadarDoc(JSON.stringify(doc));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set();
  m.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), tried: Date.now(), openPrs: d.openPrs, openPrsAt: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  return m;
}

test("real feed: object checks parse to named jobs", () => {
  const d = parseRadarDoc(JSON.stringify(REAL));
  assert.equal(d.openPrs.length, 2);
  assert.deepEqual(d.openPrs[0].jobs.map((j) => j.name), ["test (ubuntu-latest)", "test (macos-latest)", "lint", "bench-smoke"]);
  assert.deepEqual(d.openPrs[0].checks, ["ok", "pending", "fail", "none"]);
  assert.equal(d.openPrs[1].mergeable, "CONFLICTING");
});

test("jobOf reads strings and {n|name,state,label} objects, nothing else", () => {
  assert.deepEqual(jobOf("ok"), { name: "", state: "ok" });
  assert.deepEqual(jobOf({ name: "x", state: "fail" }), { name: "x", state: "fail" });
  assert.deepEqual(jobOf({ n: "y", state: "run" }), { name: "y", state: "pending" });
  assert.equal(jobOf({ n: "z", state: "weird" }), null);
  assert.equal(jobOf(null), null);
});

test("dot state and card accept object checks and strings alike", () => {
  const objs = { number: 1, checks: [{ n: "a", state: "ok" }, { n: "b", state: "run" }] };
  assert.deepEqual(prDotState(objs), { ring: true, fill: "green", conflict: false });
  assert.deepEqual(prCard(objs).groups.map((g) => g.names), [["b"], ["a"]]);
  assert.deepEqual(prCard({ number: 2, checks: ["fail", "ok"] }).counts, { failed: 1, running: 0, passed: 1 });
});

test("enrichPrs gives a session dot the real job names of its feed twin", () => {
  const d = parseRadarDoc(JSON.stringify(REAL));
  const [p] = enrichPrs([{ number: 55, checks: ["pending"], jobs: [{ name: "", state: "pending" }], url: "https://example.test/acme/widgets/pull/55", repo: "" }], d.openPrs);
  assert.ok(prCard(p).groups.flatMap((g) => g.names).includes("lint"));
});

test("Open PRs section and session chips render; the card shows real job names", () => {
  const r = mod().render({});
  const t = texts(r);
  assert.ok(t.includes("Open PRs"), "section");
  assert.ok(t.some((s) => s.includes("#51")), "open PR chip");
  const all = cards(r).flatMap((c) => texts(c));
  assert.ok(all.includes("lint"), "failed job name");
  assert.ok(all.includes("test (macos-latest)"), "running job name");
  assert.ok(all.includes("test (ubuntu-latest)"), "passed job name");
  assert.ok(all.includes("conflicts with main"), "conflict line names the base branch");
});

test("a HoverCard id is not reused when the card's content changed", () => {
  const ids = (doc) => walk(mod(doc).render({})).filter((e) => e.kind === "HoverCard").map((e) => e.cardId);
  const before = JSON.stringify(ids(REAL));
  assert.ok(ids(REAL).every((id) => typeof id === "string" && id));
  const changed = structuredClone(REAL);
  changed.openPrs[0].checks[2].state = "ok";
  assert.notEqual(JSON.stringify(ids(changed)), before);
  assert.equal(JSON.stringify(ids(REAL)), before);
});

test("a malformed PR does not take the section down", () => {
  const bad = structuredClone(REAL);
  bad.openPrs.push({ repo: "acme/widgets", number: 60, url: "https://example.test/acme/widgets/pull/60", checks: [null, 7, { state: {} }, "x"] });
  const t = texts(mod(bad).render({}));
  assert.ok(t.includes("Open PRs"));
  assert.ok(t.some((s) => s.includes("#60")) && t.some((s) => s.includes("#55")));
});
