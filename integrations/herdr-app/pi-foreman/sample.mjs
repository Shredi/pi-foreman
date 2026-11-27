// The sample view's feed (props `{"sample": true}`, docs/development.md): host lists, one radar document and nothing else, drawn by the
// real render path with no exec and no poll. One row per key of the legend table in docs/herdr.md; `ROWS` names the key of each.
// All names, repositories and numbers are invented.

import { attachName } from "./model.js";

const ENDED = "fm-ended-a1b2c3";
const H = "1111111111111111111111111111111111111111";
const own = { cost: 0, in: 0, out: 0, uncached: null };
const session = (key, name, over = {}) => ({ key, kind: "session", name, state: "idle", sym: "idle", own, age_s: 120, children: [], waits: [], dots: [], ...over });
const agent = (address, tab, status) => ({ address, pane: `p-${address}`, space: 1, space_name: "Sample", tab_name: tab, status, program: { name: "pi" }, app: "pi" });
const pr = (number, over = {}) => ({
  number, repo: "acme/widgets", title: `Sample change ${number}`, url: `https://example.test/acme/widgets/pull/${number}`, state: "open", head: H,
  mergeState: "clean", mergeable: "MERGEABLE", headRefName: `sample-${number}`, checks: [{ n: "ci", state: "ok" }], ...over,
});

/** `{key, label}` of an agent or session row (its name), `{key, pr}` of a PR line (its number) and `{key, legend}` of the title bar's "?": every key of the legend table appears once. */
export const ROWS = [
  { key: "agent-working", label: "sample working" },
  { key: "agent-needs-you", label: "sample needs you" },
  { key: "agent-own-agents", label: "sample own agents" },
  { key: "agent-done", label: "sample done" },
  { key: "agent-background", label: "sample background" },
  { key: "agent-waiting", label: "sample waiting" },
  { key: "agent-idle", label: "sample idle" },
  { key: "session-ended", label: "ended-one" },
  { key: "session-remote", label: "remote-one" },
  { key: "pr-draft", pr: 101 },
  { key: "pr-draft-running", pr: 102 },
  { key: "pr-running", pr: 103 },
  { key: "pr-failed", pr: 104 },
  { key: "pr-failed-running", pr: 112 },
  { key: "pr-not-reviewed", pr: 105 },
  { key: "pr-ready", pr: 106 },
  { key: "pr-ci-passing", pr: 111 },
  { key: "pr-conflict", pr: 107 },
  { key: "pr-no-checks", pr: 108 },
  { key: "pr-draft-failed", pr: 109 },
  { key: "pr-merge-blocked", pr: 110 },
  { key: "pr-required-wait", pr: 116 },
  { key: "pr-legend", legend: true },
];

