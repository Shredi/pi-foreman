// The PowerShell block must not read a possibly unset global variable bare (Set-StrictMode -Version Latest in the user's profile rejects that); no PowerShell needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

test("the powershell block reads its globals and LASTEXITCODE only through Get-Variable -ErrorAction Ignore, and is ASCII", () => {
  const block = renderResumeBlock({ bin: "C:\\x\\bin\\foreman", flavor: "powershell", cli: "C:\\x\\cli.ts" });
  assert.ok(!/[^\x00-\x7f]/.test(block));
  for (const line of block.split("\n")) {
    const reads = line.replace(/\$global:(\w+)\s*=(?!=)/g, "").match(/\$global:\w+/g);
    assert.equal(reads, null, `bare global read in: ${line}`);
  }
  for (const name of ["__PiForemanResumeWrapped", "__PiForemanResumeSeen", "LASTEXITCODE", "__PiForemanOriginalPrompt"]) {
    assert.ok(block.includes(`Get-Variable -Name ${name} -Scope Global -ValueOnly -ErrorAction Ignore`), name);
  }
});
