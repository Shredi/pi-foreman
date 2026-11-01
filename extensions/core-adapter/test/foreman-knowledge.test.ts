// foreman knowledge: normalise, hash compare, discover, accept, nudge and one CLI spawn against local fixtures (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyAccept, compareSource, discoverLinks, hashText, knowledgeNudge, normalise } from "../../../scripts/foreman_knowledge.mjs";
import { withNudge } from "../knowledge.ts";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "foreman_knowledge.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pf-knowledge-"));

const PAGE = `<!DOCTYPE html><html><head><title>t</title><style>.a{color:red}</style><script>var x = "<p>noise</p>";</script></head>
<body><header>Site header</header><nav><a href="/x">Menu</a></nav>
<main><h1>Guide &amp; more</h1><p>First   paragraph
 with <b>bold</b> text&nbsp;and &lt;tag&gt; &#8212; &#x41;.</p><!-- hidden --><ul><li>One</li><li>Two</li></ul><aside>Side</aside></main>
<footer>Footer</footer></body></html>`;

test("normalise keeps the main text, drops noise, decodes entities, one line per block", () => {
  assert.equal(normalise(PAGE), "Guide & more\nFirst paragraph with bold text and <tag> — A.\nOne\nTwo\n");
});

test("normalise leaves Markdown unchanged and falls back to the whole body without main", () => {
  const md = "# Title\n\nSome <b>inline</b> text\n";
  assert.equal(normalise(md), md);
  assert.equal(normalise("<html><body><nav>n</nav><p>a</p><p>b</p></body></html>"), "a\nb\n");
});

test("hash is stable across markup and whitespace noise but changes with the text", () => {
  const other = PAGE.replace("<nav><a href=\"/x\">Menu</a></nav>", "<nav>Other menu</nav>").replace("First   paragraph", "First paragraph");
  assert.equal(hashText(normalise(PAGE)), hashText(normalise(other)));
  assert.notEqual(hashText(normalise(PAGE)), hashText(normalise(PAGE.replace("One", "Uno"))));
  assert.match(hashText("x"), /^[0-9a-f]{64}$/);
});

test("compareSource: new, unchanged, changed", () => {
  const text = normalise(PAGE);
  const sha = hashText(text);
  assert.deepEqual(compareSource({ id: "a" }, text), { state: "new", sha256: sha });
  assert.deepEqual(compareSource({ id: "a", sha256: sha }, text), { state: "unchanged", sha256: sha });
  assert.equal(compareSource({ id: "a", sha256: "0".repeat(64) }, text).state, "changed");
});

test("discoverLinks reports matching links that are not manifest urls, once each", () => {
  const base = "https://docs.example.com/docs/en/pe/index";
  const html = `<a href="/docs/en/pe/prompting-claude-a-1">A</a> <a href="prompting-claude-b-2/">B</a> <a href="/docs/en/pe/prompting-claude-b-2">B again</a>
<a href="/docs/en/pe/other">no</a> <a href="https://elsewhere.example.org/docs/en/pe/prompting-claude-c-3#top">C</a>`;
  const known = ["https://docs.example.com/docs/en/pe/prompting-claude-a-1"];
  const found = discoverLinks(html, base, { pattern: "/pe/prompting-claude-[a-z0-9-]+", label: "model page" }, known);
  assert.deepEqual(found, [
    { url: "https://docs.example.com/docs/en/pe/prompting-claude-b-2", label: "model page" },
    { url: "https://elsewhere.example.org/docs/en/pe/prompting-claude-c-3", label: "model page" },
  ]);
});

