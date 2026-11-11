// Pins the gate's decisions and the parser output of the git-guard parity commands against the base commit named in the fixture
// header. The parser change that follows the base only adds optional `ShellSegment` fields: the gate's decisions (main and child) and
// the parse output without those fields must stay what they were. Decisions are the gate's `block` / `ask` / allow and its rule name.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gateEvaluate, baseFloorEnv } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell, lineWords, arithmeticTexts } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const PIN_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "shellast-pin.json");
const hasGit = spawnSync("git", ["--version"]).status === 0;
const posix = process.platform !== "win32";

/** The fields this change adds to `ShellSegment` (the type at the base has none of them); they are removed before the digest. */
const ADDED_FIELDS = ["stdinBodies", "source", "substitutions", "computed", "afterTime", "piped", "envNames"];

type Decision = [verdict: string, rule: string];
type Fixture = "empty" | "plain" | "alias" | "foreman" | "subok" | "subdiff";
interface PinRow {
  command: string;
  tool: "bash" | "powershell";
  fixture: Fixture;
  cwd?: string;
  main: Decision;
  child: Decision;
  digest: string;
}
const pin = JSON.parse(fs.readFileSync(PIN_FILE, "utf8")) as { header: { baseCommit: string; rows: number; digest: string }; rows: PinRow[] };

/** The text the parser reads for a row: `{R}` stands for a fixed root, so the digest does not depend on the temp dir. */
const parseText = (r: PinRow): string => r.command.replaceAll("{R}", "/pin-root");

/** Canonical JSON: object keys sorted, undefined dropped, no line-ending or platform dependence. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function digestOf(text: string): string {
  const segs = parseShell(text, { platform: "linux" }).map((s) => {
    const o = { ...s } as unknown as Record<string, unknown>;
    for (const f of ADDED_FIELDS) delete o[f];
    return o;
  });
  return crypto.createHash("sha256").update(canonical(segs)).digest("hex");
}

const GIT_ENV: Record<string, string> = {
  ...(Object.fromEntries(Object.entries(process.env).filter(([k, v]) => typeof v === "string" && !/^(GIT_|PI_|FOREMAN|CLAUDE|HC_)/i.test(k))) as Record<string, string>),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function g(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

interface FixtureInfo {
  cwd: string;
  root: string;
  checkout?: string;
  scratch: string;
}

function commitAll(repo: string): void {
  g(repo, "add", ".");
  g(repo, "commit", "-q", "-m", "init");
}

function build(root: string, name: "plain" | "alias"): string {
  const bare = path.join(root, `${name}-remote.git`);
  const repo = path.join(root, `${name}-repo`);
  fs.mkdirSync(bare);
  g(bare, "init", "-q", "--bare", "-b", "main");
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  g(repo, "remote", "add", "origin", bare);
  fs.writeFileSync(path.join(repo, "src.py"), "x = 1\n");
  fs.writeFileSync(path.join(repo, "tests", "test_a.py"), "a = 1\n");
  fs.writeFileSync(path.join(repo, "tests", "test_b.py"), "b = 1\n");
  commitAll(repo);
  g(repo, "push", "-q", "origin", "main");
  g(repo, "checkout", "-q", "-b", "feature/x");
  if (name === "alias") {
    g(repo, "config", "alias.pp", "push");
    g(repo, "config", "alias.hard", "reset --hard");
    g(repo, "config", "alias.sh", "!echo hi");
    g(repo, "config", "alias.loop", "loop");
  }
  fs.writeFileSync(path.join(repo, "tests", "test_a.py"), "a = 2\n");
  fs.writeFileSync(path.join(repo, "src.py"), "x = 2\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "u\n");
  return repo;
}

function repoAt(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  commitAll(dir);
  return dir;
}

function buildForeman(root: string): FixtureInfo {
  const checkout = repoAt(path.join(root, "checkout"));
  fs.mkdirSync(path.join(checkout, ".workflow"), { recursive: true });
  fs.mkdirSync(path.join(checkout, "nested-wt"), { recursive: true });
  const wt = repoAt(path.join(root, "wt"));
  const scratch = path.join(root, "pi-foreman-scratch", "s1", "L1");
  fs.mkdirSync(path.join(scratch, "r"), { recursive: true });
  try {
    fs.symlinkSync(checkout, path.join(root, "lnk"), "dir");
  } catch {
    // no symlinks here: the rows through `lnk` then name a missing path
  }
  return { cwd: wt, root, checkout, scratch };
}

/** A superproject with two submodules and its linked worktree `super.worktrees/round`; `differ`: `.gitmodules` names another URL for `b`. */
function buildSub(root: string, differ: boolean): FixtureInfo {
  const a = repoAt(path.join(root, "srca"));
  const b = repoAt(path.join(root, "srcb"));
  const sup = repoAt(path.join(root, "super"));
  g(sup, "submodule", "add", "-q", a, "libs/a");
  g(sup, "submodule", "add", "-q", b, "b");
  g(sup, "commit", "-q", "-m", "subs");
  const round = path.join(root, "super.worktrees", "round");
  g(sup, "worktree", "add", "-q", "-b", "round", round);
  g(round, "submodule", "update", "-q", "--init");
  if (differ) g(round, "config", "-f", ".gitmodules", "submodule.b.url", path.join(root, "elsewhere"));
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  return { cwd: round, root, scratch };
}