export const SAMPLE = {
  agents: [
    agent("t1", "sample working", "working"),
    agent("t2", "sample needs you", "blocked"),
    agent("t3", "sample own agents", "done"),
    agent("t4", "sample done", "done"),
    agent("t5", "sample background", "idle"),
    agent("t6", "sample waiting", "idle"),
    agent("t7", "sample idle", "idle"),
    agent("t8", "sample fleet", "idle"),
    agent("t9", "sample review", "idle"),
    agent("t10", "sample three prs", "idle"),
    // SAMPLE-FILTER: busy parents of the needs-me filter samples (one with a blocked child session, one with an idle one, one with a ready PR)
    agent("t11", "sample busy asks", "working"),
    agent("t12", "sample busy calm", "working"),
    agent("t13", "sample busy ready pr", "working"),
  ],
  terminals: [
    ...[303, 305, 306, 308, 309, 310, 311, 312, 313].map((pid, i) => ({ address: ["t3", "t5", "t6", "t8", "t9", "t10", "t11", "t12", "t13"][i], state: "live", foreground: { pid } })),
    // the live mirror of the ended remote session: its dimmed row stays while this terminal lives
    { address: "t20", state: "live", name: attachName("box1", ENDED), parent: "t8", agent: "pi", status: "done", argv: ["hc", "attach", "box1/t71"] },
  ],
  spaces: [{ id: 1, machine: null }],
  radar: {
    v: 1,
    roots: [
      session("s-own", "sample own agents", { pid: 303, hcTerminal: "t3", children: [{ key: "run:s-own:1", kind: "run", name: "builder", role: "builder", state: "working", sym: "working", own, age_s: 30, children: [] }] }),
      session("s-bg", "sample background", { pid: 305, hcTerminal: "t5", tasks: [{ id: "task-1", label: "npm test", ageSeconds: 90 }] }),
      session("s-wait", "sample waiting", { pid: 306, hcTerminal: "t6", waits: [{ kind: "ci", note: "1 pr watch", age_s: 60, prs: [] }] }),
      session("s-fleet", "sample fleet", {
        pid: 308, hcTerminal: "t8",
        children: [
          session("s-remote", "remote-one", { machine: "box1", hcTerminal: "t70", state: "working", sym: "working", parent: "s-fleet" }),
          session(ENDED, "ended-one", { machine: "box1", hcTerminal: "t71", state: "closed", sym: "closed", ended_s: 600, parent: "s-fleet" }),
        ],
      }),
      // A session with more PRs than fit in its title row: one line per PR, red, ready and merge-blocked.
      session("s-lines", "sample three prs", {
        pid: 310, hcTerminal: "t10",
        dots: [113, 114, 115].map((n) => ({ n, state: n === 113 ? "fail" : "ok", label: `#${n}`, src: "pr", url: `https://example.test/acme/widgets/pull/${n}` })),
      }),
      // SAMPLE-FILTER: a working parent whose child session asks you, one whose child session is idle, one with a PR ready to merge
      session("s-busy-asks", "sample busy asks", {
        pid: 311, hcTerminal: "t11", state: "working", sym: "working",
        children: [session("s-asks-child", "asks you", { hcTerminal: "t80", state: "ask", sym: "needs-you", parent: "s-busy-asks", asks: [{ q: "Merge it?" }] })],
      }),
      session("s-busy-calm", "sample busy calm", {
        pid: 312, hcTerminal: "t12", state: "working", sym: "working",
        children: [session("s-calm-child", "idle child", { hcTerminal: "t81", parent: "s-busy-calm" })],
      }),
      session("s-busy-ready", "sample busy ready pr", {
        pid: 313, hcTerminal: "t13", state: "working", sym: "working",
        dots: [{ n: 117, state: "ok", label: "#117", src: "pr", url: "https://example.test/acme/widgets/pull/117" }],
      }),
      session("s-review", "sample review", {
        pid: 309, hcTerminal: "t9", repo: "acme/gadgets",
        waits: [{ kind: "pr", note: "1 pr watch", age_s: 5, prs: [105], prRefs: [{ n: 105, repo: "acme/gadgets" }], unreviewed: [{ n: 105, repo: "acme/gadgets" }], review: [{ n: 105, repo: "acme/gadgets", head: H, state: "unreviewed" }] }],
      }),
    ],
    openPrs: [
      pr(101, { state: "draft" }),
      pr(102, { state: "draft", checks: [{ n: "ci", state: "pending" }] }),
      pr(103, { checks: [{ n: "lint", state: "ok" }, { n: "ci", state: "pending" }] }),
      pr(104, { checks: [{ n: "ci", state: "fail" }] }),
      pr(105, { repo: "acme/gadgets" }),
      // Open PRs draws every PR as a line of its repository's group: the sample spreads its PRs over three repositories.
      pr(106, { repo: "acme/gadgets" }),
      pr(107, { repo: "acme/gadgets", mergeable: "CONFLICTING", mergeState: "dirty" }),
      pr(108, { repo: "acme/tools", checks: [] }),
      pr(109, { repo: "acme/tools", state: "draft", checks: [{ n: "ci", state: "fail" }] }),
      pr(110, { repo: "acme/tools", mergeState: "blocked" }),
      pr(111, { repo: "acme/tools", mergeable: "UNKNOWN", mergeState: "unknown" }),
      pr(112, { checks: [{ n: "lint", state: "fail" }, { n: "ci", state: "pending" }] }),
      pr(113, { checks: [{ n: "ci", state: "fail" }] }),
      pr(114),
      pr(115, { mergeState: "blocked" }),
      // checks passed, the merge waits on two required checks the tracker names: the still ring and the card's waiting group
      pr(117), // SAMPLE-FILTER: ready to merge, carried by `sample busy ready pr`
      pr(116, { repo: "acme/tools", mergeState: "blocked", waiting: ["security-scan", "license-check"] }),
    ],
  },
};

