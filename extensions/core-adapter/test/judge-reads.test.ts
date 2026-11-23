// The judge's file reads (judgereads.ts): the folder bound, the exclusions, the race-safe open, the caps and the cache records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_READ_BUDGET, judgeReadScope, readHooks, readLogPaths, readPaths, readsUnchanged, resolveReadable } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-")));
const home = path.join(tmp, "home");
const agent = path.join(home, ".pi", "agent");
const wt = path.join(home, "proj");
const cwd = path.join(wt, "sub");
const out = path.join(tmp, "out");
const scratch = path.join(tmp, "scratch");
const outside = path.join(tmp, "elsewhere");
for (const d of [agent, cwd, out, scratch, outside]) fs.mkdirSync(d, { recursive: true });
const put = (p: string, text: string | Buffer = "x\n"): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const scope = (over: Partial<Parameters<typeof judgeReadScope>[0]> = {}): JudgeReadScope =>
  judgeReadScope({ cwd, worktree: wt, out, scratch, agentDir: agent, home, platform: process.platform, config: {}, ...over }) as JudgeReadScope;
const S = scope();
const one = (p: string, s: JudgeReadScope = S, budget = { left: MAX_READ_BUDGET }) => {
  const r = readPaths([p], s, budget);
  return { rec: r.records[0], block: r.blocks[0] };
};
const shown = (o: string): boolean => o === "ok" || o === "dir";

test("scope: reads off gives none; home, an ancestor of home, the disk root and a missing root are dropped", () => {
  assert.equal(judgeReadScope({ cwd, worktree: wt, agentDir: agent, home, config: { gate: { judgeReads: false } } }), undefined);
  const s = judgeReadScope({ cwd: home, worktree: tmp, out: path.join(tmp, "missing"), scratch: path.parse(tmp).root, agentDir: agent, home, config: {} }) as JudgeReadScope;
  assert.deepEqual(s.roots, []);
  assert.equal(one(path.join(home, "proj", "a.txt"), s).rec.outcome, "outside");
  const keep = scope();
  assert.deepEqual(keep.roots.map((r) => r.label), ["<worktree>", "<cwd>", "<out>", "<scratch>"]);
});

test("bound: worktree, cwd, out, scratch, agent sessions and pi-foreman are read; other agent parts are outside", () => {
  for (const p of [put(path.join(wt, "a.sh")), put(path.join(cwd, "b.sh")), put(path.join(out, "c.txt")), put(path.join(scratch, "d.txt")), put(path.join(agent, "sessions", "s", "x.jsonl")), put(path.join(agent, "pi-foreman", "state", "x.json")), put(path.join(agent, "AGENTS.md"))]) {
    assert.equal(one(p).rec.outcome, "ok", p);
  }
  for (const p of [put(path.join(agent, "extensions", "x.ts")), put(path.join(agent, "install", "x")), put(path.join(agent, "cc-cli-logs", "x")), put(path.join(agent, "npm", "x")), put(path.join(outside, "f.txt")), path.join(tmp, "elsewhere", "..", "elsewhere", "f.txt"), "/etc/hosts"]) {
    assert.ok(!shown(one(p).rec.outcome), p);
  }
  assert.equal(one("../a.sh").rec.outcome, "ok", "a relative path resolves against the cwd");
  assert.equal(one("../../../elsewhere/f.txt").rec.outcome, "outside", "a .. escape is refused");
  assert.equal(one(home).rec.outcome, "outside");
  assert.equal(one(path.dirname(home)).rec.outcome, "outside");
});

test("bound: the agent dir inside a project root keeps its allow list", () => {
  const s = judgeReadScope({ cwd: path.join(home, ".pi"), worktree: path.join(home, ".pi"), agentDir: agent, home, config: {} }) as JudgeReadScope;
  put(path.join(agent, "extensions", "y.ts"));
  assert.equal(one(path.join(agent, "extensions", "y.ts"), s).rec.outcome, "outside");
  assert.equal(one(path.join(agent, "sessions", "s", "x.jsonl"), s).rec.outcome, "ok");
  assert.equal(readLogPaths([one(path.join(agent, "sessions", "s", "x.jsonl"), s).rec], s)[0], "<agent>/sessions/s/x.jsonl");
});

test("bound: symlinks are followed to their real path", () => {
  const f = put(path.join(outside, "target.txt"), "secret place\n");
  const bad = path.join(wt, "link-out");
  const good = path.join(wt, "link-in");
  fs.symlinkSync(f, bad);
  fs.symlinkSync(path.join(wt, "a.sh"), good);
  const r = one(bad);
  assert.equal(r.rec.outcome, "outside");
  assert.ok(!r.block.body.includes("secret place"));
  assert.equal(one(good).rec.outcome, "ok");
  const toAuth = path.join(wt, "link-auth");
  put(path.join(agent, "auth.json"), '{"k":"v"}');
  fs.symlinkSync(path.join(agent, "auth.json"), toAuth);
  const a = one(toAuth);
  assert.ok(!shown(a.rec.outcome));
  assert.ok(!a.block.body.includes('"k"'));
});

