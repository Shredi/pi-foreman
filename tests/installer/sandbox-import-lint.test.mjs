// Every installer test that starts a process must import the HOME sandbox, so a child setup.mjs cannot write the developer's real shell startup files.
import { test } from "node:test";
import "./_sandbox-home.mjs";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("every installer test that spawns a process imports ./_sandbox-home.mjs", () => {
  const offenders = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs"))
    .filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      return /spawn|execFile/.test(src) && !/^import\s+["']\.\/_sandbox-home\.mjs["'];?/m.test(src);
    });
  assert.deepEqual(offenders, []);
});
