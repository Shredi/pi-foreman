// r79 item 4 (plan Addendum S3): the terminal-inject check. Since PR C a slash command, a short payload or a key name is a judge-first hit (`danger-inject`), no
// deny; the perms-profile floor (S4) is gone with the profiles (policy-file and selfmod floors cover the files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/tmp"], protectedBranches: [], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const floor = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd }), env)?.rule ?? null;

test("terminal-inject: a slash command, a short payload and key names are judge-first hits", () => {
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
  ]) assert.equal(floor(l), "danger-inject", l);
});

test("terminal-inject: a full sentence is no floor hit (the JUDGE_FIRST entry danger-inject still judges it); reads are no injection", () => {
  for (const l of [
    "herdr pane send-text 1-2 'please summarise the ledger and report back'",
    "herdr pane send-keys 1-2 'please summarise the ledger'",
    "herdr pane read 1-2",
    "herdr pane list",
    "tmux list-panes",
    "echo 'herdr pane send-keys 1-2 Enter' >> notes.md",
  ]) assert.equal(floor(l), null, l);
});

test("profiles are gone: the profile variable and --profile are no floor hit any more", () => {
  for (const l of ["PI_FOREMAN_PERMS_PROFILE=steward pi", "foreman session open --profile steward", "unset PI_FOREMAN_PERMS_PROFILE", "foreman session open", "foreman session list"]) assert.equal(floor(l), null, l);
});