// The ~50-PR feed (props `{"sample": true, "manyPrs": true}`): 52 PRs (numbers 201 to 252) over 18 neutral repositories, each entry of
// MANY_PRS is [repository, state]. Its states: a failing check, a conflict, ready to merge, a running check, a draft. One PR (206) is
// unreviewed: a session of the sample (`sample review`) watches it, as a session's watch is the only source of that fact. #211 has no
// title and #219 no page address.
const MANY_REPOS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo"];
const MANY_PRS = [
  ["alpha", "fail"], ["alpha", "ready"], ["alpha", "run"], ["bravo", "conflict"], ["bravo", "ready"], ["bravo", "unreviewed"],
  ["charlie", "ready"], ["charlie", "ready"], ["delta", "fail"], ["delta", "draft"], ["echo", "ready"], ["echo", "ready"],
  ["foxtrot", "run"], ["foxtrot", "run"], ["golf", "ready"], ["golf", "ready"], ["hotel", "conflict"], ["hotel", "ready"],
  ["india", "fail"], ["juliet", "ready"], ["juliet", "run"], ["kilo", "ready"], ["kilo", "run"], ["lima", "ready"],
  ["mike", "ready"], ["mike", "run"], ["november", "draft"], ["november", "ready"], ["oscar", "ready"], ["oscar", "run"],
  ["papa", "ready"], ["papa", "run"], ["quebec", "ready"], ["quebec", "ready"], ["alpha", "ready"], ["bravo", "ready"],
  ["golf", "run"], ["hotel", "draft"], ["juliet", "ready"], ["kilo", "ready"],
  // one repository with many failing PRs, to see the capped group and its "+N more" line: 12 PRs, 9 failing, 1 conflicting
  ...Array.from({ length: 9 }, () => ["romeo", "fail"]), ["romeo", "conflict"], ["romeo", "ready"], ["romeo", "ready"],
];
const MANY_STATE = {
  fail: { checks: [{ n: "ci", state: "fail" }] },
  conflict: { mergeable: "CONFLICTING", mergeState: "dirty" },
  run: { checks: [{ n: "ci", state: "pending" }] },
  draft: { state: "draft" },
  ready: {},
  unreviewed: {},
};
const watchedPr = { number: 206, repo: "acme/bravo" };
export const SAMPLE_MANY = {
  radar: {
    v: 1,
    roots: [session("s-many-review", "sample review", {
      repo: watchedPr.repo, repoUrl: `https://example.test/${watchedPr.repo}`,
      dots: [{ n: watchedPr.number, state: "ok", label: `#${watchedPr.number}`, src: "pr", url: `https://example.test/${watchedPr.repo}/pull/${watchedPr.number}` }],
      waits: [{ kind: "pr", note: "1 pr watch", age_s: 5, prs: [watchedPr.number], prRefs: [{ n: watchedPr.number, repo: watchedPr.repo }], unreviewed: [{ n: watchedPr.number, repo: watchedPr.repo }], review: [{ n: watchedPr.number, repo: watchedPr.repo, head: H, state: "unreviewed" }] }],
    })],
    openPrs: MANY_PRS.map(([repo, kind], i) => pr(201 + i, {
      repo: `acme/${repo}`, url: `https://example.test/acme/${repo}/pull/${201 + i}`, ...MANY_STATE[kind],
      ...(201 + i === 211 ? { title: "" } : {}), ...(201 + i === 219 ? { url: "" } : {}),
    })),
  },
};
