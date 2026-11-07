// Mermaid sidecars (mermaid.ts): fence scanning against the shared fixture, flatten and validate, caps, timeout, missing module.
// Every case runs without beautiful-mermaid installed (stub engines); the one real render skips when the package is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { countItems, createEngine, diagramName, fenceRefusal, fenceSha, FENCES_MAX, FENCE_MAX_BYTES, flatten, ITEMS_MAX, MermaidMissing, renderSidecars, scanFences, SIDECAR_RE, validateSvg } from "../mermaid.ts";
import type { Engine, Fence } from "../mermaid.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "tests", "fixtures", "mermaid-fences.json"), "utf8")).cases as { name: string; markdown: string; fences: Fence[] }[];

const GOOD = '<svg width="10" height="10" style="--bg:#fff"><style>@import url(x)</style><rect fill="var(--bg)"/><text>a</text></svg>';
const stub = (svg: string | (() => Promise<string>) = GOOD): Engine & { calls: number } => {
  const e = { calls: 0, render: async () => { e.calls++; return typeof svg === "string" ? svg : svg(); }, close: () => undefined };
  return e;
};
const memIo = (have: Set<string> = new Set()) => {
  const files = new Map<string, string>();
  const traces: Record<string, unknown>[] = [];
  return { files, traces, io: { write: async (n: string, d: string) => void files.set(n, d), trace: (r: Record<string, unknown>) => void traces.push(r), has: (n: string) => have.has(n) || files.has(n) } };
};
const fence = (text: string): Fence => ({ text, sha: fenceSha(text) });

test("scanFences matches every case of the shared fixture", () => {
  assert.ok(FIX.length >= 10);
  for (const c of FIX) assert.deepEqual(scanFences(c.markdown), c.fences, c.name);
});

test("scanFences: CRLF hashes like LF, exactly one final newline is dropped, sha is sha256 of UTF-8", () => {
  const lf = scanFences("```mermaid\ngraph TD\nA-->B\n```\n");
  const crlf = scanFences("```mermaid\r\ngraph TD\r\nA-->B\r\n```\r\n");
  assert.equal(lf.length, 1);
  assert.deepEqual(crlf, lf);
  assert.equal(lf[0].text, "graph TD\nA-->B");
  assert.equal(scanFences("```mermaid\nA-->B\n\n```\n")[0].text, "A-->B\n");
  assert.match(lf[0].sha, /^[0-9a-f]{64}$/);
  assert.equal(scanFences("```mermaid\nä-->ö\n```")[0].sha, fenceSha("ä-->ö"));
});

test("scanFences: an unclosed fence, an indented fence and a fence inside a longer fence give nothing", () => {
  assert.deepEqual(scanFences("```mermaid\ngraph TD\nA-->B\n"), []);
  assert.deepEqual(scanFences("  ```mermaid\nA-->B\n  ```\n"), []);
  assert.deepEqual(scanFences("````md\n```mermaid\nA-->B\n```\n````\n"), []);
});

