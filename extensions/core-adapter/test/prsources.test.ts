import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inScope, noAnswerRun, parsePrSources, parseWire, runSource, sourceComments, sourceRuns } from "../prsources.ts";
import type { PrContext, SourceCfg } from "../prsources.ts";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tests", "fixtures", "fake_pr_source.mjs");
const CTX: PrContext = { host: "github.com", repo: "acme/widgets", number: 7, head: "abcdef0123456789", base: "main" };
const cfg = (mode: string, over: Partial<SourceCfg> = {}): SourceCfg => ({ name: "ci", argv: [process.execPath, FIX, mode], repos: null, timeoutMs: 20_000, gates: true, ...over });
const deps = () => ({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "pf-src-")), env: process.env, platform: process.platform });

test("parsePrSources: names, cap 8, github reserved, bounds, repos", () => {
  const raw: Record<string, unknown> = { github: { command: "x" }, "Bad Name": { command: "x" }, nocmd: {}, ok: { command: "tool --a {repo}", repos: ["Acme/*"], timeoutSeconds: 1, gates: false } };
  for (let i = 0; i < 9; i++) raw[`s${i}`] = { command: "t" };
  const { sources, errors } = parsePrSources(raw);
  assert.equal(sources.length, 8);
  assert.equal(sources[0].name, "ok");
  assert.deepEqual({ t: sources[0].timeoutMs, g: sources[0].gates, r: sources[0].repos }, { t: 5000, g: false, r: ["acme/*"] });
  assert.ok(errors.length >= 4);
  assert.equal(parsePrSources({ a: { command: "t", timeoutSeconds: 999 } }).sources[0].timeoutMs, 120_000);
  assert.equal(parsePrSources(undefined).sources.length, 0);
  assert.equal(inScope(sources[0], "ACME/widgets"), true);
  assert.equal(inScope(sources[0], "other/x"), false);
});

test("parseWire: unknown keys dropped, reserved id dropped, default ids", () => {
  const w = parseWire(JSON.stringify({ extra: 1, checks: [{ id: "(no answer)", name: "x", status: "passed" }, { name: "(no answer)", status: "passed" }, { id: "z", name: "z", status: "passed", extra: 1, url: "http://insecure" }, { name: "t", status: "failed" }, { name: "t", status: "passed" }, { name: "u", status: "failed", url: "https://ok.test/u" }] }));
  assert.ok(w);
  assert.deepEqual(w.checks.map((c) => c.id), ["z", "t@failed", "t@passed", "u@failed"]);
  assert.equal(w.checks[0].url, "");
  assert.equal(w.checks[3].url, "https://ok.test/u");
  assert.deepEqual(Object.keys(w.checks[0]).sort(), ["id", "name", "status", "url"]);
});

test("parseWire: only the comment body is redacted; ids and names keep their value", () => {
  const tok = `ghp_${"aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF3hJ5"}`;
  const w = parseWire(JSON.stringify({ checks: [{ name: "integrationTestsWindowsLatest", status: "failed" }], comments: [{ id: "1", kind: "review", author: "u", body: `see ${tok}` }] }));
  assert.ok(!JSON.stringify(w?.comments).includes("ghp_aB3"));
  assert.match(w?.comments[0].body ?? "", /see \[redacted\]/);
  assert.equal(w?.checks[0].name, "integrationTestsWindowsLatest");
  // control characters are stripped from an id before the reserved-name check
  assert.deepEqual(parseWire(JSON.stringify({ checks: [{ name: "(no answer)", status: "passed" }, { id: " (no answer) \u0007", name: "x", status: "passed" }] }))?.checks, []);
});

test("parseWire: ids that differ in one character stay distinct", () => {
  const a = "0123456789abcdef0123456789abcdef01234567";
  const b = a.slice(0, -1) + "8";
  const w = parseWire(JSON.stringify({
    checks: [{ id: a, name: "ci", status: "failed" }, { id: b, name: "ci", status: "failed" }],
    comments: ["PRRC_kwDOAbCdEfGhIjKlMnOpQrSt1", "PRRC_kwDOAbCdEfGhIjKlMnOpQrSt2"].map((id) => ({ id, kind: "review", author: "u", body: "b" })),
  }));
  assert.deepEqual(w?.checks.map((c) => c.id), [a, b]);
  assert.deepEqual(w?.comments.map((c) => c.id).sort(), ["PRRC_kwDOAbCdEfGhIjKlMnOpQrSt1", "PRRC_kwDOAbCdEfGhIjKlMnOpQrSt2"]);
});

test("parseWire: duplicate-named checks keep their ids when the list is reordered", () => {
  const ids = (checks: unknown[]): string[] => parseWire(JSON.stringify({ checks }))!.checks.map((c) => `${c.name}/${c.status}:${c.id}`).sort();
  const t = (status: string) => ({ name: "t", status });
  assert.deepEqual(ids([t("failed"), t("passed"), t("failed")]), ids([t("passed"), t("failed"), t("failed")]));
});

