// R5 P2 SEC-fix (ledger 10, 11): the read-only python exemption holds only for a lone invocation, pythonReadOnlyCode fails closed,
// an owned-read root exempts only pure readers, and the async results root names this foreman's runs only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, pythonReadOnlyCode, readBaseline } from "../permoverlay.ts";
import type { MatchCtx } from "../permoverlay.ts";
import { asyncRunDirs, childReadable, childSurface, mainWorkflowReadable } from "../roundsurface.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-secfix-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

// F1 / F2: a child in a project whose package.json and config/foreman.defaults.json are protected
const ws = path.join(base, "ws");
const agent = path.join(base, "home", ".pi", "agent");
fs.mkdirSync(path.join(ws, "config"), { recursive: true });
fs.mkdirSync(agent, { recursive: true });
fs.writeFileSync(path.join(ws, "package.json"), "{}\n");
fs.writeFileSync(path.join(ws, "config", "foreman.defaults.json"), "{}\n");
const wsRules = buildOverlayRules(baseline, {}, {}, agent, ws, undefined, false);
const child: MatchCtx = { cwd: ws, home: path.join(base, "home"), platform: process.platform, role: "child" };
const sh = (command: string): string => checkToolCall(wsRules, "bash", { command }, child)?.kind ?? "pass";

test("F1: a read-only python script alone passes; any other write on the line stays denied", { skip: !posix }, () => {
  const py = `python3 -c "print(open('package.json').read())"`;
  assert.equal(sh(`python3 -c "import json;print(list(json.load(open('config/foreman.defaults.json'))))"`), "pass");
  assert.equal(sh(py), "pass");
  for (const tail of ["sed -i '' s/a/b/ package.json", "rsync x package.json", "chmod 600 package.json", "dd of=package.json", "xxd -r x package.json"]) {
    for (const join of ["; ", " && ", " || ", "\n"]) assert.notEqual(sh(`${py}${join}${tail}`), "pass", `${join} ${tail}`);
  }
  assert.notEqual(sh(`${py} > package.json`), "pass");
  assert.notEqual(sh(`${py} | tee package.json`), "pass");
});

test("F2: pythonReadOnlyCode fails closed on sys and module-reaching or writing shapes", () => {
  assert.equal(pythonReadOnlyCode("import json;print(list(json.load(open('config/foreman.defaults.json'))))"), true);
  assert.equal(pythonReadOnlyCode("print(open('package.json').read())"), true);
  for (const code of [
    "import sys;sys.modules['os'].rename('a.txt','package.json')",
    "import sys;print(sys.argv)",
    "import os;os.rename('a','b')",
    "import importlib",
    "import json;json.dump({}, open('x','w'))",
    "print(open('x').read().replace('a','b'))",
    "print(open('x').write('a'))",
    "import re;re.__builtins__",
    "print(eval('1'))",
    "print(getattr(open('x'),'read')())",
  ]) assert.equal(pythonReadOnlyCode(code), false, code);
  assert.notEqual(sh(`python3 -c "import sys;sys.modules['os'].rename('a.txt','package.json')"`), "pass");
});

// F3: owned read root for a builder
const main = path.join(base, "repo");
const rt = path.join(base, "repo.worktrees", "round");
const scratch = path.join(base, "scratch");
for (const d of [path.join(main, ".workflow"), path.join(rt, "scripts"), scratch]) fs.mkdirSync(d, { recursive: true });
const ledger = path.join(main, ".workflow", "LEDGER-x.md");
fs.writeFileSync(ledger, "- [ ] 1. item\n");
fs.writeFileSync(path.join(rt, "scripts", "x.py"), "pass\n");
const mainRules = buildOverlayRules(baseline, { paths: { deny: [`${main}/*`] } }, {}, path.join(base, "agent"), pkgRoot, undefined, false);
const run = (command: string): string => {
  const s = childSurface([rt], rt, "builder", process.platform, (d) => (d.startsWith(rt) ? rt : null));
  const readable = [...childReadable(ledger, [], [rt], process.platform), ...mainWorkflowReadable([rt], process.platform)];
  return checkToolCall(mainRules, "bash", { command }, { cwd: rt, home: base, platform: process.platform, role: "child", scratch, roundRoots: s.write, roundReadRoots: s.read, readable })?.kind ?? "pass";
};

test("F3: the owned read root exempts pure readers, never a script or test run", { skip: !posix }, () => {
  assert.equal(run(`cat ${ledger}; git log --oneline -3`), "pass");
  assert.notEqual(run(`python3 scripts/x.py --out ${ledger}`), "pass");
  assert.notEqual(run(`python3 scripts/x.py --out ${path.join(main, ".workflow", "LEDGER-y.md")}`), "pass");
  assert.notEqual(run(`node scripts/x.js --out ${ledger}`), "pass");
});

// F4
test("F4: asyncRunDirs names the results file of a seen run, never the whole results dir", { skip: !posix }, () => {
  const uid = "/t/pi-subagents-uid-501";
  const out = asyncRunDirs([`${uid}/async-subagent-runs/abc/status.json`], "linux");
  assert.deepEqual(out.sort(), [`${uid}/async-subagent-results/abc.json`, `${uid}/async-subagent-runs/abc`].sort());
  assert.ok(!out.includes(`${uid}/async-subagent-results`));
  assert.deepEqual(asyncRunDirs([`${uid}/async-subagent-results`], "linux"), []);
});
