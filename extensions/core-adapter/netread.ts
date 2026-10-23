// Network reads (R31c, docs/permissions.md "Network reads"): the `net-read` effect class. One exact grammar per program, an allowlist; a word outside it
// ends the allow and the command asks (model review, then the owner). The words come from shellchain.ts, which already refuses `$(`, backticks, `$`,
// globs, braces, newlines and an unterminated or `$`/backtick/backslash double quote, so a single-quoted word here is literal data.
//   gh   run view|list, pr view|list|checks|diff, issue view|list, repo view, api <endpoint> (GET only, no field/input/header options)
//   npm  view|info|search|ls with --json --depth N --all --long --parseable and registry-name specs only
//   curl plain GET/HEAD with a fixed option list, WHATWG-checked http(s) URLs, output only into a named scratch dir (orchestrators and children)
//   wget exactly `wget -q -O - <url>` or `wget -q --spider <url>` (orchestrators only)
// Stop tokens (env prefixes, wrappers, `sh -c`, `xargs`, ...) never reach this module: the callers refuse them first (effects.ts refusedProgram).
import * as fs from "node:fs";
import * as path from "node:path";
import { splitChain } from "./shellchain.ts";
import type { Redirect } from "./shellchain.ts";

export type NetRole = "orchestrator" | "child";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGITS = /^[0-9]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

/** A jq expression that can read the environment, import a module or read the input stream: refused (`env`, `$ENV`, `import`, `include`, `input`). */
const JQ_BAD = /env|import|include|input/i;

type OptSpec = { value: RegExp | null; short?: string };

/** Per `gh` command: the options it may carry. `value` null = a flag. */
const GH_OPTS: Record<string, Record<string, OptSpec>> = {
  "run view": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ }, "--log": { value: null }, "--log-failed": { value: null }, "--job": { value: DIGITS }, "-j": { value: DIGITS } },
  "run list": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ }, "-L": { value: DIGITS }, "--limit": { value: DIGITS }, "-b": { value: BRANCH }, "--branch": { value: BRANCH } },
  "pr view": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ } },
  "pr checks": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ } },
  "pr diff": { "-R": { value: REPO }, "--repo": { value: REPO } },
  "pr list": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ }, "-L": { value: DIGITS }, "--limit": { value: DIGITS }, "-s": { value: /^[a-z]+$/ }, "--state": { value: /^[a-z]+$/ }, "--author": { value: /^[A-Za-z0-9-]+$/ } },
  "issue view": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ } },
  "issue list": { "-R": { value: REPO }, "--repo": { value: REPO }, "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ }, "-L": { value: DIGITS }, "--limit": { value: DIGITS }, "-s": { value: /^[a-z]+$/ }, "--state": { value: /^[a-z]+$/ }, "--author": { value: /^[A-Za-z0-9-]+$/ } },
  "repo view": { "--json": { value: /^[A-Za-z,]+$/ }, "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ } },
  api: { "-q": { value: /^[^]+$/ }, "--jq": { value: /^[^]+$/ }, "--paginate": { value: null }, "-i": { value: null }, "--include": { value: null }, "-X": { value: /^GET$/ }, "--method": { value: /^GET$/ } },
};

/**
 * The option/value split of `args` against `spec`: `--opt=value`, `--opt value`, `-Xvalue`, `-X=value` (pflag strips the `=`), `-X value`. Returns the
 * positional words, or null for an option outside the spec, a bad value, `--`, or a jq expression the environment or a module can reach.
 */
function parseOpts(args: string[], spec: Record<string, OptSpec>, stripEq: boolean): string[] | null {
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" || a === "-") return null;
    if (!a.startsWith("-")) {
      pos.push(a);
      continue;
    }
    let name = a;
    let val: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        name = a.slice(0, eq);
        val = a.slice(eq + 1);
      }
    } else if (a.length > 2) {
      name = a.slice(0, 2);
      val = a.slice(2);
      if (stripEq && val.startsWith("=")) val = val.slice(1);
    }
    const o = spec[name];
    if (!o) return null;
    if (o.value === null) {
      if (val !== undefined) return null;
      continue;
    }
    if (val === undefined) {
      val = args[++i];
      if (val === undefined) return null;
    }
    if (!o.value.test(val)) return null;
    if ((name === "-q" || name === "--jq") && JQ_BAD.test(val)) return null;
  }
  return pos;
}

