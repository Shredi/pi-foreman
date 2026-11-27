// Brief-1: provider key files, password stores, keychains/keyrings, browser cookie stores, rclone/boto/s3cmd and Maven credentials are secret paths for the
// floor (a shell `cat`, the read tool) and for the judge's file reads; a Pi session file stays readable.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import { secretPath, SECRET_GLOBS, type FloorEnv } from "../floors.ts";
import { judgeReadScope, resolveReadable } from "../judgereads.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { posixOnly } from "./_platform.ts";

const base = fs.realpathSync(mkTestTmp("pf-secrets-"));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, "home");
const agent = path.join(home, ".pi", "agent");
const wt = path.join(base, "wt");

/** Each new entry, relative to the home dir. */
const ENTRIES = [
  ".anthropic/api_key", ".anthropic/config.json", ".password-store/web/site.gpg", ".m2/settings.xml",
  "Library/Keychains/login.keychain-db", ".local/share/keyrings/login.keyring", "AppData/Roaming/Microsoft/Credentials/ABCDEF", "AppData/Roaming/Microsoft/Protect/S-1-5/key",
  "Library/Cookies/Cookies.binarycookies", "AppData/Local/Google/Chrome/User Data/Default/Network/Cookies", "AppData/Local/Microsoft/Edge/User Data/Profile 1/Cookies",
  "Library/Application Support/Google/Chrome/Default/Cookies", "Library/Application Support/BraveSoftware/Brave-Browser/Default/Network/Cookies", ".config/chromium/Default/Cookies",
  ".config/google-chrome/Profile 2/Network/Cookies", ".config/rclone/rclone.conf", ".boto", ".s3cfg", ".mozilla/firefox/x.default/cookies.sqlite",
];
for (const e of ENTRIES) {
  fs.mkdirSync(path.dirname(path.join(home, e)), { recursive: true });
  fs.writeFileSync(path.join(home, e), "secret\n");
}
fs.mkdirSync(wt, { recursive: true });
const sessionFile = path.join(agent, "sessions", "--w--", "2026_s1.jsonl");
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.writeFileSync(sessionFile, '{"type":"session"}\n');

const env: FloorEnv = { platform: "linux", cwd: wt, home, agentDir: agent, writeRoots: [wt] };

test("the new globs are in the one list file", () => {
  for (const g of ["rclone.conf", ".boto", ".s3cfg", "cookies.sqlite"]) assert.ok(SECRET_GLOBS.includes(g), g);
});

test("the floor refuses every entry by its path, read or not", () => {
  for (const e of ENTRIES) {
    const p = path.join(home, e);
    assert.equal(secretPath(p, env)?.rule, "floor-secret-path", e);
    assert.equal(secretPath(p, env, true)?.rule, "floor-secret-path", `read: ${e}`);
    assert.equal(secretPath(`~/${e}`, env, true)?.rule, "floor-secret-path", `~ read: ${e}`);
  }
});

test("a shell `cat` of every entry is refused with the floor", { skip: posixOnly }, () => {
  const roots: GateRoots = { worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: false, agentDir: agent, home };
  for (const e of ENTRIES) {
    const line = `cat '${path.join(home, e)}'`;
    const r = gateEvaluate("bash", { command: line }, wt, { env: (c) => baseFloorEnv(c, { home, agentDir: agent }), roots: () => roots }).result as { block?: boolean; rule?: string } | undefined;
    assert.ok(r?.block && r.rule === "floor-secret-path", `${e}: ${JSON.stringify(r)}`);
  }
});

test("the judge's file read of every entry is withheld; a Pi session file and ordinary files stay readable", { skip: posixOnly }, () => {
  const scope = judgeReadScope({ cwd: wt, worktree: wt, agentDir: agent, home, platform: process.platform, config: undefined })!;
  for (const e of ENTRIES) assert.equal(resolveReadable(path.join(home, e), scope).outcome, "withheld", e);
  assert.equal(resolveReadable(sessionFile, scope).outcome, "ok");
  fs.writeFileSync(path.join(home, ".config", "chromium", "notes.txt"), "n\n");
  assert.equal(resolveReadable(path.join(home, ".config", "chromium", "notes.txt"), scope).outcome, "ok");
});

test("a name that only looks like an entry is no secret", () => {
  for (const w of [`${home}/.m2/repository/a.pom`, `${home}/.m2/settings.xml.example`, `${home}/Library/Application Support/App/Cookies.md`, `${home}/.config/app/CookiesNotes`, `${home}/src/anthropic/api.ts`]) assert.equal(secretPath(w, env, true), null, w);
});

test("win32: an 8.3 spelling of a new folder is refused", () => {
  const win: FloorEnv = { platform: "win32", cwd: "C:\\w", home: "C:\\Users\\me", agentDir: "C:\\Users\\me\\.pi\\agent", writeRoots: [] };
  for (const w of ["C:\\Users\\me\\PASSWO~1\\x.gpg", "C:\\Users\\me\\ANTHRO~1\\api_key", "C:\\Users\\me\\AppData\\Roaming\\MICROS~1\\Credentials\\x", "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\PROTEC~1\\x", "C:\\Users\\me\\Library\\KEYCHA~1\\x"]) {
    assert.equal(secretPath(w, win, true)?.rule, "floor-secret-path", w);
  }
});
