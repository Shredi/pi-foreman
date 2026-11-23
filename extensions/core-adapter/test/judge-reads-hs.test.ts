// High-stakes review fixes of the judge's reads: line-bounded cuts, askable hint and header paths, ctime in the cache, the listing scan bound, masked reasons.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJudgeVerdict } from "../classifier.ts";
import { MAX_FILE_BYTES, MAX_LISTING, MAX_READ_BUDGET, judgeReadScope, readHooks, readPaths, readsUnchanged } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-hs-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const agent = path.join(tmp, "home", ".pi", "agent");
const wt = path.join(tmp, "home", "proj");
const cwd = path.join(wt, "sub");
for (const d of [agent, cwd]) fs.mkdirSync(d, { recursive: true });
const put = (p: string, text: string): string => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const S = judgeReadScope({ cwd, worktree: wt, agentDir: agent, home: path.join(tmp, "home"), config: {} }) as JudgeReadScope;
const one = (asked: string, s: JudgeReadScope = S) => {
  const r = readPaths([asked], s, { left: MAX_READ_BUDGET });
  return { rec: r.records[0], block: r.blocks[0] };
};

test("cut falls on a line boundary: header and next-slice hint use the last line shown whole", () => {
  const line = `${"a".repeat(99)}`;
  put(path.join(cwd, "long.txt"), `${Array.from({ length: 300 }, () => line).join("\n")}\n`);
  const { block } = one("long.txt");
  const shownLines = block.body.split("\n").filter((l) => l === line).length;
  assert.ok(shownLines > 0 && shownLines < 300);
  assert.ok(block.body.length <= MAX_FILE_BYTES + 400);
  assert.ok(block.body.startsWith(`lines 1-${shownLines}\n`), block.body.slice(0, 40));
  assert.match(block.body, new RegExp(`ask long\\.txt#L${shownLines + 1}-`));
  assert.ok(!block.body.includes("a".repeat(100)), "no partial line");
});

test("a first line longer than the cap is shown cut; the hint continues at the next line", () => {
  put(path.join(cwd, "wide.txt"), `${"b".repeat(MAX_FILE_BYTES + 500)}\nsecond\n`);
  const { block } = one("wide.txt");
  assert.ok(block.body.startsWith("lines 1-1\n"));
  assert.match(block.body, /\[cut\]/);
  assert.match(block.body, /ask wide\.txt#L2-/);
});

test("the more-hint names the path as asked (no basename), without its window", () => {
  put(path.join(cwd, "sub", "long.sh"), `${Array.from({ length: 500 }, (_, i) => `echo ${i}`).join("\n")}\n`);
  const hint = /ask (\S+)#L(\d+)-/.exec(one("sub/long.sh").block.body);
  assert.equal(hint?.[1], "sub/long.sh");
  assert.ok(fs.existsSync(path.resolve(cwd, hint![1])));
  const w = /ask (\S+)#L401-/.exec(one("sub/long.sh#L1-400").block.body);
  assert.equal(w?.[1], "sub/long.sh");
});

test("headers show a path the judge can ask again: relative inside the cwd, absolute elsewhere", () => {
  put(path.join(cwd, "sub", "h.txt"), "x\n");
  assert.match(one(path.join(cwd, "sub", "h.txt")).block.header, / -> sub\/h\.txt \(file\)$/);
  const other = put(path.join(wt, "other.txt"), "y\n");
  assert.match(one(other).block.header, /-> \/\S*\/other\.txt \(file\)$/);
  assert.ok(!one(other).block.header.includes("~/"));
});

test("cache: a same-size in-place rewrite with the old mtime restored is not unchanged", () => {
  const p = put(path.join(cwd, "c.txt"), "aaaa\n");
  const old = fs.statSync(p);
  const { records } = readPaths(["c.txt"], S, { left: MAX_READ_BUDGET });
  assert.equal(readsUnchanged(records, S), true);
  fs.writeFileSync(p, "bbbb\n");
  fs.utimesSync(p, old.atimeMs / 1000, old.mtimeMs / 1000);
  assert.equal(fs.statSync(p).mtimeMs, old.mtimeMs);
  assert.equal(readsUnchanged(records, S), false);
});

test("a 5000-entry folder lists at most 200 names and resolves few entries", () => {
  const big = path.join(cwd, "big");
  fs.mkdirSync(big);
  for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(big, `f${String(i).padStart(4, "0")}`), "");
  let hooked = 0;
  readHooks.afterStat = () => void hooked++;
  try {
    const { block } = one("big");
    const names = block.body.split("\n").filter((l) => /^f\d{4}$/.test(l));
    assert.equal(names.length, MAX_LISTING);
    assert.match(block.body, /\(200 entries shown, \d+ not shown\)$/);
  } finally {
    readHooks.afterStat = undefined;
  }
  assert.ok(hooked <= 2);
});

test("the judge's reason is masked of secrets before it reaches the dialog", () => {
  const secret = "ghp_abcdefghij1234567890";
  for (const mode of [undefined, "read"] as const) {
    const v = JSON.stringify(mode ? { verdict: "read", paths: ["a"], reason: `token=${secret} seen` } : { verdict: "unsure", reason: `file holds token=${secret}` });
    const p = parseJudgeVerdict(v, mode);
    assert.ok("reason" in p && !p.reason.includes(secret) && p.reason.includes("[redacted]"));
  }
});
