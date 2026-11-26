// High-stakes review fixes of the judge's reads: line-bounded cuts, askable hint and header paths, ctime in the cache, the listing scan bound, masked reasons.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { judgeSystemPrompt, parseJudgeVerdict } from "../classifier.ts";
import { MAX_FILE_BYTES, MAX_LISTING, MAX_READ_BUDGET, judgeReadScope, readHooks, readPaths, readsUnchanged } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-hs-")));
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
  assert.match(one(path.join(cwd, "sub", "h.txt")).block.header, / -> sub[\\/]h\.txt \(file\)$/);
  const other = put(path.join(wt, "other.txt"), "y\n");
  // The header may abbreviate the real home folder as `~` (a temp root under it); the asked path is not inside the scope's cwd either way.
  assert.match(one(other).block.header, /-> (~|[A-Za-z]:|\/)\S*[\\/]other\.txt \(file\)$/);
  assert.ok(!/-> (sub|\.\.)/.test(one(other).block.header));
});

test("cache: a same-size in-place rewrite with the old mtime restored is not unchanged", () => {
  const p = put(path.join(cwd, "c.txt"), "aaaa\n");
  // Whole seconds: a fractional mtime does not survive the utimes round trip exactly on every filesystem.
  const sec = 1_700_000_000;
  fs.utimesSync(p, sec, sec);
  const old = fs.statSync(p);
  const { records } = readPaths(["c.txt"], S, { left: MAX_READ_BUDGET });
  assert.equal(readsUnchanged(records, S), true);
  fs.writeFileSync(p, "bbbb\n");
  fs.utimesSync(p, sec, sec);
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
  assert.match(judgeSystemPrompt(true), /\[redacted\] in a file marks a masked value that may hide code; if what it hides matters for the verdict, answer refuse/);
});

test("a folder listing is masked per entry: no pattern spans names, the count matches the lines", () => {
  const dir = path.join(cwd, "spanlist");
  const win = process.platform === "win32";
  const names = ["!token=", win ? "'start" : '"start', "c_important.db", "d_payload.sh", win ? "zz'" : 'zz"', "zzz_last"];
  for (const n of names) put(path.join(dir, n), "x\n");
  const { block } = one("spanlist");
  const lines = block.body.split("\n");
  assert.equal(lines.length, names.length + 1);
  assert.equal(lines[names.length], `(${names.length} entries shown)`);
  for (const n of ["c_important.db", "d_payload.sh", "zzz_last"]) assert.ok(lines.includes(n), block.body);
});

test("a file name with a newline lists as one escaped line", { skip: process.platform === "win32" }, () => {
  const dir = path.join(cwd, "nllist");
  put(path.join(dir, "a\nfake_entry"), "x\n");
  put(path.join(dir, "b\tc\x01"), "x\n");
  const { block } = one("nllist");
  assert.deepEqual(block.body.split("\n"), ["a\\nfake_entry", "b\\tc\\x01", "(2 entries shown)"]);
});

test("a judge-asked path with a newline gives a single-line header", () => {
  const { block } = one("nope\nfake -> x (file)");
  assert.ok(!block.header.includes("\n"), block.header);
  assert.ok(block.header.startsWith("nope\\nfake"), block.header);
});

test("a ~/ path is the home folder: the hint for a long agent-dir .jsonl and a long project file pages on", () => {
  const jl = put(path.join(agent, "sessions", "s.jsonl"), `${Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join("\n")}\n`);
  const first = one("~/.pi/agent/sessions/s.jsonl");
  assert.equal(first.rec.outcome, "ok");
  assert.equal(first.rec.real, jl);
  const hint = /ask (\S+)#L(\d+)-(\d+)\]/.exec(first.block.body);
  assert.ok(hint, first.block.body);
  const next = one(`~/.pi/agent/sessions/s.jsonl#L${hint![2]}-${hint![3]}`);
  assert.equal(next.rec.outcome, "ok");
  assert.match(next.block.body, new RegExp(`^lines ${hint![2]}-`));
  put(path.join(wt, "big.txt"), `${Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n")}\n`);
  const p1 = one("~/proj/big.txt");
  assert.equal(p1.rec.outcome, "ok");
  const h2 = /ask (\S+)#L(\d+)-(\d+)\]/.exec(p1.block.body);
  assert.ok(h2, p1.block.body);
  const p2 = one(`~/proj/big.txt#L${h2![2]}-${h2![3]}`);
  assert.equal(p2.rec.outcome, "ok");
  assert.match(p2.block.body, /^lines 401-/);
});

