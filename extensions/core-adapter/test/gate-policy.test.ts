import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, parsePolicy } from "../policy.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "gate-policy-"));
const put = (file: string, text: string): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const ids = (l: { entries: { id: string }[] } | null): string[] => (l ? l.entries.map((e) => e.id) : []);

test("the shipped policy loads with all four sections and unique ids", () => {
  const p = loadPolicy({ pkgRoot, agentDir: tmp(), cwd: tmp() });
  assert.deepEqual(p.warnings, []);
  const sections = new Set(p.trusted.entries.map((e) => e.section));
  assert.deepEqual([...sections].sort(), ["allow", "ask", "context", "deny"]);
  assert.equal(new Set(ids(p.trusted)).size, p.trusted.entries.length);
  assert.ok(ids(p.trusted).includes("secret-access"));
  assert.ok(p.project === null);
});

test("layer order: shipped, user, overlay files; duplicate ids are skipped with a warning", () => {
  const agent = tmp();
  put(path.join(agent, "pi-foreman", "policy.md"), "## deny\n- id: user-deny\n  no user thing\n- id: secret-access\n  dup\n");
  put(path.join(agent, "extra.md"), "## ask\n- id: overlay-ask\n  overlay thing\n");
  const p = loadPolicy({ pkgRoot, agentDir: agent, cwd: tmp(), files: ["extra.md"] });
  const list = ids(p.trusted);
  assert.ok(list.indexOf("read-only-inspection") < list.indexOf("user-deny"));
  assert.ok(list.indexOf("user-deny") < list.indexOf("overlay-ask"));
  assert.equal(list.filter((i) => i === "secret-access").length, 1);
  assert.ok(p.warnings.some((w) => w.includes("duplicate entry id")));
});

test("an unreadable overlay file is skipped and listed", () => {
  const p = loadPolicy({ pkgRoot, agentDir: tmp(), cwd: tmp(), files: ["missing.md"] });
  assert.ok(p.trusted.entries.length > 0);
  assert.ok(p.warnings.some((w) => w.includes("missing.md") && w.includes("skipped")));
});

test("the project layer keeps deny and ask only and warns about the rest", () => {
  const cwd = tmp();
  put(path.join(cwd, ".workflow", "policy.md"), "## allow\n- id: proj-allow\n  x\n## deny\n- id: proj-deny\n  y\n## ask\n- id: proj-ask\n  z\n## context\n- id: proj-ctx\n  c\n");
  const p = loadPolicy({ pkgRoot, agentDir: tmp(), cwd });
  assert.deepEqual(ids(p.project), ["proj-deny", "proj-ask"]);
  assert.ok(!ids(p.trusted).includes("proj-deny"));
  assert.equal(p.warnings.filter((w) => w.includes("may only tighten")).length, 2);
});

test("the hash is stable, covers trusted text only, and changes with it", () => {
  const agent = tmp();
  const a = loadPolicy({ pkgRoot, agentDir: agent, cwd: tmp() });
  const cwd = tmp();
  put(path.join(cwd, ".workflow", "policy.md"), "## deny\n- id: p\n  x\n");
  assert.equal(loadPolicy({ pkgRoot, agentDir: agent, cwd }).hash, a.hash);
  put(path.join(agent, "pi-foreman", "policy.md"), "## deny\n- id: u\n  x\n");
  assert.notEqual(loadPolicy({ pkgRoot, agentDir: agent, cwd }).hash, a.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test("a missing shipped policy gives an empty trusted layer and a warning, never a throw", () => {
  const p = loadPolicy({ pkgRoot: tmp(), agentDir: tmp(), cwd: tmp() });
  assert.deepEqual(p.trusted.entries, []);
  assert.ok(p.warnings.some((w) => w.includes("every review is denied")));
});

test("parsePolicy: bad ids and unknown sections warn", () => {
  const w: string[] = [];
  const e = parsePolicy("## Allow\n- id: Bad_ID\n  x\n- id: ok-id\n  multi\n    line\n## weird\n- id: lost\n  t\n", "f.md", w);
  assert.deepEqual(e.map((x) => x.id), ["ok-id"]);
  assert.equal(e[0].text, "multi\nline");
  assert.equal(w.length, 2);
});