function ghOk(w: string[]): boolean {
  const sub = w[1];
  if (sub === "api") {
    const pos = parseOpts(w.slice(2), GH_OPTS.api, true);
    return !!pos && pos.length === 1 && /^[A-Za-z0-9_][A-Za-z0-9_./?=&,%+-]*$/.test(pos[0]) && !pos[0].includes("://") && !pos[0].startsWith("//");
  }
  const key = `${sub} ${w[2]}`;
  const spec = GH_OPTS[key];
  if (!spec) return false;
  const pos = parseOpts(w.slice(3), spec, true);
  if (!pos) return false;
  if (key === "repo view") return pos.length <= 1 && pos.every((p) => REPO.test(p));
  if (/ list$/.test(key)) return pos.length === 0;
  if (pos.length > 1) return false;
  // ids; a pr may also be named by its branch (never a URL)
  return pos.every((p) => DIGITS.test(p) || (key.startsWith("pr ") && key !== "pr list" && BRANCH.test(p) && !p.startsWith("-")));
}

const NPM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9._^~<>=-]+)?$/;
const NPM_OPTS: Record<string, OptSpec> = { "--json": { value: null }, "--all": { value: null }, "--long": { value: null }, "--parseable": { value: null }, "--depth": { value: DIGITS } };

/** A registry spec: npm-package-arg reads a tarball-like name or version (`x.tgz`, `x@1.tgz`) as a local file, so it is no spec. */
const npmSpecOk = (p: string): boolean => NPM_SPEC.test(p) && !/\.(?:tgz|tar|tar\.gz|tar\.bz2|zip)$/i.test(p);

function npmOk(w: string[]): boolean {
  const sub = w[1];
  if (!["view", "info", "search", "ls"].includes(sub)) return false;
  const pos = parseOpts(w.slice(2), NPM_OPTS, false);
  if (!pos) return false;
  if (sub === "search") return pos.length >= 1 && pos.length <= 4 && pos.every((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p));
  if (sub === "ls") return pos.length <= 3 && pos.every(npmSpecOk);
  return pos.length >= 1 && pos.length <= 2 && npmSpecOk(pos[0]) && (pos.length === 1 || /^[A-Za-z0-9_.-]+$/.test(pos[1]));
}

/**
 * An absolute http(s) URL whose host the WHATWG parser reads exactly as written: no user info, no `%`/`\`/`@` in the authority, no trailing dot,
 * no port but 80/443, no `{ } [ ]` anywhere (curl globbing, IPv6 brackets). `evil.example/x` (curl reads it as http://) fails the scheme test.
 */
export function netUrlOk(w: string): boolean {
  if (!/^https?:\/\//.test(w) || /[{}[\]\\\s\u0000-\u001f]/.test(w)) return false;
  let u: URL;
  try {
    u = new URL(w);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password || !u.hostname || u.hostname.endsWith(".")) return false;
  const raw = /^https?:\/\/([^/?#]*)/.exec(w)![1];
  if (/[%\\@]/.test(raw)) return false;
  const port = raw === u.hostname ? "" : raw.startsWith(`${u.hostname}:`) ? raw.slice(u.hostname.length + 1) : null;
  return port !== null && (port === "" || port === "443" || port === "80") && raw === raw.toLowerCase();
}

const CURL_FLAGS = "sSfIiLv";
const CURL_LONG_FLAGS = new Set(["--silent", "--show-error", "--fail", "--head", "--include", "--location"]);

/** curl with the fixed option list and URL operands; `-o` targets go through `outOk`. */
function curlOk(w: string[], outOk: (word: string) => boolean): boolean {
  let urls = 0;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a.startsWith("@")) return false;
    if (!a.startsWith("-") || a === "-") {
      if (a === "-" || !netUrlOk(a)) return false;
      urls++;
      continue;
    }
    if (a.startsWith("--")) {
      if (CURL_LONG_FLAGS.has(a)) continue;
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      let val = eq > 0 ? a.slice(eq + 1) : undefined;
      if (!["--max-time", "--connect-timeout", "--output", "--request"].includes(name)) return false;
      if (val === undefined) val = w[++i];
      if (val === undefined || !curlValue(name, val, outOk)) return false;
      continue;
    }
    // a cluster: flag letters, then optionally one value letter (m, o, X) with its attached or next-word value
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (CURL_FLAGS.includes(c)) continue;
      if (!"moX".includes(c)) return false;
      let val = a.slice(k + 1);
      if (!val) val = w[++i];
      if (val === undefined || !curlValue(c === "m" ? "--max-time" : c === "o" ? "--output" : "--request", val, outOk)) return false;
      break;
    }
  }
  return urls > 0;
}