test("~ expansion widens nothing: auth.json stays withheld, a file in the home folder stays outside, ~user and $VAR are not expanded", () => {
  put(path.join(agent, "sessions", "auth.json"), '{"a":1}\n');
  put(path.join(tmp, "home", "outside.txt"), "o\n");
  assert.equal(one("~/.pi/agent/sessions/auth.json").rec.outcome, "withheld");
  assert.equal(one("~/.pi/agent/auth.json").rec.outcome, "outside");
  assert.equal(one("~/outside.txt").rec.outcome, "outside");
  assert.equal(one("~").rec.outcome, "outside");
  assert.equal(one("~root/x").rec.outcome, "not-found");
  assert.equal(one("$HOME/x").rec.outcome, "not-found");
});

test("a token=\" in the asked name cannot hide the real path and outcome part of the header", () => {
  const { block } = one('t token="x');
  assert.match(block.header, / -> \S.* \(not found\)$/);
  put(path.join(cwd, "tk.txt"), "x\n");
  assert.match(one("tk.txt").block.header, / -> tk\.txt \(file\)$/);
});

test("bidi, NEL, line and paragraph separators in an asked name are escaped", () => {
  const chars = [0x202e, 0x85, 0x2028, 0x2029, 0x2066].map((c) => String.fromCharCode(c));
  const { block } = one(`a${chars.join("b")}`);
  assert.ok(block.header.startsWith("a\\u202eb\\x85b\\u2028b\\u2029b\\u2066 -> "), block.header);
  assert.ok(!chars.some((c) => block.header.includes(c)));
});

test("LRM, RLM and ALM in an asked name are escaped", () => {
  const chars = [0x200e, 0x200f, 0x061c].map((c) => String.fromCharCode(c));
  const { block } = one(`a${chars.join("b")}`);
  assert.ok(block.header.startsWith("a\\u200eb\\u200fb\\u061c -> "), block.header);
  assert.ok(!chars.some((c) => block.header.includes(c)));
});

// Win32 resolves `..` lexically before the links, so there the OS opens run.sh and these tests do not apply.
const posixDots = { skip: process.platform === "win32" };

test("`..` after a link is resolved by the OS: d/../run.sh with d -> deep/er shows deep/run.sh", posixDots, () => {
  const base = path.join(cwd, "dotdot");
  put(path.join(base, "run.sh"), "echo benign\n");
  put(path.join(base, "deep", "run.sh"), "echo EVIL-ran\n");
  fs.mkdirSync(path.join(base, "deep", "er"), { recursive: true });
  fs.symlinkSync(path.join(base, "deep", "er"), path.join(base, "d"));
  const { block } = one("dotdot/d/../run.sh");
  assert.match(block.body, /EVIL-ran/);
  assert.match(block.header, /deep\/run\.sh/);
  assert.ok(!block.body.includes("benign"));
});

test("a file named run.sh#L1-9 is read by its literal name; without it the suffix is a window", () => {
  const base = path.join(cwd, "lit");
  put(path.join(base, "run.sh"), "plain 1\nplain 2\n");
  assert.match(one("lit/run.sh#L2-2").block.body, /plain 2/);
  put(path.join(base, "run.sh#L1-9"), "literal text\n");
  const { block } = one("lit/run.sh#L1-9");
  assert.match(block.body, /literal text/);
  assert.ok(!block.body.includes("plain"));
  assert.match(block.header, /literal name/);
});

test("an invalid-verdict detail is masked and cut to 200 characters", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  const v = parseJudgeVerdict(JSON.stringify({ verdict: `${secret}${"x".repeat(4800)}` }));
  assert.ok("error" in v && v.detail.length <= 200 && !v.detail.includes(secret), JSON.stringify(v));
  const f = parseJudgeVerdict(JSON.stringify({ verdict: "clear", [`${"f".repeat(4800)}${secret}`]: 1 }));
  assert.ok("error" in f && f.detail.length <= 200 && !f.detail.includes(secret));
});

