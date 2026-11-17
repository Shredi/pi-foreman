// Ledger 18(c): on win32 every self-modification rule reads a path component with trailing dots and/or spaces as the same name (Windows drops them), as the home
// rule already does. Each spelling gets the verdict and rule name of the plain spelling, pinned as literal values per role, write tool, shell and PowerShell.
// posix keeps a trailing dot as a different name; an ordinary file `src\a.ts.` is not caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";

type Role = "main" | "builder" | "reviewer";

const gate = (platform: string, role: Role, tool: string, input: Record<string, unknown>): string => {
  const win = platform === "win32";
  const child = role !== "main";
  const r: GateRoots = {
    worktree: win ? "C:\\w\\proj" : "/w/proj", scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child, role, tmpAccess: false,
    agentDir: win ? "C:\\Profiles\\u\\.pi\\agent" : "/w/home/.pi/agent", home: win ? "C:\\Profiles\\u" : "/w/home", realpath: () => null,
    sessionDir: win ? "C:\\Profiles\\u\\.pi\\agent\\sessions\\s1" : "/w/home/.pi/agent/sessions/s1",
    ...(role === "reviewer" ? { roundReadOnly: true } : {}),
  };
  const res = gateEvaluate(tool, input, r.worktree, { env: (c) => baseFloorEnv(c, { child, platform }), roots: () => r }).result as Record<string, unknown> | undefined;
  return res ? JSON.stringify({ block: res.block, allow: res.allow, ask: res.ask, rule: res.rule }) : "undecided";
};

const verdict = (kind: "ask" | "block" | "allow", rule: string): string => JSON.stringify(kind === "allow" ? { allow: true, rule } : kind === "ask" ? { ask: true, rule } : { block: true, rule });
const GT = String.fromCharCode(62);
const ALLOW = verdict("allow", "path-write-worktree");
const ROLES: Role[] = ["main", "builder", "reviewer"];
const SELF = (rule: string): Record<Role, string> => ({ main: verdict("ask", rule), builder: verdict("block", rule), reviewer: verdict("block", rule) });
const AGENT = "C:\\Profiles\\u\\.pi\\agent";

/** Each row: the plain spelling and its dotted spellings must all give the literal verdict of the role. */
const pin = (platform: string, role: Role, tool: string, make: (p: string) => Record<string, unknown>, plain: string, dotted: string[], want: string): void => {
  assert.equal(gate(platform, role, tool, make(plain)), want, `${role} plain ${plain}`);
  for (const p of dotted) assert.equal(gate(platform, role, tool, make(p)), want, `${role} ${p}`);
};

test("win32: write tool, `.claude` spelled with trailing dots or spaces equals the plain spelling", () => {
  const WANT = SELF("selfmod-project-claude");
  const dotted = [".claude.\\settings.json", ".claude. .\\settings.json", ".claude./settings.json", "C:\\w\\proj\\.claude.\\settings.json", ".claude \\settings.json"];
  for (const role of ["main", "builder"] as const) pin("win32", role, "write", (path) => ({ path, content: "x" }), ".claude\\settings.json", dotted, WANT[role]);
  pin("win32", "reviewer", "write", (path) => ({ path, content: "x" }), ".claude\\settings.json", dotted, WANT.reviewer);
  for (const role of ROLES) pin("win32", role, "edit", (path) => ({ path, edits: [] }), ".claude\\settings.json", [".claude.\\settings.json"], WANT[role]);
});

test("win32: shell redirect, cp and mv into the dotted spellings equal the plain spelling", () => {
  const WANT = SELF("selfmod-project-claude");
  for (const role of ROLES) {
    pin("win32", role, "bash", (command) => ({ command }), `echo x ${GT} .claude/settings.json`, [`echo x ${GT} .claude./settings.json`, `echo x ${GT} .claude. ./settings.json`, `echo x ${GT} C:/w/proj/.claude./settings.json`], WANT[role]);
    pin("win32", role, "bash", (command) => ({ command }), "cp a .claude/settings.json", ["cp a .claude./settings.json"], WANT[role]);
    pin("win32", role, "bash", (command) => ({ command }), "mv a .claude/settings.json", ["mv a .claude./settings.json"], WANT[role]);
  }
});

