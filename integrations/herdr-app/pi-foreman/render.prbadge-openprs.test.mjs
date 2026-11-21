import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { default: Mod } = await import("./main.js");
const { parseRadarDoc, buildTree } = await import("./model.js");
const { sess } = await import("./fixtures.mjs");
const { world } = stubs;

// The whole view with a radar openPrs feed: one session row with a PR line (its badge reads "PR #n"), and the Open PRs list (badges read "#n").
const REPO = "example-org/app";
const pageOf = (n) => `https://example.test/example-org/app/pull/${n}`;
const ok = [{ n: "ci", state: "ok" }];
const pr = (number, over = {}) => ({
  number, repo: REPO, title: `Change ${number}`, url: pageOf(number), state: "open", head: "1".repeat(40), headRefName: `feat/${number}`,
  mergeState: "clean", mergeable: "MERGEABLE", checks: ok, ...over,
});
const dot = (number) => ({ n: number, state: "ok", label: `#${number}`, src: "pr", url: pageOf(number) });

// Open PRs, one per state. #201 is the session's own PR (not in Open PRs); #306 is watched by a session that is not shown, past its last PASS.
const FEED = [
  pr(201),
  pr(301, { state: "draft" }), // draft: violet
  pr(302, { checks: [{ n: "ci", state: "pending" }] }), // CI running: amber, pulsing
  pr(303), // checks passed, mergeable, clean: ready, green with the check mark
  pr(304, { checks: [{ n: "lint", state: "fail" }] }), // CI failing: red
  pr(305, { mergeState: "blocked", mergeable: "UNKNOWN", waiting: ["required-check"] }), // waits on required checks: amber outline, no tint
  pr(306), // checks passed, the head is past the session's last PASS: blue
];
const ref = { n: 306, repo: REPO };
const owner = sess("s-blue", "blue-owner", {
  repoUrl: "https://example.test/example-org/app",
  dots: [dot(306)],
  waits: [{ kind: "pr", note: "1 pr watch", age_s: 5, prs: [306], prRefs: [ref], unreviewed: [ref], review: [{ ...ref, head: "1".repeat(40), state: "unreviewed" }] }],
});
const joined = sess("s-agent", "agent-a", {
  pid: 7, hcTerminal: "t5", show: { dir: "/s/app", plan: 3 }, dots: [dot(201)],
  waits: [{ id: "pr_watch", kind: "pr", note: "1 pr watch", age_s: 0, left_s: 0, prs: [201] }],
});

function view(roots, openPrs) {
  world.agents = [{ address: "t5", pane: "p1", space: 1, space_name: "s", status: "idle", focused: false, program: { name: "pi" } }];
  world.terminals = [{ address: "t5", state: "live", foreground: { pid: 7 } }];
  const d = parseRadarDoc(JSON.stringify({ v: 1, openPrsAt: new Date().toISOString(), roots, openPrs }));
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: buildTree(d.nodes), tried: Date.now(), openPrs: d.openPrs, openPrsAt: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  m.hotCard = null; m.seenChips = new Set();
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
const isBadge = (e) => e.props?.font_semibold && e.props.text_size === 10;
const cards = (root) => walk(root).filter((e) => e.kind === "HoverCard" && e.cardId !== "legend-card");
const hasKid = (el, text) => (el.kids ?? []).includes(text);
// The Open PRs line of #n: its label is "#n"; the session row's line is "PR #n".
const openLine = (root, n) => cards(root).find((c) => walk(c.props.trigger).some((e) => hasKid(e, `#${n}`)));
const sessionLine = (root, n) => cards(root).find((c) => walk(c.props.trigger).some((e) => hasKid(e, `PR #${n}`)));
const titleOf = (line, n) => walk(line.props.trigger).find((e) => hasKid(e, `Change ${n}`));

// Ink per state: the PR palette of the theme stub (`#ansi<n>`, `#blocked`).
const STATES = [
  { n: 301, label: "draft", ink: "#ansi5", bg: "#ansi52e", border: "#ansi555", pulse: false },
  { n: 302, label: "running", ink: "#ansi3", bg: "#ansi32e", border: "#ansi355", pulse: true },
  { n: 303, label: "ready", ink: "#ansi2", bg: "#ansi22e", border: "#ansi255", pulse: false, mark: true },
  { n: 304, label: "failed", ink: "#blocked", bg: "#blocked2e", border: "#blocked55", pulse: false },
  { n: 305, label: "required-wait", ink: "#ansi3", bg: undefined, border: "#ansi3", pulse: false },
  { n: 306, label: "unreviewed", ink: "#ansi4", bg: "#ansi42e", border: "#ansi455", pulse: false },
];

const root = view([owner, joined], FEED).render({});

for (const s of STATES) {
  test(`Open PRs line #${s.n} (${s.label}): badge reads #${s.n}, coloured by its state`, () => {
    const line = openLine(root, s.n);
    assert.ok(line, `#${s.n} has a line`);
    const badge = walk(line.props.trigger).find(isBadge);
    assert.ok(badge, "a badge");
    assert.equal(badge.props.text_color, s.ink, "badge colour");
    assert.equal(badge.props.bg, s.bg, "tint (none for the outlined wait)");
    assert.equal(badge.props.border_color, s.border, "border");
    assert.equal(badge.props.flex_none, true, "the badge never shrinks");
    assert.equal(badge.props.loop !== undefined, s.pulse, "pulses only while running");
    const labels = (badge.kids ?? []).filter((k) => typeof k === "string");
    assert.deepEqual(labels, s.mark ? ["✓ ", `#${s.n}`] : [`#${s.n}`], "label");
  });
}

test("Open PRs: no badge reads PR #n; each title is the normal foreground and truncates", () => {
  for (const s of STATES) {
    const line = openLine(root, s.n);
    assert.ok(!walk(line.props.trigger).some((e) => hasKid(e, `PR #${s.n}`)), `#${s.n} has no "PR" prefix`);
    const title = titleOf(line, s.n);
    assert.ok(title, `#${s.n} title`);
    assert.equal(title.props.text_color, "#foreground", `#${s.n} title colour`);
    assert.equal(title.props.truncate, true, `#${s.n} title truncates`);
    assert.equal(title.props.flex_1, true, `#${s.n} title takes the spare width`);
  }
});

test("a session-card line in the same render reads PR #n with its own badge and a foreground title", () => {
  const line = sessionLine(root, 201);
  assert.ok(line, "#201 has a session line");
  const badge = walk(line.props.trigger).find(isBadge);
  assert.equal(badge.props.text_color, "#ansi2", "ready: green");
  assert.deepEqual((badge.kids ?? []).filter((k) => typeof k === "string"), ["✓ ", "PR #201"]);
  assert.equal(badge.props.flex_none, true);
  assert.equal(titleOf(line, 201).props.text_color, "#foreground");
  assert.equal(openLine(root, 201), undefined, "the session's PR is not repeated in Open PRs");
});

test("the session's plan and status lines are dim while its PR title is the foreground", () => {
  const show = walk(root).find((e) => /^show:plan:/.test(String(e.props?.id ?? "")));
  assert.ok(show, "the plan line");
  assert.ok(hasKid(show, "📄 plan v3"));
  assert.equal(show.props.text_color, "#dim", "plan line");
  const status = walk(root).find((e) => (e.kids ?? []).some((k) => typeof k === "string" && k.includes("1 pr watch")));
  assert.ok(status, "the status line");
  assert.equal(status.props.text_color, "#dim", "status line");
  assert.equal(titleOf(sessionLine(root, 201), 201).props.text_color, "#foreground", "PR title");
});