let root = "";
let info: Record<Fixture, FixtureInfo>;
before(() => {
  if (!hasGit || !posix) return;
  root = fs.realpathSync(mkTestTmp("pf-pin-"));
  const dirs = (n: string): string => {
    const d = path.join(root, n);
    fs.mkdirSync(d);
    return d;
  };
  const mk = (cwd: string): FixtureInfo => ({ cwd, root: cwd, scratch: path.join(dirs(`${path.basename(cwd)}-scratch`), "pi-foreman-scratch", "mine") });
  const empty = dirs("empty");
  const plain = build(root, "plain");
  const alias = build(root, "alias");
  info = { empty: mk(empty), plain: mk(plain), alias: mk(alias), foreman: buildForeman(dirs("foreman")), subok: buildSub(dirs("subok"), false), subdiff: buildSub(dirs("subdiff"), true) };
  for (const f of Object.values(info)) fs.mkdirSync(f.scratch, { recursive: true });
});
after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rootsFor = (cwd: string, f: FixtureInfo): GateRoots => ({
  worktree: cwd,
  scratch: [f.scratch],
  tmp: [],
  scratchBase: path.dirname(path.dirname(f.scratch)),
  owned: [],
  install: [],
  roundFlow: f.checkout ? [path.join(f.checkout, ".workflow")] : [],
  handoffs: [],
  child: true,
  role: "builder",
  tmpAccess: false,
  ...(f.checkout ? { checkout: f.checkout } : {}),
});

/** The gate's decision for one row: floors, then for a child the self-modification and child-deny rules; a main session has no roots (floors only). */
function gate(r: PinRow, child: boolean): Decision {
  const f = info[r.fixture];
  const cwd = r.cwd === undefined ? f.cwd : r.cwd.replaceAll("{R}", f.root);
  const out = gateEvaluate(r.tool, { command: r.command.replaceAll("{R}", f.root) }, cwd, {
    env: (c) => baseFloorEnv(c, { child }),
    ...(child ? { roots: () => rootsFor(cwd, f) } : {}),
  }).result as { block?: boolean; ask?: boolean; rule?: string } | undefined;
  return [out?.block ? "deny" : out?.ask ? "ask" : "allow", out?.block || out?.ask ? (out.rule ?? "") : ""];
}

const describe = (i: number, r: PinRow): string => `row ${i} [${r.tool}/${r.fixture}] ${JSON.stringify(r.command)}`;

