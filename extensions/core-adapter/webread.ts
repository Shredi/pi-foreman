// web-read (ledger item 25): the gate's own, deterministic checks (a) to (d) of a plain download, as facts for the review (never the model's call).
// A call is a web-read candidate when it is a `curl` or `wget` segment of a bash line, or a `fetch` tool call. The review then checks (e), that the
// URL smuggles no data. A failed check is a fact naming the condition; it never makes the call routine.
//   (a) GET/HEAD only: no body, no upload, no other method
//   (b) no auth or cookie material, no userinfo in the URL
//   (c) nothing runs the download: no pipe into a shell or interpreter, no substitution of it into a shell, no config file
//   (d) the output goes into the scratch dir, or to stdout read only by a non-executing reader
import * as path from "node:path";
import { insideRoot } from "./floors.ts";
import { parseShell } from "./shellast.ts";
import type { ShellSegment } from "./shellast.ts";

export interface WebReadCtx {
  cwd: string;
  /** The session's scratch dirs (absolute). */
  scratch: string[];
  platform?: string;
}

type Check = { ok: true; method: string; url: string } | { ok: false; why: string };

const MAX_FACTS = 5;
const MAX_URL = 500;
const READERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "jq", "wc", "less", "more", "cat", "sort", "uniq", "cut", "tr", "nl"]);
const EXEC_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh", "python", "python2", "python3", "node", "nodejs", "bun", "deno", "perl", "ruby", "php", "lua", "pwsh", "powershell", "eval", "source", ".", "env", "sudo", "xargs"]);
const AUTH_HEADER = /^\s*(?:authorization|cookie|proxy-authorization)\s*:/i;

const baseName = (p: string): string => (p.split(/[\\/]/).pop() ?? p).toLowerCase().replace(/\.exe$/, "");
const fail = (why: string): Check => ({ ok: false, why });

/** True when the text has a `|` pipe (not `||`) outside quotes. */
function hasPipe(text: string): boolean {
  let q = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = "";
    } else if (c === "'" || c === '"') q = c;
    else if (c === "\\") i++;
    else if (c === "|") {
      if (text[i + 1] === "|") i++;
      else return true;
    }
  }
  return false;
}

