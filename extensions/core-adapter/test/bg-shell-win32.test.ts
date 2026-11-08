// remote-windows-2 item 4: on win32 foreman_bg runs through Pi's shell config (Git Bash, -c); cmd.exe only when it throws or
// wants stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shellFor, shellPathSetting } from "../bg.ts";

const bash = { shell: "C:\\Program Files\\Git\\bin\\bash.exe", args: ["-c"] };

test("shellFor win32: Git Bash from getShellConfig, command as the last arg, not verbatim", () => {
  let seen: string | undefined = "unset";
  const sh = shellFor("echo x", "win32", { getShellConfig: (p) => ((seen = p), bash), shellPath: "D:\\bash.exe" });
  assert.deepEqual(sh, { file: bash.shell, args: ["-c", "echo x"], verbatim: false });
  assert.equal(seen, "D:\\bash.exe");
});

test("shellFor win32: no shellPath passes undefined", () => {
  let seen: string | undefined = "unset";
  shellFor("x", "win32", { getShellConfig: (p) => ((seen = p), bash) });
  assert.equal(seen, undefined);
});

test("shellFor win32: a throwing getShellConfig falls back to cmd.exe", () => {
  const sh = shellFor("echo x", "win32", { getShellConfig: () => { throw new Error("no bash"); } });
  assert.match(sh.file, /cmd(\.exe)?$/i);
  assert.deepEqual(sh.args, ["/d", "/s", "/c", '"echo x"']);
  assert.equal(sh.verbatim, true);
});

test("shellFor win32: a stdin command transport falls back to cmd.exe", () => {
  const sh = shellFor("echo x", "win32", { getShellConfig: () => ({ ...bash, commandTransport: "stdin" }) });
  assert.equal(sh.verbatim, true);
});

test("shellFor linux ignores getShellConfig", () => {
  const sh = shellFor("echo x", "linux", { getShellConfig: () => { throw new Error("never"); } });
  assert.deepEqual(sh.args, ["-c", "echo x"]);
});

test("shellPathSetting: project .pi/settings.json wins over the agent dir", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pf-shellpath-"));
  const agent = path.join(d, "agent");
  const proj = path.join(d, "proj");
  fs.mkdirSync(agent);
  fs.mkdirSync(path.join(proj, ".pi"), { recursive: true });
  assert.equal(shellPathSetting(agent, proj), undefined);
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ shellPath: "A" }));
  assert.equal(shellPathSetting(agent, proj), "A");
  fs.writeFileSync(path.join(proj, ".pi", "settings.json"), JSON.stringify({ shellPath: "P" }));
  assert.equal(shellPathSetting(agent, proj), "P");
});