test("flatten: no style, no var(), a background rect, font-family on text; validate accepts it", () => {
  for (const theme of ["dark", "light"] as const) {
    const out = flatten(GOOD, theme);
    assert.doesNotMatch(out, /<style|var\(|@import|style=/);
    assert.match(out, /<rect x="0" y="0" width="10" height="10" fill="#/);
    assert.match(out, /<text font-family=/);
    assert.equal(validateSvg(out), null);
  }
  assert.notEqual(flatten(GOOD, "dark"), flatten(GOOD, "light"));
});

test("validateSvg refuses what the allow-list does not name", () => {
  const w = (body: string) => `<svg>${body}</svg>`;
  const cases: [string, string][] = [
    [w("<script>1</script>"), "active_content"],
    [w("<foreignObject/>"), "active_content"],
    [w('<a href="https://x">t</a>'), "href"],
    [w('<rect onclick="x()"/>'), "event_attribute"],
    [w('<rect fill="url(https://x/y)"/>'), "url"],
    [w('<rect style="fill:var(--x)"/>'), "var"],
    [w("<!-- c -->"), "declaration"],
    [w("<image/>"), "element:image"],
    ["<div/>", "not_svg"],
    [w("<rect/>").padEnd(512 * 1024 + 10, " "), "too_large"],
  ];
  for (const [svg, why] of cases) assert.equal(validateSvg(svg), why, why);
  assert.equal(validateSvg(w('<defs><marker id="a"/></defs><line marker-end="url(#a)"/>')), null);
});

test("caps: oversized fence, more than 200 nodes plus edges, more than 32 fences", async () => {
  assert.equal(fenceRefusal(fence("graph TD\n" + "A-->B\n".repeat(FENCE_MAX_BYTES))), "fence_too_large");
  const many = "graph TD\n" + Array.from({ length: ITEMS_MAX + 1 }, (_, i) => `N${i}-->M${i}`).join("\n");
  assert.ok(countItems(many) > ITEMS_MAX);
  assert.equal(fenceRefusal(fence(many)), "too_many_items");
  assert.equal(fenceRefusal(fence("graph TD\nA-->B")), null);

  const engine = stub();
  const { io, files, traces } = memIo();
  const big = [fence("graph TD\n" + "A-->B\n".repeat(FENCE_MAX_BYTES)), fence(many)];
  assert.deepEqual(await renderSidecars(engine, big, io), []);
  assert.equal(engine.calls, 0);
  assert.equal(files.size, 0);
  assert.deepEqual(traces.map((t) => t.outcome), ["fence_too_large", "too_many_items"]);

  const lots = Array.from({ length: FENCES_MAX + 8 }, (_, i) => fence(`graph TD\nA${i}-->B`));
  const shas = await renderSidecars(stub(), lots, memIo().io);
  assert.equal(shas.length, FENCES_MAX);
});

test("renderSidecars: sidecar names are <64 hex>-dark|light.svg, only missing ones are rendered, a refused SVG writes nothing", async () => {
  const f = fence("graph TD\nA-->B");
  const m = memIo();
  const engine = stub();
  assert.deepEqual(await renderSidecars(engine, [f], m.io), [f.sha]);
  assert.deepEqual([...m.files.keys()].sort(), [`${f.sha}-dark.svg`, `${f.sha}-light.svg`]);
  for (const n of m.files.keys()) assert.match(n, SIDECAR_RE);
  assert.equal(diagramName(f.sha, "dark"), `${f.sha}-dark.svg`);
  assert.equal(engine.calls, 2);
  await renderSidecars(engine, [f], m.io);
  assert.equal(engine.calls, 2, "present sidecars are not rendered again");

  const half = memIo(new Set([`${f.sha}-dark.svg`]));
  const e2 = stub();
  await renderSidecars(e2, [f], half.io);
  assert.equal(e2.calls, 1);
  assert.deepEqual([...half.files.keys()], [`${f.sha}-light.svg`]);

  const bad = memIo();
  assert.deepEqual(await renderSidecars(stub("<svg><script>x</script></svg>"), [f], bad.io), []);
  assert.equal(bad.files.size, 0);
  assert.equal(bad.traces[0].outcome, "refused");
});

test("a render past the timeout is cut off, traced, and the next fence still renders", async () => {
  const f1 = fence("graph TD\nA-->B");
  const f2 = fence("graph TD\nC-->D");
  let n = 0;
  const engine = createEngine({
    timeoutMs: 40,
    useWorker: false,
    load: async () => ({ renderMermaid: () => (++n <= 1 ? new Promise<string>(() => undefined) : Promise.resolve(GOOD)) }),
  });
  const m = memIo();
  const shas = await renderSidecars(engine, [f1, f2], m.io);
  engine.close();
  assert.deepEqual(shas, [f2.sha]);
  assert.ok(m.traces.some((t) => t.outcome === "timeout"));
});

test("a missing module is reported once and stops the batch; nothing is written", async () => {
  let missing = 0;
  const engine = createEngine({ useWorker: false, load: async () => null, onMissing: () => void missing++ });
  const m = memIo();
  assert.deepEqual(await renderSidecars(engine, [fence("graph TD\nA-->B"), fence("graph TD\nC-->D")], m.io), []);
  await assert.rejects(engine.render("graph TD\nA-->B", "dark"), MermaidMissing);
  engine.close();
  assert.equal(missing, 1);
  assert.equal(m.files.size, 0);
});

const have = await import("beautiful-mermaid" as string).then(() => true, () => false);

test("real render through the worker yields a valid flattened SVG for both themes", { skip: !have && "beautiful-mermaid is not installed" }, async () => {
  const engine = createEngine({ timeoutMs: 10000 });
  const f = fence("graph TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]");
  const m = memIo();
  try {
    assert.deepEqual(await renderSidecars(engine, [f], m.io), [f.sha], JSON.stringify(m.traces));
  } finally {
    engine.close();
  }
  for (const n of m.files.keys()) assert.equal(validateSvg(m.files.get(n)!), null, n);
  assert.equal(m.files.size, 2);
});
