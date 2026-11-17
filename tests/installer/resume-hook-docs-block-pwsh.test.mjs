// The hand-copy PowerShell block in docs/install.md must equal the powershell block setup/resume-hook.mjs generates (cli path replaced by the doc's
// `<cli>` placeholder, markers and the two comment lines left out), so the docs cannot drift from the generated hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
const { renderResumeBlock } = await import(pathToFileURL(path.join(ROOT, "setup", "resume-hook.mjs")).href);

test("docs/install.md hand block equals the generated powershell resume block", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "install.md"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout may use CRLF
  const m = doc.match(/replace `<cli>`[^\n]*\n\n```powershell\n([\s\S]*?)\n```/);
  assert.ok(m, "hand block not found in docs/install.md");
  const generated = renderResumeBlock({ bin: "x\\bin\\foreman", flavor: "powershell", cli: "<cli>" }).split("\n").slice(2, -1).join("\n");
  assert.equal(m[1], generated);
});
