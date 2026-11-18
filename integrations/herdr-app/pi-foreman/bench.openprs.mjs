// Render cost of the Open PRs section (mod test rig: stubs.mjs stands in for the host). Prints one row per shape: open PRs,
// repositories, sessions (each with three PR dots of the feed, not shown, so their PRs go to Open PRs), HoverCards, full card builds
// (a HoverCard whose content is the cardView), elements in the rendered tree and the median ms of 5 renders. The host's own cost of
// each builder call is not in these numbers.
// Usage: node bench.openprs.mjs [--main <path to a main.js>]  (default ./main.js; that folder must hold model.js and sample.mjs)
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

register("./stubs-hooks.mjs", import.meta.url);
const stubs = await import("./stubs.mjs");
const { parseRadarDoc } = await import("./model.js");

const at = process.argv.indexOf("--main");
const mainPath = at > 0 ? path.resolve(process.argv[at + 1]) : fileURLToPath(new URL("./main.js", import.meta.url));
const { default: Mod } = await import(pathToFileURL(mainPath).href);

// [open PRs, repositories, sessions]; the last shape is the D91 acceptance shape (200 PRs, 30 sessions x 3 PRs).
const SHAPES = [[30, 30, 0], [100, 100, 0], [300, 300, 0], [30, 5, 0], [300, 20, 0], [200, 8, 30]];
const RUNS = 5;

// `prs` open PRs spread over `repos` repositories, each with three jobs; neutral example names. `sessions` sessions, each with
// three PR dots that point at feed PRs (number, repository and URL).
function feedDoc(prs, repos, sessions) {
  const openPrs = [];
  for (let i = 0; i < prs; i++) {
    const r = i % repos;
    const n = 1000 + i;
    openPrs.push({
      repo: `example-org/repo-${r}`, number: n, title: `Change ${n} to widget ${r}`, url: `https://example.test/example-org/repo-${r}/pull/${n}`,
      state: "open", author: "octo", headRefName: `feat/${n}`, baseRefName: "main", mergeable: "MERGEABLE", bodyText: "A short description of the change.",
      checks: [{ n: "test (ubuntu-latest)", state: "ok" }, { n: "lint", state: i % 7 === 0 ? "fail" : "ok" }, { n: "build", state: i % 3 === 0 ? "run" : "ok" }],
    });
  }
  const roots = [];
  for (let s = 0; s < sessions; s++) {
    const dots = [0, 1, 2].map((k) => {
      const i = (s * 3 + k) % prs;
      const n = 1000 + i;
      return { n, state: "ok", label: `#${n}`, src: "pr", url: `https://example.test/example-org/repo-${i % repos}/pull/${n}` };
    });
    const cost = { cost: 0, in: 0, out: 0 };
    roots.push({ key: `s${s}`, kind: "session", name: `s${s}`, state: "idle", sym: "idle", own: cost, tot: cost, age_s: 100, children: [], repoUrl: `https://example.test/example-org/repo-${s % repos}`, dots });
  }
  return parseRadarDoc(JSON.stringify({ v: 1, roots, openPrs, openPrsAt: "2026-11-17T10:00:00Z" }));
}

function mod(doc) {
  const m = Object.create(Mod.prototype);
  m.changed = {}; m.feed = []; m.folded = new Set(); m.vp = { width: 1200, height: 900 };
  m.radar = new Map([["local", { ok: true, tree: doc.nodes, openPrs: doc.openPrs, openPrsAt: Date.now(), tried: Date.now() }]]);
  m.busy = new Map(); m.recs = new Map(); m.childPi = new Set(); m.poll = () => {};
  return m;
}

// Every element reachable from the render: kids, the HoverCard trigger and content.
function census(root) {
  const seen = new Set();
  const out = { elements: 0, cards: 0, cardBuilds: 0 };
  const visit = (el) => {
    if (!el || typeof el !== "object" || seen.has(el)) return;
    seen.add(el);
    out.elements++;
    if (el.kind === "HoverCard") {
      out.cards++;
      if (el.contentEl?.kind === "v_flex") out.cardBuilds++;
      visit(el.props.trigger);
    }
    el.kids?.forEach(visit);
    visit(el.contentEl);
  };
  visit(root);
  return out;
}

const rows = [];
for (const [prs, repos, sessions] of SHAPES) {
  stubs.world.agents = [];
  stubs.world.terminals = [];
  const m = mod(feedDoc(prs, repos, sessions));
  let tree = m.render({}); // warm-up
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    tree = m.render({});
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const c = census(tree);
  rows.push({ prs, repos, sessions, ...c, ms: times[Math.floor(RUNS / 2)] });
}

console.log(`main: ${mainPath}`);
console.log("| open PRs | repos | sessions | HoverCards | full card builds | elements | median ms |");
console.log("|---:|---:|---:|---:|---:|---:|---:|");
for (const r of rows) console.log(`| ${r.prs} | ${r.repos} | ${r.sessions} | ${r.cards} | ${r.cardBuilds} | ${r.elements} | ${r.ms.toFixed(1)} |`);