/** The URL gate shared by curl, wget and fetch: absolute http(s), no userinfo. */
function urlCheck(raw: string): { url: string } | { why: string } {
  if (!/^https?:\/\//i.test(raw)) return { why: "(a) not an http(s) URL" };
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return { why: "(a) whitespace or control characters in the URL" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { why: "(a) unparsable URL" };
  }
  if (u.username || u.password || /^https?:\/\/[^/?#]*@/i.test(raw)) return { why: "(b) userinfo in the URL" };
  return { url: raw.length > MAX_URL ? `${raw.slice(0, MAX_URL)}...` : raw };
}

/** A target path inside one of the scratch dirs (literal words only; a variable, `~` or glob is not). */
function inScratch(word: string, cwd: string, ctx: WebReadCtx): boolean {
  if (!word || /[$`*?[\]{}~]/.test(word)) return false;
  const abs = path.resolve(cwd, word);
  return ctx.scratch.some((s) => insideRoot(abs, s, ctx.platform));
}

/** Check (d) for curl and wget: file targets inside scratch, or stdout read only by readers; null when it passes. */
function outputCheck(seg: ShellSegment, ctx: WebReadCtx, cwd: string, files: string[], remoteDir: string | null, piped: boolean, otherReaders: boolean): Check | null {
  let toStdout = files.length === 0 && remoteDir === null;
  for (const f of files) {
    if (f === "-") toStdout = true;
    else if (!inScratch(f, cwd, ctx)) return fail("(d) output file outside the scratch dir");
  }
  if (remoteDir !== null && !ctx.scratch.some((s) => insideRoot(remoteDir, s, ctx.platform))) return fail("(d) remote-name output outside the scratch dir");
  for (const r of seg.redirects) {
    if (r.op === "dup" || r.op === "<" || r.target === "/dev/null") continue;
    if (!inScratch(r.target, cwd, ctx)) return fail("(d) redirect outside the scratch dir");
    if (r.fd === null || r.fd === "1") toStdout = false;
  }
  if (toStdout && piped && !otherReaders) return fail("(d) stdout piped to a program that is not a plain reader");
  return null;
}

const CURL_VALUE_SHORT = new Set("AbcCdDeEFHKmoPQrTuUwxXyYz".split(""));
const CURL_VALUE_LONG = new Set(["--output", "--output-dir", "--user-agent", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--referer", "--range", "--write-out", "--proxy", "--header", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file", "--request", "--user", "--cookie", "--cookie-jar", "--netrc-file", "--config", "--oauth2-bearer", "--proxy-user", "--aws-sigv4", "--cacert", "--cert", "--key", "--resolve", "--limit-rate", "--max-filesize", "--max-redirs", "--url", "--dump-header"]);
const CURL_BODY_LONG = new Set(["--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file", "--post301", "--post302", "--post303"]);
const CURL_AUTH_LONG = new Set(["--user", "--cookie", "--cookie-jar", "--netrc", "--netrc-file", "--netrc-optional", "--oauth2-bearer", "--proxy-user", "--aws-sigv4", "--digest", "--basic", "--ntlm", "--negotiate", "--anyauth"]);

/** Checks (a) to (d) for one `curl` segment. */
function curlCheck(seg: ShellSegment, ctx: WebReadCtx, piped: boolean, otherReaders: boolean): Check {
  const cwd = seg.cwd ?? ctx.cwd;
  const urls: string[] = [];
  const outputs: string[] = [];
  let method = "GET";
  let remoteName = false;
  let outDir: string | null = null;
  const a = seg.argv;
  const setMethod = (v: string): Check | null => {
    const m = v.toUpperCase();
    if (m !== "GET" && m !== "HEAD") return fail("(a) method other than GET or HEAD");
    method = m;
    return null;
  };
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w === "--") continue;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(0, eq) : w;
      let val: string | undefined = eq > 0 ? w.slice(eq + 1) : undefined;
      if (val === undefined && CURL_VALUE_LONG.has(name)) val = a[++i] ?? "";
      if (CURL_BODY_LONG.has(name)) return fail("(a) request body or upload");
      if (CURL_AUTH_LONG.has(name)) return fail("(b) auth or cookie option");
      if (name === "--request") {
        const r = setMethod(val ?? "");
        if (r) return r;
      } else if (name === "--head") method = "HEAD";
      else if (name === "--header") {
        if (AUTH_HEADER.test(val ?? "")) return fail("(b) auth header");
      } else if (name === "--config") return fail("(c) config file");
      else if (name === "--output") outputs.push(val ?? "");
      else if (name === "--output-dir") outDir = val ?? "";
      else if (name === "--remote-name" || name === "--remote-name-all") remoteName = true;
      else if (name === "--url") urls.push(val ?? "");
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j];
        if (CURL_VALUE_SHORT.has(c)) {
          const val = w.slice(j + 1) || (a[++i] ?? "");
          if (c === "d" || c === "F" || c === "T") return fail("(a) request body or upload");
          if (c === "u" || c === "b" || c === "c" || c === "U") return fail("(b) auth or cookie option");
          if (c === "X") {
            const r = setMethod(val);
            if (r) return r;
          } else if (c === "H") {
            if (AUTH_HEADER.test(val)) return fail("(b) auth header");
          } else if (c === "K") return fail("(c) config file");
          else if (c === "o") outputs.push(val);
          break;
        }
        if (c === "I") method = "HEAD";
        else if (c === "O") remoteName = true;
      }
      continue;
    }
    urls.push(w);
  }
  if (urls.length === 0) return fail("(a) no URL");
  if (urls.length > 1) return fail("(a) more than one URL");
  const u = urlCheck(urls[0]);
  if ("why" in u) return fail(u.why);
  const out = outputCheck(seg, ctx, cwd, outputs, remoteName ? (outDir ? path.resolve(cwd, outDir) : cwd) : null, piped, otherReaders);
  return out ?? { ok: true, method, url: u.url };
}

const WGET_VALUE_SHORT = new Set(["O", "P", "o", "a", "i", "e", "t", "T", "w", "U", "Q", "l", "A", "R", "D", "I", "X", "B"]);
const WGET_VALUE_LONG = new Set(["--output-document", "--directory-prefix", "--output-file", "--append-output", "--input-file", "--execute", "--tries", "--timeout", "--wait", "--user-agent", "--quota", "--level", "--accept", "--reject", "--header", "--method", "--post-data", "--post-file", "--body-data", "--body-file", "--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password", "--load-cookies", "--save-cookies", "--referer", "--read-timeout", "--connect-timeout", "--dns-timeout", "--limit-rate", "--bind-address", "--config", "--use-askpass", "--certificate", "--private-key", "--ca-certificate", "--proxy-user", "--proxy-password"]);
const WGET_BODY_LONG = new Set(["--post-data", "--post-file", "--body-data", "--body-file"]);
const WGET_AUTH_LONG = new Set(["--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password", "--load-cookies", "--save-cookies", "--use-askpass", "--proxy-user", "--proxy-password"]);

/** Checks (a) to (d) for one `wget` segment. */
function wgetCheck(seg: ShellSegment, ctx: WebReadCtx, piped: boolean, otherReaders: boolean): Check {
  const cwd = seg.cwd ?? ctx.cwd;
  const urls: string[] = [];
  const files: string[] = [];
  let method = "GET";
  let prefix: string | null = null;
  let spider = false;
  const a = seg.argv;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w === "--") continue;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(0, eq) : w;
      let val: string | undefined = eq > 0 ? w.slice(eq + 1) : undefined;
      if (val === undefined && WGET_VALUE_LONG.has(name)) val = a[++i] ?? "";
      if (WGET_BODY_LONG.has(name)) return fail("(a) request body or upload");
      if (WGET_AUTH_LONG.has(name)) return fail("(b) auth or cookie option");
      if (name === "--method") {
        const m = (val ?? "").toUpperCase();
        if (m !== "GET" && m !== "HEAD") return fail("(a) method other than GET or HEAD");
        method = m;
      } else if (name === "--spider") {
        spider = true;
        method = "HEAD";
      } else if (name === "--header") {
        if (AUTH_HEADER.test(val ?? "")) return fail("(b) auth header");
      } else if (name === "--config" || name === "--execute" || name === "--input-file") return fail("(c) config or input file");
      else if (name === "--output-document") files.push(val ?? "");
      else if (name === "--directory-prefix") prefix = val ?? "";
      else if (name === "--output-file" || name === "--append-output") {
        if (!inScratch(val ?? "", cwd, ctx)) return fail("(d) log file outside the scratch dir");
      }
      continue;
    }
    if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j];
        if (WGET_VALUE_SHORT.has(c)) {
          const val = w.slice(j + 1) || (a[++i] ?? "");
          if (c === "O") files.push(val);
          else if (c === "P") prefix = val;
          else if (c === "e" || c === "i") return fail("(c) config or input file");
          else if (c === "o" || c === "a") {
            if (!inScratch(val, cwd, ctx)) return fail("(d) log file outside the scratch dir");
          }
          break;
        }
      }
      continue;
    }
    urls.push(w);
  }
  if (urls.length === 0) return fail("(a) no URL");
  if (urls.length > 1) return fail("(a) more than one URL");
  const u = urlCheck(urls[0]);
  if ("why" in u) return fail(u.why);
  if (spider) return { ok: true, method, url: u.url };
  // without -O the file lands in the prefix dir or the cwd under the remote name
  const remoteDir = files.length > 0 ? null : prefix !== null ? path.resolve(cwd, prefix) : cwd;
  return outputCheck(seg, ctx, cwd, files, remoteDir, piped, otherReaders) ?? { ok: true, method, url: u.url };
}

const factOf = (c: Check): string => ("why" in c ? `web-read: failed ${c.why}` : `web-read: ${c.method} ${c.url} checks a-d passed`);

/** The checks for a `fetch` tool call: GET/HEAD, no body, no auth headers or fields. */
function fetchCheck(input: Record<string, unknown>): Check {
  const method = input.method === undefined ? "GET" : typeof input.method === "string" ? input.method.toUpperCase() : "";
  if (method !== "GET" && method !== "HEAD") return fail("(a) method other than GET or HEAD");
  for (const k of Object.keys(input)) if (/^(?:body|data|json|form|payload|files?)$/i.test(k) && input[k] !== undefined && input[k] !== null && input[k] !== "") return fail("(a) request body");
  for (const k of Object.keys(input)) if (/^(?:auth|authorization|cookies?|credentials|username|password|token|bearer)$/i.test(k)) return fail("(b) auth or cookie field");
  const h = input.headers;
  if (h && typeof h === "object") {
    const names = Array.isArray(h) ? h.map((x) => (Array.isArray(x) ? String(x[0]) : x && typeof x === "object" ? String((x as { name?: unknown }).name ?? Object.keys(x)[0]) : String(x).split(":")[0])) : Object.keys(h);
    if (names.some((n) => /^\s*(?:authorization|cookie|proxy-authorization)\s*$/i.test(n))) return fail("(b) auth header");
  } else if (typeof h === "string" && AUTH_HEADER.test(h)) return fail("(b) auth header");
  if (typeof input.url !== "string") return fail("(a) no URL");
  const u = urlCheck(input.url);
  if ("why" in u) return fail(u.why);
  return { ok: true, method, url: u.url };
}

/**
 * The web-read facts of a call: one per `curl` / `wget` segment of a bash line, one for a `fetch` call; none for anything else. A failed
 * check yields `web-read: failed (<letter>) <what>`, a pass `web-read: <method> <url> checks a-d passed`.
 */
export function webReadFacts(tool: string, input: unknown, ctx: WebReadCtx): string[] {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "fetch") return [factOf(fetchCheck(inp))];
  const cmd = inp.command ?? inp.cmd;
  if (typeof cmd !== "string" || !/\b(?:curl|wget)\b/.test(cmd)) return [];
  const segs = parseShell(cmd, { cwd: ctx.cwd, platform: ctx.platform, ...(ctx.scratch[0] ? { env: { FOREMAN_SCRATCH: ctx.scratch[0] } } : {}) });
  const web = segs.filter((s) => ["curl", "wget"].includes(baseName(s.program)));
  if (web.length === 0) return [];
  const piped = hasPipe(cmd);
  const others = segs.filter((s) => !web.includes(s));
  // (c) a shell or interpreter fed by pipe or substitution runs what was downloaded
  const runs = others.some((s) => EXEC_PROGRAMS.has(baseName(s.program)) && s.opaque !== null && s.opaque !== "unresolved_var");
  const otherReaders = others.every((s) => READERS.has(baseName(s.program)));
  const facts: string[] = [];
  for (const s of web) {
    let c: Check;
    if (s.opaque !== null) c = fail(`(${s.opaque === "unresolved_var" || s.opaque === "glob_target" ? "d" : "c"}) ${s.opaque.replace(/_/g, " ")} in the download`);
    else if (s.wrappers.some((x) => x === "$(" || x === "`" || x === "<(")) c = fail("(c) download inside a command substitution");
    else if (runs) c = fail("(c) pipe or substitution into a shell or interpreter");
    else c = baseName(s.program) === "curl" ? curlCheck(s, ctx, piped, otherReaders) : wgetCheck(s, ctx, piped, otherReaders);
    facts.push(factOf(c));
  }
  return facts.slice(0, MAX_FACTS);
}

/**
 * Whether a fetch URL needs no review for smuggled data (check (e) done deterministically): no query, no fragment, no percent-encoding, a short path.
 * Any other URL goes to the review.
 */
export function plainFetchUrl(url: string): boolean {
  return !/[?#%]/.test(url) && url.length <= 120;
}