test("case: names are matched case-insensitively on darwin and win32", { skip: !["darwin", "win32"].includes(process.platform) }, () => {
  put(path.join(wt, ".git", "HEAD"), "ref: x\n");
  put(path.join(agent, "AUTH.JSON"), "{}");
  put(path.join(agent, "pi-foreman", "x", "Mcp.Json"), "{}");
  assert.equal(one(path.join(wt, ".GIT", "HEAD")).rec.outcome, "withheld");
  assert.ok(!shown(one(path.join(agent, "Auth.Json")).rec.outcome));
  assert.equal(one(path.join(agent, "pi-foreman", "x", "MCP.JSON")).rec.outcome, "withheld");
});

test("withheld: secret, login, token, history, git and Claude names are never shown", () => {
  const names: string[] = [
    ".env", ".envrc", "x.pem", "id_ed25519", ".git/config", ".git/HEAD", ".bash_history", ".zsh_history", ".pgpass", ".vault-token", "a.tfvars", "terraform.tfstate.backup", ".claude/x.md", ".claude.json", "credentials.json", "sub/.history",
  ];
  for (const n of names) {
    const p = put(path.join(wt, "w", n), "SECRET-CONTENT\n");
    const r = one(p);
    assert.equal(r.rec.outcome, "withheld", n);
    assert.ok(!r.block.body.includes("SECRET-CONTENT"), n);
  }
  const inAgent = ["pi-foreman/x/mcp.json.bak-1", ".adb-mcp-backup/mcp.json", "claude-bridge/sessions/x.json", "pi-foreman/claude-config/.credentials.json", "pi-foreman/state/claudecfg-1.json", "pi-foreman/remote/x", "pi-foreman/state/models.json", "pi-foreman/state/trust.json", "auth.json", "models.json", "mcp.json"];
  for (const n of inAgent) {
    const p = put(path.join(agent, n), "SECRET-CONTENT\n");
    const r = one(p);
    assert.ok(!shown(r.rec.outcome), n);
    assert.ok(!r.block.body.includes("SECRET-CONTENT"), n);
  }
  put(path.join(wt, "ok.txt"), "fine\n");
  assert.equal(one(path.join(wt, ".gitignore") ).rec.outcome, "not-found", "a name that only starts like .git is no exclusion");
});

test("withheld: a file with a second hard link and a FIFO are not shown", () => {
  const f = put(path.join(wt, "h1.txt"), "linked\n");
  fs.linkSync(f, path.join(wt, "h2.txt"));
  const r = one(f);
  assert.equal(r.rec.outcome, "withheld");
  assert.ok(!r.block.body.includes("linked"));
  if (process.platform !== "win32") {
    const fifo = path.join(wt, "pipe");
    execFileSync("mkfifo", [fifo]);
    assert.equal(one(fifo).rec.outcome, "withheld");
  }
  assert.equal(one(path.join(wt, "a.sh") + "/").rec.outcome, "withheld", "a folder request on a file is refused");
});

test("race: a file swapped for another inode, and a folder swapped for a symlink, between the check and the open are changed", () => {
  const f = put(path.join(wt, "swap.txt"), "first\n");
  readHooks.afterStat = () => {
    fs.renameSync(put(path.join(wt, "swap.new"), "second\n"), f);
    readHooks.afterStat = undefined;
  };
  try {
    const r = one(f);
    assert.equal(r.rec.outcome, "changed");
    assert.ok(!r.block.body.includes("second"));
    const d = path.join(wt, "mid");
    const inner = put(path.join(d, "file.txt"), "inner\n");
    readHooks.afterStat = () => {
      fs.renameSync(d, `${d}.old`);
      fs.symlinkSync(`${d}.old`, d);
      readHooks.afterStat = undefined;
    };
    assert.equal(one(inner).rec.outcome, "changed");
  } finally {
    readHooks.afterStat = undefined;
  }
});

test("reading: 16 KiB cap with a marker, a line window, a window past the scan limit, binary files", () => {
  const big = put(path.join(wt, "big.txt"), Array.from({ length: 5000 }, (_, i) => `row ${i} ${"lorem ipsum dolor ".repeat(6)}`).join("\n"));
  const r = one(big);
  assert.ok(r.block.body.length < 16 * 1024 + 300, String(r.block.body.length));
  assert.ok(r.block.body.includes("[cut") && r.block.body.includes("#L"));
  const win = one(`${big}#L500-503`).block.body;
  assert.ok(win.includes("row 499 ") && win.includes("row 502 ") && !win.includes("row 498 ") && !win.includes("row 503 "), win);
  const huge = put(path.join(wt, "huge.txt"), Buffer.alloc(2 * 1024 * 1024, "abc def\n"));
  assert.match(one(`${huge}#L900000-900010`).block.body, /no lines from 900000/);
  const bin = put(path.join(wt, "b.bin"), Buffer.from([1, 2, 0, 3, 4]));
  const b = one(bin);
  assert.equal(b.rec.outcome, "binary");
  assert.match(b.block.body, /binary file, not shown/);
});

