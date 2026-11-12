// The claude-bridge login: where the isolated Claude Code config folder lives and which signs of a login it holds. Shared by setup.mjs and bridgeiso.ts (the doctor).
// Presence checks only: no credential content is read or printed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The isolation folder under the agent dir. */
export function isolationDir(agentDir) {
  return path.join(agentDir, "pi-foreman", "claude-config");
}

/** Claude Code's macOS keychain service for a non-default config dir. */
export function keychainService(dir) {
  return `Claude Code-credentials-${createHash("sha256").update(dir.normalize("NFC")).digest("hex").substring(0, 8)}`;
}

/** Presence only: `security find-generic-password -s` without -w/-g prints no secret. */
export const macKeychainProbe = (service) => {
  const r = spawnSync("security", ["find-generic-password", "-s", service], { stdio: "ignore", timeout: 5000 });
  return r.status === 0;
};

/** The signs of a login for the folder, one label each and lazily (a caller that needs one stops after the first): credentials file, keychain entry (macOS), CLAUDE_CODE_OAUTH_TOKEN. */
export function* loginSigns(dir, { env, platform, keychain = macKeychainProbe }) {
  if (fs.existsSync(path.join(dir, ".credentials.json"))) yield "credentials file";
  if (platform === "darwin" && keychain(keychainService(dir))) yield "keychain entry";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) yield "CLAUDE_CODE_OAUTH_TOKEN set";
}
