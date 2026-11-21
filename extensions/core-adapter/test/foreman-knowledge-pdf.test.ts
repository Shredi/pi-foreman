// foreman knowledge: a PDF source is hashed and cached as its raw bytes (`<id>.pdf`), stable across runs; one CLI spawn against a local fixture (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareSource, hashText } from "../../../scripts/foreman_knowledge.mjs";
import { trackedTmp } from "./_tmpbase.ts";

const mk = trackedTmp;

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "foreman_knowledge.mjs");
const tmp = () => mk("pf-knowledge-pdf-");
// Not valid UTF-8: the bytes must reach the hash untouched, so a decoded-text hash would differ.
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3, 0xff, 0xfe, 0x80, 0xc3, 0x28]), Buffer.from("\n%%EOF\n")]);
const rawSha = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

test("hashText of a PDF is the sha256 of its raw bytes, not of the decoded text", () => {
  assert.equal(hashText(PDF), rawSha(PDF));
  assert.notEqual(hashText(PDF), hashText(PDF.toString("utf8")));
});

test("CLI check hashes a PDF fixture by its raw bytes, caches it as <id>.pdf, and is stable across two runs", () => {
  const fixtures = tmp();
  const agentDir = tmp();
  fs.writeFileSync(path.join(fixtures, "agents-pdf"), PDF);
  const env = { ...process.env, PI_FOREMAN_KNOWLEDGE_FIXTURE_DIR: fixtures };
  const check = () => spawnSync(process.execPath, [SCRIPT, "check", "--json", "--agent-dir", agentDir], { env, encoding: "utf8" });

  const first = check();
  assert.equal(first.status, 0, first.stderr);
  const pdf1 = JSON.parse(first.stdout).results.find((x: { id: string }) => x.id === "agents-pdf");
  assert.equal(pdf1.sha256, rawSha(PDF));
  const cacheDir = path.join(agentDir, "pi-foreman", "knowledge");
  assert.deepEqual(fs.readFileSync(path.join(cacheDir, "agents-pdf.pdf")), PDF);
  assert.equal(fs.existsSync(path.join(cacheDir, "agents-pdf.md")), false);

  const second = check();
  assert.equal(second.status, 0, second.stderr);
  const pdf2 = JSON.parse(second.stdout).results.find((x: { id: string }) => x.id === "agents-pdf");
  assert.equal(pdf2.sha256, pdf1.sha256);
  assert.equal(compareSource({ id: "agents-pdf", sha256: pdf1.sha256 }, PDF).state, "unchanged");
});

test("a body that is not a PDF by content-type or magic is not treated as one", () => {
  const fixtures = tmp();
  const agentDir = tmp();
  fs.writeFileSync(path.join(fixtures, "agents-pdf"), "%PDX-1.7 not a pdf\n");
  const env = { ...process.env, PI_FOREMAN_KNOWLEDGE_FIXTURE_DIR: fixtures };
  const r = spawnSync(process.execPath, [SCRIPT, "check", "--json", "--agent-dir", agentDir], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const row = JSON.parse(r.stdout).results.find((x: { id: string }) => x.id === "agents-pdf");
  assert.equal(row.sha256, hashText("%PDX-1.7 not a pdf\n"));
  assert.equal(fs.existsSync(path.join(agentDir, "pi-foreman", "knowledge", "agents-pdf.md")), true);
});
