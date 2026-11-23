// High-stakes review fixes of the judge's reads: line-bounded cuts, askable hint and header paths, ctime in the cache, the listing scan bound, masked reasons.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { judgeSystemPrompt, parseJudgeVerdict } from "../classifier.ts";
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

test("a masked blob line does not hide later lines: every line is shown or named by the more-hint", () => {
  const blob = Array.from({ length: 25000 }, (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"[(i * 7 + (i >> 3)) % 36]).join("");
  const rest = Array.from({ length: 50 }, () => "echo harmless");
  put(path.join(cwd, "blob.sh"), `${[blob, ...rest, "rm -rf ~/Documents"].join("\n")}\n`);
  const { block } = one("blob.sh");
  assert.ok(!block.body.includes(blob.slice(0, 200)));
  const m = /^lines 1-(\d+)\n/.exec(block.body);
  assert.ok(m, block.body.slice(0, 40));
  const last = Number(m[1]);
  const shown = block.body.split("\n").filter((l) => l === "echo harmless" || l === "rm -rf ~/Documents").length;
  assert.equal(shown, last - 1, "header counts exactly the lines shown");
  if (last < 52) assert.match(block.body, new RegExp(`ask blob\\.sh#L${last + 1}-`));
  else assert.ok(block.body.includes("rm -rf ~/Documents"));
});

test("a 400-line file with an early blob and long lines: header and hint name only lines really shown", () => {
  const blob = Array.from({ length: 25000 }, (_, i) => "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"[(i * 7 + (i >> 3)) % 36]).join("");
  const line = "c".repeat(99);
  put(path.join(cwd, "many.txt"), `${[blob, ...Array.from({ length: 399 }, () => line)].join("\n")}\n`);
  const { block } = one("many.txt");
  const shown = block.body.split("\n").filter((l) => l === line).length;
  assert.ok(shown > 0 && shown < 399);
  assert.ok(block.body.startsWith(`lines 1-${shown + 1}\n`), block.body.slice(0, 40));
  assert.match(block.body, new RegExp(`ask many\\.txt#L${shown + 2}-`));
  assert.match(block.body, /\[cut at /);
});

test("a partly shown line carries [cut] and the hint skips to the next line", () => {
  put(path.join(cwd, "part.txt"), `${"d".repeat(MAX_FILE_BYTES + 10)}\n${"e".repeat(10)}\n`);
  const { block } = one("part.txt");
  assert.match(block.body, /d \[cut\]\n/);
  assert.ok(block.body.startsWith("lines 1-1\n"));
  assert.match(block.body, /ask part\.txt#L2-/);
});

const headerCount = (body: string): number => {
  const m = /^lines (\d+)-(\d+)\n/.exec(body);
  assert.ok(m, body.slice(0, 40));
  return Number(m[2]) - Number(m[1]) + 1;
};

test("masking works line by line: a key= before a multi-line quoted value swallows no lines", () => {
  put(path.join(cwd, "swallow.sh"), 'TOKEN=\n"$(\nrm -rf ~/Documents\nrm -rf ~/Pictures\n)"\necho done\n');
  const { block } = one("swallow.sh");
  const n = headerCount(block.body);
  assert.equal(n, 6);
  assert.ok(block.body.split("\n").length >= n + 1, block.body);
  assert.match(block.body, /rm -rf ~\/Documents/);
  assert.match(block.body, /rm -rf ~\/Pictures/);
  assert.match(block.body, /echo done/);
});

test("masking works line by line: the secret= variant keeps every line", () => {
  put(path.join(cwd, "swallow2.sh"), 'secret=\n"a\nrm -rf ~/Documents\nrm -rf ~/Pictures\nb"\necho done\n');
  const { block } = one("swallow2.sh");
  assert.equal(headerCount(block.body), 6);
  assert.match(block.body, /rm -rf ~\/Documents/);
  assert.match(block.body, /rm -rf ~\/Pictures/);
  assert.match(block.body, /echo done/);
});

test("only the reads-on judge prompt carries the [redacted] sentence", () => {
  assert.ok(!judgeSystemPrompt().includes("[redacted]"));
  assert.match(judgeSystemPrompt(true), /\[redacted\] in a file marks a masked value that may hide code; if what it hides matters for the verdict, answer unsure/);
});