test("a .jsonl line is masked before its cut; the last line of a 1 MiB scan carries [cut]", () => {
  const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  put(path.join(cwd, "m.jsonl"), `${"j".repeat(990)}${secret} ${"k".repeat(200)}\n`);
  const j = one("m.jsonl").block.body;
  assert.ok(!j.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), j.slice(900, 1100));
  assert.match(j, /\[cut\]/);
  put(path.join(cwd, "big.txt"), `first\n${"z".repeat(1024 * 1024 + 50)}`);
  const b = one("big.txt#L2-2").block.body;
  assert.match(b, /\[cut\]/);
});

test("`..` after a link is resolved by the OS also in a ~/ path", posixDots, () => {
  const base = path.join(wt, "tilde");
  put(path.join(base, "run.sh"), "echo benign\n");
  put(path.join(base, "deep", "run.sh"), "echo EVIL-ran\n");
  fs.mkdirSync(path.join(base, "deep", "er"), { recursive: true });
  fs.symlinkSync(path.join(base, "deep", "er"), path.join(base, "d"));
  const s = judgeReadScope({ cwd, worktree: wt, agentDir: agent, home: path.join(tmp, "home"), config: {} }) as JudgeReadScope;
  const { block } = one("~/proj/tilde/d/../run.sh", s);
  assert.match(block.body, /EVIL-ran/);
  assert.ok(!block.body.includes("benign"));
});

test("a run.sh#L1-9 that is a link to an outside file or to agent-dir extensions/ answers as the link, not as the window", () => {
  const base = path.join(cwd, "litlink");
  put(path.join(base, "run.sh"), "plain 1\n");
  const outsideFile = put(path.join(tmp, "outside-lit", "evil.sh"), "echo EVIL\n");
  fs.symlinkSync(outsideFile, path.join(base, "run.sh#L1-9"));
  const a = one("litlink/run.sh#L1-9");
  assert.equal(a.rec.outcome, "outside");
  assert.ok(!a.block.body.includes("plain"));
  const ext = put(path.join(agent, "extensions", "x.ts"), "secret ext\n");
  fs.symlinkSync(ext, path.join(base, "run2.sh#L1-9"));
  put(path.join(base, "run2.sh"), "plain 2\n");
  const b = one("litlink/run2.sh#L1-9");
  assert.ok(b.rec.outcome === "outside" || b.rec.outcome === "withheld");
  assert.ok(!b.block.body.includes("plain") && !b.block.body.includes("secret ext"));
});

test("the not-found hint names a folder only inside a readable place", () => {
  fs.mkdirSync(path.join(tmp, "home", ".ssh"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "outside-dir"), { recursive: true });
  fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
  put(path.join(wt, "run.sh"), "x\n");
  for (const asked of [
    "~/.ssh/nope/../../proj/run.sh",
    `${tmp}/outside-dir/nope/../../home/proj/run.sh`,
    `${agent}/extensions/nope/../../../../proj/run.sh`,
  ]) {
    const r = one(asked);
    assert.equal(r.rec.outcome, "outside", asked);
    assert.ok(!r.block.body.includes("nearest"), asked);
    assert.equal(r.rec.ancestor, undefined);
  }
  const ok = one("nope-folder/x.txt");
  assert.equal(ok.rec.outcome, "not-found");
  assert.match(ok.block.body, /nearest existing folder/);
});

test("a window on a top-level agent-dir allow-listed file shows the window lines", () => {
  put(path.join(agent, "AGENTS.md"), "one\ntwo\nthree\n");
  const { rec, block } = one(`${path.join(agent, "AGENTS.md")}#L2-2`);
  assert.equal(rec.outcome, "ok");
  assert.match(block.body, /two/);
  assert.ok(!block.body.includes("three"));
});

test("the not-found hint does not name a withheld ancestor folder", () => {
  fs.mkdirSync(path.join(wt, ".env"), { recursive: true });
  fs.mkdirSync(path.join(wt, ".git", "refs"), { recursive: true });
  for (const asked of [path.join(wt, ".env", "nope", "..", "..", "absent-run.sh"), path.join(wt, ".git", "refs", "nope", "..", "..", "..", "absent-run.sh")]) {
    const { rec, block } = one(asked);
    assert.equal(rec.outcome, "not-found", asked);
    assert.ok(!/\.env|\.git/.test(`${block.body}${rec.ancestor ?? ""}`), block.body);
  }
});

