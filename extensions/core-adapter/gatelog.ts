// Gate decision log (plan 2.6): one JSON line per decision in <agentDir>/pi-foreman/state/gate/log.jsonl.
// A line never carries a raw value: the command shape is normalised (paths to a class token, URLs to scheme and host,
// quoted strings and secret-grammar values to `<v>`), every other string is redacted and capped. Best effort, like the trace.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { redactCommand, scrubReason } from "./trace.ts";

export const GATE_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const GATE_KINDS = ["owner", "round", "child", "headless"] as const;
export const GATE_LAYERS = ["floor", "default", "review", "dialog", "cache"] as const;
export type GateKind = (typeof GATE_KINDS)[number];
export type GateLayer = (typeof GATE_LAYERS)[number];

/** Roots a literal path is classified against; each is optional. */
export interface ShapeRoots {
  worktree?: string;
  scratch?: string;
  tmp?: string;
  home?: string;
  /** The parent checkout: only its `.workflow/` tree has a class (`<parent>/.workflow/...`). */
  parent?: string;
}

const MAX_SHAPE = 400;
const MAX_FIELD = 120;
const MAX_REASON = 320;

const slashes = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** Whether `p` is `root` or below it (segment boundary; a drive letter is case-insensitive). */
function below(p: string, root: string | undefined): boolean {
  if (!root) return false;
  const r = slashes(root);
  if (r.length < 2) return false;
  const win = /^[A-Za-z]:/.test(r);
  const a = win ? p.toLowerCase() : p;
  const b = win ? r.toLowerCase() : r;
  return a === b || a.startsWith(b + "/");
}

function classOf(token: string, roots: ShapeRoots): string {
  const p = slashes(token);
  if (below(p, roots.worktree)) return "<worktree>/...";
  if (below(p, roots.scratch)) return "<scratch>/...";
  if (below(p, roots.tmp)) return "<tmp>/...";
  if (roots.parent && below(p, slashes(roots.parent) + "/.workflow")) return "<parent>/.workflow/...";
  if (p === "~" || p.startsWith("~/") || below(p, roots.home)) return "<home>/...";
  return /^(?:[A-Za-z]:)?\//.test(p) ? "<abs>" : "<rel>";
}

const FILE = /^(?:[A-Za-z0-9_@+-][\w@+.-]*\.[A-Za-z][A-Za-z0-9]{1,9}|\.[A-Za-z_][\w@+.-]*)$/;

/** Long options whose operand is a credential or an auth header (`--user x`, `--password=x`, `--token x`, `--header x`). */
const CRED_LONG = /^--[a-z0-9-]*(?:user|pass|secret|token|key|auth|header|cookie|credential|bearer)[a-z0-9-]*$/i;
/** Short options that take a credential, by program (`curl -u user:pass`, `mysql -u root`). */
const CRED_SHORT: Record<string, string> = { curl: "uHU", mysql: "u", mysqldump: "u", mysqladmin: "u", mariadb: "u", http: "a", https: "a", xh: "a" };
/** Short options that take a password for every program, whatever its length: `-p pw`.
 *  `-p` also means a port (`psql -p 5432`): masking a port in a log shape is harmless, leaking a password is not. */
const CRED_ANY_SHORT = "p";
/** Programs whose `-p` is a flag without operand (`mkdir -p dir`), kept readable. */
const P_IS_FLAG = new Set(["mkdir"]);
/** Credential-looking long options that take no operand (`docker login --password-stdin`, `gh auth login --with-token`). */
const NO_OPERAND = /^--(?:password-stdin|with-token)$/;
/** Programs where an attached `-pVALUE` is a password whatever its length (`mysql -ppw`, `docker login -ppw`). */
const ATTACHED_P = new Set(["mysql", "mysqldump", "mysqladmin", "mariadb", "sshpass", "docker", "podman", "helm", "npm", "gh", "az", "aws"]);
/** A variable name from the secrets grammar of trace.ts (token, key, password, secret ...), widened by pass, auth, credential, cookie. */
const SECRET_NAME = /pass|token|key|secret|pwd|auth|cred|cookie|bearer|session/i;

/** Heredoc and here-string bodies are program text or data of unknown content: `<<EOF\n<heredoc>`, `<<< <heredoc>`. */
function maskHeredocs(text: string): string {
  return text
    .replace(/<<<[ \t]*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s;|&()]+)/g, "<<< <heredoc>")
    .replace(/(?<!<)(<<-?)[ \t]*(['"]?)([A-Za-z_][\w-]*)\2([^\n]*)\n[\s\S]*?(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g, "$1$3$4\n<heredoc>");
}

/**
 * The shape of a command: program and option words kept; quoted strings and secret-grammar values `<v>`;
 * URLs `scheme://host`; every literal path (any token with a separator, `~`, or a file name with an extension) a class token.
 */
export function normalizeShape(text: string, roots: ShapeRoots = {}): string {
  const quoted = maskHeredocs(text).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "<v>");
  const masked = redactCommand(quoted).split("[redacted]").join("<v>");
  let prog = "";
  let pending = false;
  let user = false;
  let words: string[] = [];
  let prev = 0;
  let out = "";
  const re = /[^\s;|&()]+/g;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const gap = masked.slice(prev, m.index);
    prev = m.index + m[0].length;
    if (/[;|&()\n]/.test(gap)) {
      prog = "";
      pending = false;
      user = false;
      words = [];
    }
    out += gap + shapeToken(m[0], roots, { prog, pending, user });
    const tok = m[0];
    if (/^(?:-u|--user(?:name)?(?:=|$))/.test(tok)) user = true;
    if (!prog && !/^[A-Za-z_]\w*=/.test(tok)) prog = (tok.split(/[\\/]/).pop() ?? tok).toLowerCase();
    words.push(tok);
    // `aws configure set aws_secret_access_key VALUE`: the operand of a secret-named key
    const awsSet = prog === "aws" && words.length === 4 && words[1] === "configure" && words[2] === "set" && SECRET_NAME.test(tok);
    pending = awsSet || credOperandNext(tok, prog);
  }
  return (out + masked.slice(prev)).slice(0, MAX_SHAPE);
}

