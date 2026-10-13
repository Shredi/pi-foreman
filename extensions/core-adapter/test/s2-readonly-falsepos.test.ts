// R5 P2 S2 (ledger 10): pure reads naming a protected path are not write-protection hits; real writes stay denied.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import type { Decision } from "../permoverlay.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-s2-ro-")));
after(() => fs.rmSync(repo, { recursive: true, force: true }));
fs.mkdirSync(path.join(repo, "config"), { recursive: true });
fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
fs.writeFileSync(path.join(repo, "config", "foreman.defaults.json"), "{}\n");
fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
const rules = buildOverlayRules(baseline, {}, {}, path.join(repo, "agent"), repo, undefined, true);

const run = (role: "main" | "child", command: string): Decision | null =>
  checkToolCall(rules, "bash", { command }, { cwd: repo, home: repo, platform: process.platform, role });

const READS = [
  "G=grep -rn --exclude-dir=node_modules --exclude-dir=.workflow --exclude-dir=.git",
  "cat config/foreman.defaults.json",
  `python3 -c "import json;print(list(json.load(open('config/foreman.defaults.json'))))"`,
  "cat package.json",
];

test("read-only shell commands naming protected paths pass (main and child)", { skip: !posix }, () => {
  for (const role of ["main", "child"] as const) for (const cmd of READS) assert.equal(run(role, cmd), null, `${role}: ${cmd}`);
});

test("real writes to those protected paths stay denied or asked", { skip: !posix }, () => {
  for (const cmd of [
    "echo x > package.json",
    "echo x >> config/foreman.defaults.json",
    "echo x | tee package.json",
    "sed -i '' s/a/b/ config/foreman.defaults.json",
    "cp a.txt package.json",
    "mv a.txt config/foreman.defaults.json",
  ]) assert.notEqual(run("child", cmd), null, `child: ${cmd}`);
  for (const role of ["main", "child"] as const) {
    for (const cmd of ["echo x > .git/config", "cp a.txt .git/HEAD", "G=grep -rn --exclude-dir=.git; echo x > .git/config"]) assert.equal(run(role, cmd)?.kind, "deny", `${role}: ${cmd}`);
  }
});

test("inline python that may write a protected file is still denied for a child", { skip: !posix }, () => {
  for (const cmd of [
    `python3 -c "open('package.json','w').write('x')"`,
    `python3 -c "open('package.json', 'a')"`,
    `python3 -c "import os;os.rename('a','package.json');print(open('package.json'))"`,
    `python3 -c "import json;p='package.json';print(open(p))"`,
    `python3 -c "import json;json.dump({}, open('config/foreman.defaults.json','w'))"`,
    `python3 -c "print(open('package.json')); o=open; o('package.json','w')"`,
    `python3 -c "from pathlib import Path;Path('package.json').write_text('x')"`,
  ]) assert.equal(run("child", cmd)?.kind, "deny", cmd);
});
