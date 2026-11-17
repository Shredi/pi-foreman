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

// A setup run with PI_FOREMAN_HOME unset on win32 queries the real PowerShell for its Documents folder and writes the profiles there, so such a call must pin the folder with the test seam.
// A call pins its platform on its own line or in the file's first PI_FOREMAN_PLATFORM (the run helper's default); no platform at all means the host's, which may be win32.
test("every installer test that unsets PI_FOREMAN_HOME on win32 (or the host) also pins PI_FOREMAN_TEST_PS_DOCUMENTS on the same line", () => {
  const unset = "PI_FOREMAN_HOME: undefined";
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.mjs") && n !== "sandbox-import-lint.test.mjs")) {
    const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
    const fileDefault = lines.map((l) => l.match(/PI_FOREMAN_PLATFORM: "(\w+)"/)).find(Boolean)?.[1];
    lines.forEach((line, i) => {
      if (!line.includes(unset)) return;
      const platform = line.match(/PI_FOREMAN_PLATFORM: "(\w+)"/)?.[1] ?? fileDefault;
      if (platform === "linux" || platform === "darwin") return;
      if (!line.includes("PI_FOREMAN_TEST_PS_DOCUMENTS")) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
