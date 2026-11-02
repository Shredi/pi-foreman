// Preload for test:node (node --import): a session opened by `foreman session open` carries the parent env; the tests set their own.
// The names come from session-env.json, the list tests/_isolation.py and _r46world.ts share.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { keys, prefixes } = JSON.parse(fs.readFileSync(new URL("./session-env.json", import.meta.url), "utf8"));
for (const k of keys) delete process.env[k];
// A runner inside a Herdr pane must not hand its pane to the adapters under test: their presence files would name it.
for (const k of Object.keys(process.env)) if (prefixes.some((p) => k.startsWith(p))) delete process.env[k];

// No test may reach the real `gh` (the open-PRs refresher of an adapter session runs it): a fake `gh` first on PATH records each
// call's arguments in FOREMAN_FAKE_GH_LOG and fails. r78-fake-gh.test.ts proves the interception. POSIX only: Node cannot exec a
// .cmd stub without a shell, so on Windows the variable stays unset and that test skips.
if (process.platform !== "win32") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-fake-gh-"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(log, "");
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.FOREMAN_FAKE_GH_LOG = log;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