test("the not-found answer under a withheld folder is byte-identical whether that folder exists or not", () => {
  const mk = (withheld: boolean) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "twin-")));
    const proj = path.join(root, "home", "proj");
    fs.mkdirSync(proj, { recursive: true });
    if (withheld) {
      fs.mkdirSync(path.join(proj, ".env"), { recursive: true });
      fs.mkdirSync(path.join(proj, ".git", "refs"), { recursive: true });
    }
    return judgeReadScope({ cwd: proj, worktree: proj, agentDir: path.join(root, "agent"), home: path.join(root, "home"), config: {} }) as JudgeReadScope;
  };
  const withS = mk(true);
  const withoutS = mk(false);
  for (const asked of [".env/nope/../../x", ".git/refs/nope/../../../x", ".env/nope/../x/../../y"]) {
    const a = one(asked, withS);
    const b = one(asked, withoutS);
    assert.equal(a.block.body.replace(/twin-\w+/g, "twin"), b.block.body.replace(/twin-\w+/g, "twin"), asked);
    assert.equal(a.rec.outcome, b.rec.outcome, asked);
    assert.ok(!/\.env|\.git/.test(`${a.block.body}${a.rec.ancestor ?? ""}`), a.block.body);
  }
});

// Two fresh setups: one where the withheld and outside places exist, one where they do not. No answer may differ between them.
const twins = (() => {
  const mk = (extra: boolean) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmp, "twin2-")));
    const home = path.join(root, "home");
    const ag = path.join(home, ".pi", "agent");
    const proj = path.join(home, "proj");
    put(path.join(proj, "run.sh"), "echo proj\n");
    put(path.join(proj, "deep", "run.sh"), "echo deep\n");
    put(path.join(proj, "deep", "er", "run.sh"), "echo er\n");
    fs.symlinkSync(path.join(proj, "deep", "er"), path.join(proj, "d"));
    put(path.join(ag, "AGENTS.md"), "agents\n");
    fs.mkdirSync(path.join(ag, "sessions", "s1"), { recursive: true });
    put(path.join(ag, "sessions", "s2", "x"), "session two\n");
    fs.mkdirSync(path.join(ag, "pi-foreman"), { recursive: true });
    if (extra) {
      fs.mkdirSync(path.join(proj, ".git"));
      fs.mkdirSync(path.join(proj, ".env"));
      fs.mkdirSync(path.join(ag, "extensions"));
      fs.mkdirSync(path.join(ag, "pi-foreman", "remote", "sub"), { recursive: true });
      fs.mkdirSync(path.join(home, ".ssh"));
      put(path.join(ag, "zzz#L1-1"), "outside text\n");
      fs.symlinkSync(path.join(root, "nowhere"), path.join(ag, "dang#L1-1"));
    }
    const scope = judgeReadScope({ cwd: proj, worktree: proj, agentDir: ag, home, config: {} }) as JudgeReadScope;
    const norm = (s: string) => s.replace(/twin2-\w+/g, "twin2");
    return { scope, ag, home, norm };
  };
  return { yes: mk(true), no: mk(false) };
})();
const twinPair = (rel: (t: typeof twins.yes) => string) => {
  const a = twins.yes;
  const b = twins.no;
  const ra = readPaths([rel(a)], a.scope, { left: MAX_READ_BUDGET });
  const rb = readPaths([rel(b)], b.scope, { left: MAX_READ_BUDGET });
  return { ra, rb, a, b };
};
const sameBoth = (rel: (t: typeof twins.yes) => string): { outcome: string; text: string } => {
  const { ra, rb, a, b } = twinPair(rel);
  const ta = a.norm(JSON.stringify([ra.blocks, ra.records.map((r) => [r.asked, r.outcome, r.real, r.ancestor])]));
  const tb = b.norm(JSON.stringify([rb.blocks, rb.records.map((r) => [r.asked, r.outcome, r.real, r.ancestor])]));
  assert.equal(ta, tb, rel(a));
  return { outcome: ra.records[0].outcome, text: a.norm(ra.blocks[0].header + "\n" + ra.blocks[0].body) };
};

