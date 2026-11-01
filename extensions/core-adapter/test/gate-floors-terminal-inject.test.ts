// r79 item 4 (plan Addendum S3, S4): the terminal-inject floor and the perms-profile floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd }), env)?.rule ?? null;

test("terminal-inject denies a slash command, a short payload and key names", () => {
  for (const l of [
    "herdr pane send-text 1-2 '/session'",
    "herdr pane send-text 1-2 '/model opus'",
    "herdr pane send-text 1-2 'hello\n/quit'",
    "herdr pane send-keys 1-2 Enter",
    "herdr pane send-keys 1-2 y",
    "herdr pane send-keys 1-2 1",
    "herdr pane send-text 1-2 ok",
    "herdr pane send-keys 1-2 Escape",
    "herdr pane send-keys 1-2 C-c",
    "herdr pane send-keys 1-2 Up",
    "herdr pane send-keys 1-2 F5",
    "herdr pane send-text 1-2 'please press Enter now'",
    "tmux send-keys -t 1 Enter",
    "tmux send-keys -t 1 '/clear'",
    `osascript -e 'tell application "System Events" to keystroke "y"'`,
  ]) assert.equal(floor(l), "floor-terminal-inject", l);
});

test("terminal-inject lets a full sentence through (danger-inject decides later); reads are no injection", () => {
  for (const l of [
    "herdr pane send-text 1-2 'please summarise the ledger and report back'",
    "herdr pane send-keys 1-2 'please summarise the ledger'",
    "herdr pane read 1-2",
    "herdr pane list",
    "tmux list-panes",
    "echo 'herdr pane send-keys 1-2 Enter' >> notes.md",
  ]) assert.equal(floor(l), null, l);
});

test("perms-profile: setting the variable or passing --profile to session open is denied", () => {
  for (const l of [
    "PI_FOREMAN_PERMS_PROFILE=steward pi",
    "export PI_FOREMAN_PERMS_PROFILE=steward",
    "env PI_FOREMAN_PERMS_PROFILE=steward foreman session open",
    "bash -c 'PI_FOREMAN_PERMS_PROFILE=steward foreman session open'",
    "foreman session open --profile steward",
    "foreman session open x --profile steward",
    "python3 scripts/foreman_session.py open --profile steward",
    "$env:PI_FOREMAN_PERMS_PROFILE = 'steward'",
    "unset PI_FOREMAN_PERMS_PROFILE",
  ]) assert.equal(floor(l), "floor-perms-profile", l);
  for (const l of ["foreman session open", "foreman session list", "echo $PI_FOREMAN_PERMS_PROFILE", "grep profile docs/permissions.md"]) assert.equal(floor(l), null, l);
});
