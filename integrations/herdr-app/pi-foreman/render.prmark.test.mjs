import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

// The check mark of a ready PR is drawn by the one dot renderer: in the Open PRs row and in a session's pill.
const H1 = "1111111111111111111111111111111111111111";
const ok = [{ n: "ci", state: "ok" }];
const entry = (number, over = {}) => ({ number, repo: "acme/app", title: `PR ${number}`, url: `https://example.test/acme/app/pull/${number}`, state: "open", head: H1, mergeState: "clean", mergeable: "MERGEABLE", headRefName: "feat", checks: ok, ...over });
// Open PRs: 201 ready, 202 checks running, 203 failed, 204 merge blocked, 205 green with no host facts (older feed), 206 green but CONFLICTING.
const OPEN = [
  entry(201, { repo: "acme/ready" }), // its own repository: a group of its own
  entry(202, { checks: [{ n: "ci", state: "pending" }] }),
  entry(203, { checks: [{ n: "lint", state: "fail" }] }),
  entry(204, { mergeState: "blocked" }),
  entry(205, { head: undefined, mergeState: undefined, mergeable: undefined }),
  entry(206, { mergeable: "CONFLICTING", mergeState: "dirty" }),
];

const walk = (el, out = []) => {
  if (!el || typeof el !== "object") return out;
  out.push(el);
  el.kids?.forEach((k) => walk(k, out));
  if (el.contentEl) walk(el.contentEl, out);
  if (el.kind === "HoverCard") walk(el.props.trigger, out);
  return out;
};
const hasText = (el, text) => (el.kids ?? []).includes(text);

function render(doc, { agents = [] } = {}) {
  world.agents = agents;
  world.terminals = agents.map((a) => ({ address: a.address, state: "live", foreground: { pid: 7 } }));
  const d = parseRadarDoc(JSON.stringify({ v: 1, openPrsAt: new Date().toISOString(), ...doc }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set();
  m.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), tried: Date.now(), openPrs: d.openPrs, openPrsAt: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  return m.render({});
}

// The chip of PR `n`: the HoverCard whose trigger draws "PR #n".
const chipOf = (root, n) => walk(root).filter((e) => e.kind === "HoverCard").find((c) => walk(c.props.trigger).some((e) => hasText(e, `PR #${n}`) || hasText(e, `#${n}`)));
const badgeOf = (chip) => walk(chip.props.trigger).find((e) => e.props?.font_semibold && e.props.text_size === 10);
const checkOf = (chip) => (hasText(badgeOf(chip), "✓ ") ? badgeOf(chip) : undefined);

test("the Open PRs row: ready is a still green badge with a check mark", () => {
  const root = render({ roots: [], openPrs: OPEN });
  const ready = chipOf(root, 201);
  assert.ok(ready, "#201 is drawn");
  assert.equal(checkOf(ready).props.text_color, "#ansi2", "green");
  assert.equal(checkOf(ready).props.loop, undefined, "never pulses");
  assert.equal(checkOf(ready).props.bg, "#ansi22e", "the check sits in a tinted badge");
});

test("the Open PRs row: every other state keeps its badge colour and draws no check mark", () => {
  const root = render({ roots: [], openPrs: OPEN });
  const want = { 202: ["#ansi3", true], 203: ["#blocked", false], 204: ["#ansi3", false], 205: ["#ansi2", false], 206: ["#ansi2", false] };
  for (const [n, [colour, pulses]] of Object.entries(want)) {
    const chip = chipOf(root, n);
    assert.ok(chip, `#${n} is drawn`);
    assert.equal(checkOf(chip), undefined, `#${n}: no check mark`);
    assert.equal(badgeOf(chip).props.text_color, colour, `#${n} colour`);
    assert.equal(badgeOf(chip).props.loop !== undefined, pulses, `#${n} pulses`);
  }
});

test("only the running PR loops in the Open PRs row: the check mark never pulses", () => {
  const root = render({ roots: [], openPrs: OPEN });
  assert.equal(walk(root).filter((e) => e.props?.loop !== undefined).length, 1);
});

test("a session's pill: a ready PR shows the check mark, a blocked one its amber badge", () => {
  const session = sess("s-a", "agent-a", {
    pid: 7, hcTerminal: "t5",
    dots: [
      { n: 201, state: "ok", label: "#201", src: "pr", url: `https://example.test/acme/app/pull/201` },
      { n: 204, state: "ok", label: "#204", src: "pr", url: `https://example.test/acme/app/pull/204` },
    ],
  });
  const root = render({ roots: [session], openPrs: OPEN }, { agents: [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }] });
  const ready = chipOf(root, 201);
  assert.ok(ready, "#201 is drawn in the session row");
  assert.equal(checkOf(ready).props.text_color, "#ansi2");
  const blocked = chipOf(root, 204);
  assert.ok(blocked, "#204 is drawn in the session row");
  assert.equal(checkOf(blocked), undefined);
  assert.equal(badgeOf(blocked).props.text_color, "#ansi3");
  assert.equal(badgeOf(blocked).props.loop, undefined);
});
