import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const docs = readFileSync(here("../../../docs/overlays.md"), "utf8");
const fixture = readFileSync(here("./fixtures/overlay-handshake.ts"), "utf8");

const norm = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

test("overlays.md Handshake snippet is the fixture's session_start body", () => {
  const handshake = docs.slice(docs.indexOf("## Handshake"));
  const m = /```ts\r?\n([\s\S]*?)```/.exec(handshake);
  assert.ok(m, "ts snippet under Handshake");
  const snippet = norm(m[1]);
  const lines = norm(fixture);
  const start = lines.indexOf(snippet[0]);
  assert.ok(start >= 0, "fixture contains the snippet's first line");
  assert.deepEqual(lines.slice(start, start + snippet.length), snippet);
});

test("overlays.md has a Tool or skill section naming the handshake symbol", () => {
  const i = docs.indexOf("## Tool or skill");
  assert.ok(i >= 0);
  const rest = docs.slice(i + 5);
  const end = rest.search(/\r?\n## /);
  assert.ok((end >= 0 ? rest.slice(0, end) : rest).includes('Symbol.for("pi-foreman.core.v1")'));
});
