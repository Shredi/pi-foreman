// SEC-fix-2 G1/G2: the read-only inline python filter is a strict allowlist (fails closed); asyncRunDirs refuses `.`/`..` run segments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pythonReadOnlyCode } from "../permoverlay.ts";
import { asyncRunDirs } from "../roundsurface.ts";

test("G1: the 8f read-only literals pass", () => {
  assert.equal(pythonReadOnlyCode("import json;print(list(json.load(open('config/foreman.defaults.json'))))"), true);
  assert.equal(pythonReadOnlyCode("import json;d=1"), false);
  assert.equal(pythonReadOnlyCode("import json;print(sorted(json.load(open('a.json','r')).keys()))"), true);
  assert.equal(pythonReadOnlyCode("import json;print(json.load(open('a.json'))['name'])"), true);
  assert.equal(pythonReadOnlyCode("print(open('a.txt').read())"), true);
});

test("G1: everything outside the allowlist is not read-only", () => {
  for (const code of [
    "import sys;sys.modules['os'].rename('a.txt','package.json')",
    "import json;json.__class__",
    "import json;print(list(json.load(open('caf\u00e9.json'))))",
    "print(\u00e9)",
    "print(open('pack' 'age.json').read())",
    "open('x','w')",
    "exec(open('x').read())",
    "import io;io.open('x','w')",
    "import pathlib;pathlib.Path('x').write_text('y')",
    "print(open('a\\x2ejson').read())",
    "print(open(f'a.json').read())",
    "print(open(b'a.json').read())",
    "print(open(r'a.json').read())",
    "import json,os",
    "from json import load",
    "x=open;x('a','w')",
    "print(open('a',mode='w'))",
    "print(open('a'+'b'))",
    "print(open(chr(97)))",
    "with open('a') as f: print(f)",
    "print((lambda: 1)())",
    "print(open('a').write('x'))",
  ]) assert.equal(pythonReadOnlyCode(code), false, code);
});

test("G2: asyncRunDirs refuses `.` and `..` run segments", () => {
  const tmp = "/t/pi-subagents-uid-1";
  const got = asyncRunDirs([`${tmp}/async-subagent-runs/..`, `${tmp}/async-subagent-runs/.`, `${tmp}/async-subagent-results/...json`, `${tmp}/async-subagent-results/..json`, `${tmp}/async-subagent-runs/../x`], "linux");
  for (const d of got) assert.ok(!/\/\.\.?(\/|$)/.test(d) && !d.endsWith("/.."), d);
  assert.deepEqual(asyncRunDirs([`${tmp}/async-subagent-runs/r1`], "linux"), [`${tmp}/async-subagent-results/r1.json`, `${tmp}/async-subagent-runs/r1`]);
});
