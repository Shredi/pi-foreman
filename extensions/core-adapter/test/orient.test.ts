import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildOrientation, collectOrientation } from "../orient.ts";

const reads = { warn: 4, deny: 8 };
const files = ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts", "src/top.ts", "tests/t.py", "README.md", "package.json", "Cargo.toml", "pyproject.toml"];
const base = { files, agentsMd: null, readmeMd: "# Title\nline2", packageJson: '{"scripts":{"test":"x","build":"y"}}', reads, maxLines: 120 };

test("orient: tree with counts, depth 2, root files, hint with the budget", () => {
  const t = buildOrientation(base);
  assert.ok(t.includes("src/ (4)\n  src/a/ (2)\n  src/b/ (1)\ntests/ (1)\nroot files: Cargo.toml, README.md, package.json, pyproject.toml"));
  assert.ok(t.includes("launch the explorer. Your read budget before the first launch is 4/8"));
});

test("orient: tree is capped with a +N more line", () => {
  const many = Array.from({ length: 200 }, (_, i) => `d${String(i).padStart(3, "0")}/f.txt`);
  const lines = buildOrientation({ ...base, files: many, readmeMd: null, maxLines: 500 }).split("\n");
  assert.ok(lines.includes("… +121 more"));
  assert.ok(lines.includes("d078/ (1)") && !lines.includes("d079/ (1)"));
});

test("orient: AGENTS.md wins over README.md and is cut at 30 lines", () => {
  const agents = Array.from({ length: 50 }, (_, i) => `rule ${i}`).join("\n");
  const t = buildOrientation({ ...base, agentsMd: agents });
  assert.ok(t.includes("## AGENTS.md (first 30 lines)") && t.includes("rule 29") && !t.includes("rule 30") && !t.includes("# Title"));
  assert.ok(buildOrientation(base).includes("## README.md"));
});

test("orient: toolchain lines in fixed order", () => {
  const t = buildOrientation({ ...base, files: [...files, "go.mod"] }).split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(t, ["- Cargo.toml: `cargo build` / `cargo test`", "- go.mod: `go build ./...` / `go test ./...`", "- package.json: `npm test` (scripts.test, scripts.build defined)", "- pyproject.toml: `python -m pytest`"]);
});

test("orient: maxLines caps the total and keeps the hint", () => {
  const t = buildOrientation({ ...base, agentsMd: "a\n".repeat(40), maxLines: 20 });
  assert.ok(t.split("\n").length <= 20);
  assert.ok(t.includes("explorer"));
});

test("orient: deterministic for any input order", () => {
  assert.equal(buildOrientation(base), buildOrientation({ ...base, files: [...files].reverse() }));
});

test("orient: collector prints relative paths only; no packet outside a git repo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orient-"));
  assert.equal(await collectOrientation(dir, { reads, maxLines: 120 }), "");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "x");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  g("add", ".");
  const t = await collectOrientation(dir, { reads, maxLines: 120 });
  assert.ok(t.includes("src/ (1)") && t.includes("hello"));
  assert.ok(!t.includes(dir) && !t.includes(os.homedir()));
});