test("parseWire: shape, caps, redaction", () => {
  assert.equal(parseWire("nope"), null);
  assert.equal(parseWire("[]"), null);
  assert.equal(parseWire(JSON.stringify({ checks: "x" })), null);
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, kind: "issue", author: "a", createdAt: `2026-11-09T12:${String(i % 60).padStart(2, "0")}:00Z`, body: "b" }));
  const w = parseWire(JSON.stringify({ checks: Array.from({ length: 80 }, (_, i) => ({ id: `i${i}`, name: "n", status: "passed" })), comments: many }));
  assert.equal(w?.checks.length, 50);
  assert.equal(w?.comments.length, 40);
  const r = parseWire(JSON.stringify({ comments: [{ id: "1", kind: "issue", author: "a", bot: true, body: `tok ghp_abcdefghijklmnopqrstuvwxyz0123456789\u0007${"x".repeat(900)}`, line: 3, state: "changes_requested", path: "a.ts" }, { id: "2", kind: "weird", author: "a" }] }));
  assert.equal(r?.comments.length, 1);
  assert.ok(!r?.comments[0].body.includes("ghp_abcdef"));
  assert.ok(!r?.comments[0].body.includes("\u0007"));
  assert.ok((r?.comments[0].body.length ?? 999) <= 500);
  assert.equal(r?.comments[0].bot, true);
});

test("store conversion: ids bound to the head, names prefixed, comments tagged, no-answer run", () => {
  const c = cfg("ok", { gates: false });
  const runs = sourceRuns(c, "abcdef0123456789", [{ id: "j", name: "deploy", status: "failed", url: "" }]);
  assert.deepEqual(runs, [{ id: "ci:abcdef012345:j", name: "ci/deploy", bucket: "failed", url: "", source: "ci", gates: false }]);
  assert.deepEqual(noAnswerRun(cfg("ok")), { id: "ci:(no answer)", name: "ci/(no answer)", bucket: "pending", url: "", source: "ci", gates: true, noAnswer: true });
  const cm = sourceComments(c, [{ id: "1", kind: "review", author: "r", bot: true, createdAt: null, body: "b", path: "p" }]);
  assert.deepEqual(cm, [{ id: "ci:1", kind: "review", author: "r", body: "b", source: "ci", bot: true, path: "p" }]);
});

test("runSource: ok, placeholders and env, failures", async () => {
  const d = deps();
  const ok = await runSource(cfg("ok"), CTX, d);
  assert.equal(ok.outcome, "ok");
  assert.equal(ok.checks[0].status, "failed");
  const a = await runSource({ ...cfg("args"), argv: [process.execPath, FIX, "args", "{host}", "{repo}", "{number}", "{head}", "{base}", "x{repo}"] }, CTX, d);
  assert.equal(a.checks[0].name, "github.com|acme/widgets|7|abcdef0123456789|main|x{repo}");
  assert.deepEqual(JSON.parse(a.checks[1].name), { host: "github.com", repo: "acme/widgets", number: "7", head: "abcdef0123456789" });
  const f = await runSource(cfg("fail"), CTX, d);
  assert.equal(f.outcome, "failed");
  assert.match(f.error ?? "", /^boom/);
  assert.ok(!(f.error ?? "").includes("ghp_abcdef"));
  assert.equal((await runSource(cfg("bad"), CTX, d)).outcome, "bad_output");
  assert.equal((await runSource(cfg("big"), CTX, d)).outcome, "bad_output");
  assert.equal((await runSource(cfg("sleep", { timeoutMs: 300 }), CTX, d)).outcome, "timeout");
});

test("runSource: program lookup rules", async () => {
  const d = deps();
  assert.equal((await runSource({ ...cfg("ok"), argv: ["definitely-not-a-program-xyz"] }, CTX, d)).outcome, "program_missing");
  // under the state dir: refused
  const prog = path.join(d.stateDir, "tool.sh");
  fs.writeFileSync(prog, "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
  assert.equal((await runSource({ ...cfg("ok"), argv: [prog] }, CTX, d)).outcome, "program_missing");
  // .cmd refused
  const cmd = path.join(os.tmpdir(), `pf-src-${process.pid}.cmd`);
  fs.writeFileSync(cmd, "echo {}", { mode: 0o755 });
  try {
    assert.equal((await runSource({ ...cfg("ok"), argv: [cmd] }, CTX, d)).outcome, "program_missing");
  } finally {
    fs.rmSync(cmd, { force: true });
  }
  // a bare name found on PATH (the tracker's own cwd does not matter)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bin-"));
  const exe = path.join(bin, "pf-fake-source");
  fs.writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${FIX}" pass\n`, { mode: 0o755 });
  if (process.platform !== "win32") {
    const r = await runSource({ ...cfg("ok"), argv: ["pf-fake-source"] }, CTX, { ...d, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
    assert.equal(r.outcome, "ok");
  }
});