test("reading: a .jsonl file shows 40 lines of at most 1000 characters", () => {
  const f = put(path.join(agent, "sessions", "t", "a.jsonl"), Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
  const body = one(f).block.body;
  assert.ok(body.includes("line 39") && !body.includes("line 40"), body);
  const g = put(path.join(agent, "sessions", "t", "b.jsonl"), `${"a".repeat(3000)}\n`);
  const text = one(g).block.body;
  assert.ok(text.includes("[cut]") && !text.includes("a".repeat(1001)));
});

test("reading: the 64 KiB budget turns a later path into a budget block; secrets are masked", () => {
  const files = [1, 2, 3, 4, 5].map((n) => put(path.join(wt, `bud${n}.txt`), Array.from({ length: 3000 }, (_, i) => `n${n} row ${i} ${"lorem ipsum dolor ".repeat(6)}`).join("\n")));
  const budget = { left: MAX_READ_BUDGET };
  const r = readPaths(files, S, budget);
  assert.deepEqual(r.records.map((x) => x.outcome), ["ok", "ok", "ok", "ok", "budget"]);
  assert.match(r.blocks[4].body, /read budget used up/);
  const sec = put(path.join(wt, "sec.sh"), "export API_TOKEN=abc123verysecretvalue\necho ghp_abcdefghijklmnop1234\n");
  const body = one(sec).block.body;
  assert.ok(!body.includes("abc123verysecretvalue") && !body.includes("ghp_abcdefghijklmnop1234"), body);
});

test("reading: a listing hides excluded names and stops at 200", () => {
  const d = path.join(wt, "listing");
  for (const n of [".env", "id_rsa", "a.txt", ".git/x", "sub/y"]) put(path.join(d, n));
  const body = one(`${d}/`).block.body;
  assert.ok(body.includes("a.txt") && body.includes("sub/"));
  assert.ok(!body.includes(".env") && !body.includes("id_rsa") && !body.includes(".git"));
  const many = path.join(wt, "many");
  for (let i = 0; i < 250; i++) put(path.join(many, `f${String(i).padStart(3, "0")}`));
  const r = one(`${many}/`);
  assert.equal(r.rec.outcome, "dir");
  assert.match(r.block.body, /\(200 entries shown, 50 not shown\)/);
});

test("records: unchanged is true; a change of size, mtime, inode, symlink target, folder content or a created path is false", () => {
  const f = put(path.join(wt, "rec.txt"), "one\n");
  const d = path.join(wt, "recdir");
  put(path.join(d, "x"));
  const ln = path.join(wt, "rec-link");
  fs.symlinkSync(f, ln);
  const missing = path.join(wt, "rec-missing.txt");
  const wh = path.join(wt, ".env");
  fs.rmSync(wh, { force: true });
  fs.symlinkSync(path.join(outside, "target.txt"), wh);
  const asked = [f, `${d}/`, ln, missing, wh];
  const recs = readPaths(asked, S, { left: MAX_READ_BUDGET }).records;
  assert.equal(readsUnchanged(recs, S), true);
  const one_ = (i: number) => [recs[i]];
  fs.appendFileSync(f, "more\n");
  assert.equal(readsUnchanged(one_(0), S), false, "size changed");
  const t = new Date(Date.now() - 100000);
  fs.writeFileSync(f, "one\n");
  const r2 = readPaths([f], S, { left: MAX_READ_BUDGET }).records;
  fs.utimesSync(f, t, t);
  assert.equal(readsUnchanged(r2, S), false, "mtime changed");
  const r3 = readPaths([f], S, { left: MAX_READ_BUDGET }).records;
  fs.renameSync(put(`${f}.new`, fs.readFileSync(f)), f);
  assert.equal(readsUnchanged(r3, S), false, "replaced by another inode");
  put(path.join(d, "added"));
  const t2 = new Date(Date.now() + 5000);
  fs.utimesSync(d, t2, t2);
  assert.equal(readsUnchanged(one_(1), S), false, "file added to a listed folder");
  fs.rmSync(ln);
  fs.symlinkSync(path.join(wt, "a.sh"), ln);
  assert.equal(readsUnchanged(one_(2), S), false, "symlink retargeted");
  put(missing);
  assert.equal(readsUnchanged(one_(3), S), false, "a not-found path was created");
  fs.rmSync(wh);
  put(wh, "now a regular file\n");
  assert.equal(readsUnchanged(one_(4), S), false, "a withheld symlink replaced by a regular file");
});

test("resolveReadable: a missing path outside the bound is outside, not not-found", () => {
  assert.equal(resolveReadable(path.join(outside, "nope.txt"), S).outcome, "outside");
  assert.equal(resolveReadable(path.join(wt, "nope.txt"), S).outcome, "not-found");
});

test("cleanup", () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