test("the pin fixture is not empty and its row count equals the header", () => {
  assert.ok(pin.rows.length > 0);
  assert.equal(pin.rows.length, pin.header.rows);
  assert.match(pin.header.baseCommit, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(JSON.stringify(pin), /\/Users\/|\/home\/|\/private\/var|\/var\/folders|C:\\Users/);
});

test("the parse output without the added optional fields has the pinned digest", () => {
  const bad: string[] = [];
  pin.rows.forEach((r, i) => {
    if (digestOf(parseText(r)) !== r.digest) bad.push(describe(i, r));
  });
  assert.equal(bad.length, 0, `${bad.length} rows parse differently from the base:\n${bad.slice(0, 20).join("\n")}`);
});

test("the gate's decisions equal the ones pinned at the base, main session", { skip: !hasGit || !posix }, () => {
  const bad: string[] = [];
  pin.rows.forEach((r, i) => {
    const got = gate(r, false);
    if (got.join("|") !== r.main.join("|")) bad.push(`${describe(i, r)}: ${JSON.stringify(got)}, pinned ${JSON.stringify(r.main)}`);
  });
  assert.equal(bad.length, 0, `${bad.length} main rows differ:\n${bad.slice(0, 20).join("\n")}`);
});

test("the gate's decisions equal the ones pinned at the base, child session", { skip: !hasGit || !posix }, () => {
  const bad: string[] = [];
  pin.rows.forEach((r, i) => {
    const got = gate(r, true);
    if (got.join("|") !== r.child.join("|")) bad.push(`${describe(i, r)}: ${JSON.stringify(got)}, pinned ${JSON.stringify(r.child)}`);
  });
  assert.equal(bad.length, 0, `${bad.length} child rows differ:\n${bad.slice(0, 20).join("\n")}`);
});

const LONG_SIZES = [100, 1000, 3000, 6000, 10000];
const rep = (s: string, n: number, sep: string): string => Array.from({ length: n }, () => s).join(sep);
const LONG_LINES: Record<string, (n: number) => string> = {
  "arith sum": (n) => `(( ${rep("1", n, "+")} ))`,
  "arith deep parentheses": (n) => `(( ${"(".repeat(n)}1${")".repeat(n)} ))`,
  "arith many substitutions": (n) => `(( x = ${rep("$(id)", n, "+")}+1 ))`,
  "arith after and": (n) => `echo hi && (( ${rep("1", n, "+")} ))`,
  "arith for header": (n) => `for ((i=0;i<${rep("1", n, "+")};i++)); do :; done`,
  "arith for header substitutions": (n) => `for ((i=0;i<${rep("$(id)", n, "+")};i++)); do :; done`,
  "arith expansion": (n) => `echo $(( ${rep("1", n, "+")} ))`,
  "test and chain": (n) => `[[ ${rep("a == a", n, " && ")} ]]`,
  "test deep parentheses": (n) => `[[ ${"( ".repeat(n)}a == a${" )".repeat(n)} ]]`,
  "test many substitutions": (n) => `[[ ${rep("$(id) == a", n, " && ")} ]]`,
  "select many words": (n) => `select x in ${rep("a", n, " ")}; do :; done`,
  "select many substitutions": (n) => `select x in ${rep("$(id)", n, " ")}; do :; done`,
  pipeline: (n) => rep("echo", n, " | "),
  "nested groups": (n) => `${"{ ".repeat(n)}:;${" }".repeat(n)}`,
  "nested subshells": (n) => `${"( ".repeat(n)}:${" )".repeat(n)}`,
};

/** Per construct and size (`LONG_SIZES`): the first 16 hex digits of the digest the base commit's parser output has, or "throws" where the base throws. Measured at the base. */
const LONG_BASE: Record<string, string[]> = {
  "arith sum": ["bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a"],
  "arith deep parentheses": ["bbfe1c835d898e7a", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc"],
  "arith many substitutions": ["bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a", "bbfe1c835d898e7a"],
  "arith after and": ["f16bbcd3169ce99a", "f16bbcd3169ce99a", "f16bbcd3169ce99a", "f16bbcd3169ce99a", "f16bbcd3169ce99a"],
  "arith for header": ["77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf"],
  "arith for header substitutions": ["77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf", "77bf9f4486502dcf"],
  "arith expansion": ["52ad3aaa98549eb9", "805d07a863f4836c", "throws", "throws", "throws"],
  "test and chain": ["5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c"],
  "test deep parentheses": ["5f98d0f8f202c64c", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc"],
  "test many substitutions": ["5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c", "5f98d0f8f202c64c"],
  "select many words": ["303a3e518c777846", "303a3e518c777846", "303a3e518c777846", "303a3e518c777846", "303a3e518c777846"],
  "select many substitutions": ["303a3e518c777846", "303a3e518c777846", "303a3e518c777846", "303a3e518c777846", "303a3e518c777846"],
  pipeline: ["0049aeccdff915c7", "ff5cd82e68b6b386", "dd982124efab464c", "233ba80c1194446a", "3a83537748428b16"],
  "nested groups": ["3d428ca24c18b1f0", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc"],
  "nested subshells": ["3d428ca24c18b1f0", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc", "73aad5ee9e6a23cc"],
};

test("long lines: the parser throws where the base throws and returns what the base returns; lineWords and arithmeticTexts do not throw", () => {
  const bad: string[] = [];
  for (const [name, make] of Object.entries(LONG_LINES)) {
    LONG_SIZES.forEach((n, i) => {
      const line = make(n);
      let got: string;
      try {
        got = digestOf(line).slice(0, 16);
      } catch {
        got = "throws";
      }
      if (got !== LONG_BASE[name][i]) bad.push(`${name} ${n}: ${got}, base ${LONG_BASE[name][i]}`);
      try {
        lineWords(line);
        arithmeticTexts(line);
      } catch (e) {
        bad.push(`${name} ${n}: lineWords or arithmeticTexts throws ${(e as Error).message}`);
      }
    });
  }
  assert.equal(bad.length, 0, bad.join("\n"));
});