function curlValue(name: string, val: string, outOk: (word: string) => boolean): boolean {
  if (val.startsWith("@")) return false;
  if (name === "--max-time" || name === "--connect-timeout") return DIGITS.test(val);
  if (name === "--request") return val === "GET" || val === "HEAD";
  return val === "-" || val === "/dev/null" || outOk(val);
}

/** Only `wget -q -O - <url>` and `wget -q --spider <url>`. */
function wgetOk(w: string[]): boolean {
  const url = w[w.length - 1];
  const head = w.slice(0, -1).join(" ");
  return (head === "wget -q -O -" || head === "wget -q --spider") && netUrlOk(url);
}

/** Redirects of a net-read segment: `2>&1`, `2>/dev/null`, and an output file `outOk` accepts (the scratch dir). */
function redirectsOk(rs: Redirect[], outOk: (word: string) => boolean): boolean {
  return rs.every((r) => {
    if (r.op === "dup") return r.fd === "2" && r.target === "1";
    if (r.op === ">" && r.fd === "2" && r.target === "/dev/null") return true;
    return (r.op === ">" || r.op === ">>") && (r.fd === null || r.fd === "1") && outOk(r.target);
  });
}

/**
 * True when the segment is one allowed `gh` / `npm` / `curl` / `wget` read. `role` undefined counts as a child (fail closed); wget is for orchestrators
 * only. `outDirs` are the dirs an output file (`-o`, `>`) may lie strictly inside; with none, any output asks. `cwd` resolves relative output words.
 */
export function netReadSegment(seg: { words: string[]; redirects: Redirect[] }, role: NetRole | undefined, outDirs: string[], cwd: string | null): boolean {
  const w = seg.words;
  const prog = w[0];
  if (prog !== "gh" && prog !== "npm" && prog !== "curl" && prog !== "wget") return false;
  const outOk = (word: string): boolean => cwd !== null && outInside(outDirs, cwd, word);
  if (!redirectsOk(seg.redirects, outOk)) return false;
  if (prog === "gh") return ghOk(w);
  if (prog === "npm") return npmOk(w);
  if (prog === "curl") return curlOk(w, outOk);
  return role === "orchestrator" && wgetOk(w);
}

/** Pure readers that may follow a network read in a pipe; no output option, no file writing. */
const PIPE_READERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "cut", "wc", "tr"]);

/**
 * The child overlay's check (permoverlay.ts): the whole command is a chain whose every segment is a net-read segment or a pure reader of a pipe, with at
 * least one net-read segment. The same predicate as the link's, so one grammar.
 */
export function netReadCommand(command: string, role: NetRole | undefined, outDirs: string[], cwd: string | null): boolean {
  const chain = splitChain(command);
  if (!chain) return false;
  let net = false;
  for (const seg of chain.segments) {
    if (netReadSegment(seg, role, outDirs, cwd)) {
      net = true;
      continue;
    }
    const readerOk = PIPE_READERS.has(seg.words[0]) && !seg.words.some((x) => /^-[A-Za-z]*[of]|^--(output|file|pre)/.test(x)) && seg.redirects.every((r) => r.op === "dup" || r.target === "/dev/null");
    if (!readerOk) return false;
  }
  return net;
}

/**
 * `word` names a file strictly inside one of `dirs`: no `..`, `~` or `$`, the realpath of its deepest existing ancestor stays inside the realpath of
 * the dir, and an existing file is not a symlink. `-` and `/dev/null` are not files and are handled by the callers.
 */
export function outInside(dirs: string[], cwd: string, word: string): boolean {
  if (!word || word.startsWith("~") || word.includes("$") || word.split(/[\\/]/).includes("..")) return false;
  const abs = path.resolve(cwd, word);
  for (const d of dirs) {
    let rd: string;
    try {
      rd = fs.realpathSync(d);
    } catch {
      continue;
    }
    const lexical = path.relative(path.resolve(d), abs);
    if (lexical === "" || lexical.startsWith("..") || path.isAbsolute(lexical)) continue;
    try {
      if (fs.lstatSync(abs).isSymbolicLink()) continue;
    } catch {
      // not there yet
    }
    let e = abs;
    while (e !== path.dirname(e) && !fs.existsSync(e) && !isLink(e)) e = path.dirname(e);
    let re: string;
    try {
      re = fs.realpathSync(e);
    } catch {
      continue;
    }
    const rel = path.relative(rd, re);
    if (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