/** Whether the token after `tok` is the operand of a credential option. */
function credOperandNext(tok: string, prog: string): boolean {
  if (tok.startsWith("--")) return !tok.includes("=") && !NO_OPERAND.test(tok) && CRED_LONG.test(tok);
  return /^-[A-Za-z]$/.test(tok) && ((CRED_SHORT[prog] ?? "") + (P_IS_FLAG.has(prog) ? "" : CRED_ANY_SHORT)).includes(tok[1]);
}

function shapeToken(tok: string, roots: ShapeRoots, st: { prog: string; pending: boolean; user: boolean }): string {
  if (st.pending) return "<v>";
  const asg = /^([A-Za-z_]\w*)=(.+)$/.exec(tok);
  if (asg && SECRET_NAME.test(asg[1])) return `${asg[1]}=<v>`;
  if (tok.startsWith("--")) {
    const eq = tok.indexOf("=");
    if (eq > 0 && CRED_LONG.test(tok.slice(0, eq))) return `${tok.slice(0, eq)}=<v>`;
  } else if (/^-[A-Za-z]./.test(tok)) {
    // attached short operand: `-uuser:pass` for the known programs, `-pSECRET` (more than a flag cluster) for any
    const attachedP = tok[1] === "p" && (ATTACHED_P.has(st.prog) || st.user || !/^[A-Za-z]{0,3}$/.test(tok.slice(2)));
    if ((CRED_SHORT[st.prog] ?? "").includes(tok[1]) || attachedP) return `-${tok[1]}<v>`;
  }
  const url = /^([a-z][a-z0-9+.-]*:\/\/)(?:<v>@)?([^\s\/?#:@]+)/i.exec(tok);
  if (url) return url[1] + url[2];
  if (tok.includes("<v>")) return tok;
  const eq = tok.startsWith("-") ? tok.indexOf("=") : -1;
  const head = eq > 0 ? tok.slice(0, eq + 1) : "";
  const t = tok.slice(head.length);
  if (/[\/\\]/.test(t) || t.startsWith("~") || FILE.test(t.replace(/(:\d+)+$/, ""))) return head + classOf(t, roots);
  if (t.length > 20 && /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) return head + "<v>";
  return tok;
}

export interface GateRecord {
  tool: string;
  layer: GateLayer;
  verdict: string;
  /** Rule id or policy entry id. */
  rule?: string;
  reason?: string;
  /** The raw command or target text; written only as its normalised shape. */
  input?: string;
  role?: string;
  kind?: GateKind;
}

export interface GateLogOptions {
  agentDir: string;
  session: string;
  kind: GateKind;
  role?: string;
  cwd?: string;
  roots?: ShapeRoots;
  /** `gate.logMaxBytes`; default 20 MB. */
  maxBytes?: unknown;
  now?: () => Date;
}

export interface GateLog {
  readonly file: string;
  record(rec: GateRecord): void;
}

export const gateLogFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "gate", "log.jsonl");

const field = (v: unknown): string => redactCommand(typeof v === "string" ? v : "").slice(0, MAX_FIELD);

/** The log writer. `record` never throws: a failed write drops the line. */
export function openGateLog(opts: GateLogOptions): GateLog {
  const file = gateLogFile(opts.agentDir);
  const max = typeof opts.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : GATE_LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  const cwdHash = opts.cwd ? crypto.createHash("sha256").update(opts.cwd).digest("hex").slice(0, 12) : "";
  let ready = false;
  return {
    file,
    record(rec) {
      try {
        if (!ready) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          ready = true;
        }
        const line =
          JSON.stringify({
            ts: now().toISOString(),
            session: field(opts.session),
            kind: rec.kind ?? opts.kind,
            role: field(rec.role ?? opts.role),
            tool: field(rec.tool),
            layer: rec.layer,
            verdict: field(rec.verdict),
            rule: field(rec.rule),
            reason: scrubReason(redactCommand(typeof rec.reason === "string" ? rec.reason : "")).slice(0, MAX_REASON),
            shape: normalizeShape(rec.input ?? "", opts.roots),
            cwdHash,
          }) + "\n";
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          // no file yet
        }
        if (size > 0 && size + Buffer.byteLength(line) > max) {
          const old = path.join(path.dirname(file), "log.1.jsonl");
          try {
            fs.rmSync(old, { force: true });
          } catch {
            // rename below replaces it where it can
          }
          fs.renameSync(file, old);
        }
        fs.appendFileSync(file, line, "utf8");
      } catch {
        // the log is best effort
      }
    },
  };
}