test("win32: PowerShell word with a dotted `.claude` equals the plain spelling", () => {
  const WANT = SELF("selfmod-project-claude");
  for (const role of ["main", "builder"] as const) {
    pin("win32", role, "powershell", (command) => ({ command }), "Set-Content -Path .claude\\settings.json -Value x", ["Set-Content -Path .claude.\\settings.json -Value x"], WANT[role]);
  }
});

test("win32: `.mcp.json.` and the `.pi.` spellings equal their plain spellings", () => {
  const rows: Array<[string, string, Record<Role, string>]> = [
    [".mcp.json", ".mcp.json.", SELF("selfmod-project-claude")],
    [".pi\\settings.json", ".pi.\\settings.json", SELF("selfmod-project-settings")],
    [".pi\\x.json", ".pi. \\x.json", SELF("selfmod-project-pi")],
  ];
  for (const role of ROLES) for (const [plain, dotted, want] of rows) pin("win32", role, "write", (path) => ({ path, content: "x" }), plain, [dotted], want[role]);
});

test("win32: the agent-level rules fold trailing dots too (agent settings, session dir, pi-foreman state)", () => {
  const rows: Array<[string, string[], Record<Role, string>]> = [
    [`${AGENT}\\settings.json`, [`${AGENT}\\settings.json.`, `${AGENT}.\\settings.json`], SELF("selfmod-agent-settings")],
    [`${AGENT}\\sessions\\s1`, [`${AGENT}\\sessions\\s1.`, `${AGENT}\\sessions.\\s1`], SELF("selfmod-session-dir")],
    [`${AGENT}\\pi-foreman\\state\\round-parents.json`, [`${AGENT}\\pi-foreman\\state.\\round-parents.json`, `${AGENT}\\pi-foreman\\state\\round-parents.json.`, `${AGENT}\\pi-foreman.\\state\\round-parents.json`], SELF("selfmod-state")],
  ];
  for (const role of ["main", "builder"] as const) for (const [plain, dotted, want] of rows) pin("win32", role, "write", (path) => ({ path, content: "x" }), plain, dotted, want[role]);
});

test("win32: ordinary names with dots or spaces stay allowed in the worktree (main, write tool)", () => {
  for (const path of ["src\\a.ts", "src\\a.ts.", "notes. \\x.md", "...", "...\\x", " \\x"]) assert.equal(gate("win32", "main", "write", { path, content: "x" }), ALLOW, path);
  for (const path of ["src\\a.ts", "src\\a.ts."]) assert.equal(gate("win32", "builder", "write", { path, content: "x" }), ALLOW, `builder ${path}`);
});

// KNOWN LIMIT: a stream suffix on a FOLDER component is not folded, so this write is allowed today. When a later fix blocks it, update this row.
test("known limit: win32 `.claude::$INDEX_ALLOCATION\\settings.json` is not caught (main, write tool)", () => {
  assert.equal(gate("win32", "main", "write", { path: ".claude::$INDEX_ALLOCATION\\settings.json", content: "x" }), JSON.stringify({ allow: true, rule: "path-write-worktree" }));
});

test("posix: `.claude./settings.json` is an ordinary name, unchanged", () => {
  for (const platform of ["linux", "darwin"]) {
    for (const role of ["main", "builder"] as const) {
      assert.equal(gate(platform, role, "write", { path: ".claude./settings.json", content: "x" }), ALLOW, `${platform} ${role}`);
      assert.equal(gate(platform, role, "write", { path: ".claude/settings.json", content: "x" }), SELF("selfmod-project-claude")[role], `${platform} ${role} plain`);
    }
  }
});