test("applyAccept writes hash and date in stable key order and refuses ids without a result", () => {
  const manifest = {
    version: 1,
    sources: [
      { id: "a", url: "https://x.example/a", target: "t.md", sha256: "old", checkedOn: "2026-01-01", discover: { pattern: "p", label: "l" } },
      { id: "b", url: "https://x.example/b", target: "t.md" },
      { id: "c", url: "https://x.example/c", target: "t.md", sha256: "keep", checkedOn: "2026-01-01" },
    ],
  };
  const results = [{ id: "a", state: "changed", sha256: "new-a" }, { id: "b", state: "new", sha256: "new-b" }, { id: "c", state: "unreachable", error: "HTTP 500" }];
  const out = applyAccept(manifest, ["a", "b", "c", "zz"], results, "2026-11-02");
  assert.deepEqual(out.accepted, ["a", "b"]);
  assert.deepEqual(out.refused.map((r) => r.id), ["c", "zz"]);
  assert.match(out.refused[0].reason, /HTTP 500/);
  assert.deepEqual(Object.keys(out.manifest.sources[0]), ["id", "url", "target", "sha256", "checkedOn", "discover"]);
  assert.deepEqual(Object.keys(out.manifest.sources[1]), ["id", "url", "target", "sha256", "checkedOn"]);
  assert.equal(out.manifest.sources[1].sha256, "new-b");
  assert.equal(out.manifest.sources[2].sha256, "keep");
  assert.equal(manifest.sources[0].sha256, "old", "input is not mutated");
  assert.deepEqual(applyAccept(manifest, ["a"], undefined, "2026-11-02").refused.map((r) => r.id), ["a"]);
});

test("nudge: never checked, fresh, stale; withNudge appends the line", () => {
  const dir = tmp();
  const now = Date.parse("2026-11-01T12:00:00Z");
  assert.equal(knowledgeNudge(dir, 30, now), "knowledge: sources never checked (foreman knowledge check)");
  const stateDir = path.join(dir, "pi-foreman", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const write = (iso: string) => fs.writeFileSync(path.join(stateDir, "knowledge-check.json"), JSON.stringify({ checkedAt: iso, results: [] }));
  write("2026-10-20T12:00:00Z");
  assert.equal(knowledgeNudge(dir, 30, new Date(now)), null);
  write("2026-09-01T12:00:00Z");
  assert.equal(knowledgeNudge(dir, 30, now), "knowledge: sources last checked 61 days ago (foreman knowledge check)");
  assert.equal(withNudge("report", dir, 30, now), "report\nknowledge: sources last checked 61 days ago (foreman knowledge check)");
  assert.equal(withNudge("report", dir, 90, now), "report");
  assert.equal(withNudge("report", dir, undefined, now).split("\n").length, 2, "bad config value falls back to 30");
});

test("CLI check in fixture mode writes the cache and the state file, exit 0; nudge then stays silent", () => {
  const fixtures = tmp();
  const agentDir = tmp();
  fs.writeFileSync(path.join(fixtures, "skills-best-practices"), PAGE);
  fs.writeFileSync(path.join(fixtures, "claude-prompting"), `<main><p>Index</p><a href="/docs/en/build-with-claude/prompt-engineering/prompting-claude-zeta-9">Zeta</a></main>`);
  const env = { ...process.env, PI_FOREMAN_KNOWLEDGE_FIXTURE_DIR: fixtures };
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" });

  const r = run("check", "--json", "--agent-dir", agentDir);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  const by = Object.fromEntries(report.results.map((x: { id: string }) => [x.id, x]));
  assert.equal(by["skills-best-practices"].sha256, hashText(normalise(PAGE)));
  assert.equal(by["fold-subagents"].state, "unreachable");
  assert.equal(by["claude-prompting"].discovered[0].url, "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-zeta-9");
  assert.equal(fs.readFileSync(path.join(agentDir, "pi-foreman", "knowledge", "skills-best-practices.md"), "utf8"), normalise(PAGE));
  const state = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-foreman", "state", "knowledge-check.json"), "utf8"));
  assert.equal(state.results.length, report.results.length);

  const text = run("check", "--agent-dir", agentDir);
  assert.match(text.stdout, /^unreachable fold-subagents {2}\(fixture missing\)$/m);
  assert.match(text.stdout, /^knowledge: \d+ sources, /m);
  assert.equal(run("nudge", "--agent-dir", agentDir).stdout, "");
  assert.match(run("nudge", "--agent-dir", tmp()).stdout, /never checked/);
});