test("hint under agent pi-foreman/remote/sub names pi-foreman, the same whether remote exists or not", () => {
  const plain = sameBoth((t) => path.join(t.ag, "pi-foreman", "remote", "sub", "nope", "x"));
  assert.equal(plain.outcome, "withheld");
  const dotted = sameBoth((t) => `${t.ag}/pi-foreman/remote/sub/nope/../../../x`);
  assert.equal(dotted.outcome, "outside");
});

test("a `..` after a withheld or outside folder answers outside, the same whether that folder exists or not", () => {
  for (const f of [
    () => ".git/../run.sh",
    () => ".env/../run.sh",
    (t: typeof twins.yes) => `${t.ag}/extensions/../AGENTS.md`,
    () => "~/.ssh/../proj/run.sh",
    (t: typeof twins.yes) => `${t.ag}/pi-foreman/remote/../x`,
    (t: typeof twins.yes) => `${t.ag}/../x`,
  ]) {
    const r = sameBoth(f);
    assert.equal(r.outcome, "outside", r.text);
    assert.ok(!/nearest existing/.test(r.text), r.text);
  }
});

test("a `..` after readable prefixes keeps working", () => {
  const d = sameBoth(() => "d/../run.sh");
  assert.equal(d.outcome, "ok");
  if (process.platform === "win32") assert.match(d.text, /echo proj/);
  else {
    assert.match(d.text, /deep\/run\.sh/);
    assert.match(d.text, /echo deep/);
  }
  const s = sameBoth((t) => `${t.ag}/sessions/s1/../s2/x`);
  assert.equal(s.outcome, "ok");
  assert.match(s.text, /session two/);
});

test("a `#L…` name that exists outside the readable places answers like a missing one, with no literal note", () => {
  const e = sameBoth((t) => `${t.ag}/zzz#L1-1`);
  assert.equal(e.outcome, "outside");
  assert.ok(!/literal name/.test(e.text), e.text);
  const m = sameBoth((t) => `${t.ag}/yyy#L1-1`);
  assert.equal(m.outcome, "outside");
  const dang = sameBoth((t) => `${t.ag}/dang#L1-1`);
  assert.equal(dang.outcome, "outside");
  assert.ok(!/literal name/.test(dang.text), dang.text);
});

test("a literal name that exists in a readable place is still read by that name", () => {
  const p = put(path.join(twins.yes.scope.cwd, "lit#L1-1"), "literal body\n");
  const r = readPaths([p], twins.yes.scope, { left: MAX_READ_BUDGET });
  assert.equal(r.records[0].outcome, "ok");
  assert.match(r.blocks[0].header, /read by its literal name/);
  assert.match(r.blocks[0].body, /literal body/);
});

test("a trailing backslash is no separator on POSIX: the answer does not depend on whether the file exists", { skip: process.platform === "win32" }, () => {
  const names = [".envrc\\", ".env\\", "token\\", "a.tfvars\\", "id_rsa\\", "AGENT/sessions/auth.json\\", ".git/cfg2\\"];
  const run = (exists: boolean): string => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "judge-reads-bs-")));
    try {
      const ag = path.join(root, "home", ".pi", "agent");
      const w = path.join(root, "home", "proj");
      fs.mkdirSync(ag, { recursive: true });
      fs.mkdirSync(w, { recursive: true });
      const sc = judgeReadScope({ cwd: w, worktree: w, agentDir: ag, home: path.join(root, "home"), config: {} }) as JudgeReadScope;
      const asked = names.map((n) => (n.startsWith("AGENT") ? ag + n.slice(5) : w + "/" + n));
      for (const a of asked) {
        fs.mkdirSync(path.dirname(a), { recursive: true });
        if (exists) fs.writeFileSync(a.slice(0, -1), "x\n");
      }
      const r = readPaths(asked, sc, { left: MAX_READ_BUDGET });
      return JSON.stringify(r.blocks).replace(/\S*judge-reads-bs-\w+/g, "<root>");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  assert.equal(run(true), run(false));
});
