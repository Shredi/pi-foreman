// Gate floors (round 41, plan 2.2): deny with a reason that names the alternative; no model, no dialog, no override.
// Pure functions over the shellast.ts segments and the raw text. The same rules for every session kind.
// The git-config key list is one file shared with the tests (git-floor-keys.json, read at module load).
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ShellSegment } from "./shellast.ts";

interface FloorKeys {
  keyPatterns: string[];
  sectionNames: string[];
  remoteSubcommands: string[];
  envPattern: string;
  protectedBranches: string[];
}

export const GIT_FLOOR_KEYS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-floor-keys.json");
const KEYS = JSON.parse(fs.readFileSync(GIT_FLOOR_KEYS_FILE, "utf8")) as FloorKeys;
const KEY_RES = KEYS.keyPatterns.map((p) => new RegExp(p));
const ENV_RE = new RegExp(KEYS.envPattern);
const REMOTE_SUBS = new Set(KEYS.remoteSubcommands);

export interface FloorEnv {
  platform?: string;
  /** The session cwd (the start directory of the line). */
  cwd: string;
  home?: string;
  /** safety.git.protectedBranches; `main` and `master` are always protected. */
  protectedBranches?: string[];
  /** Roots a delete or a recursive overwrite may reach: the worktree, scratch dirs, the OS temp dir, owned write roots. */
  writeRoots?: string[];
  /** The Pi agent dir (its auth.json is a secret path; its pi-foreman policy and state files are floored writes). */
  agentDir?: string;
  /** The dir of the session's own Pi session file: its `*.jsonl` files are floored writes (the adapter writes them through pi.appendEntry). */
  sessionDir?: string;
  /** The bundled package root (its config/permissions.policy.md is a floored write). */
  pkgRoot?: string;
  /** safety.policy.files: extra policy files of the owner's overlay (absolute, `~` or cwd-relative). */
  policyFiles?: string[];
  currentBranch?: (cwd: string) => string | null;
  remoteHead?: (cwd: string) => string | null;
  /** A subagent child session: it never pushes (the foreman pushes). */
  child?: boolean;
}

export interface FloorHit {
  /** The floor rule name, `floor-<name>`. */
  rule: string;
  reason: string;
}

const hit = (name: string, reason: string): FloorHit => ({ rule: `floor-${name}`, reason: `pi-foreman: denied by the permission floor (${name}). ${reason} No review, policy entry or dialog lifts this floor.` });

const base = (p: string): string => (p.split(/[\\/]/).pop() ?? p).toLowerCase().replace(/\.exe$/, "");
const isWord = (w: string): boolean => !/[$`*?[\]{}~]/.test(w);

// ------------------------------------------------------------------ git

/** True when the (lower-cased) config key is a floored key. */
export function floorKey(key: string): boolean {
  const k = key.trim().toLowerCase();
  return KEY_RES.some((re) => re.test(k));
}

const floorSection = (name: string): boolean => {
  const n = name.trim().toLowerCase();
  return floorKey(n) || floorKey(`${n}.x`) || KEYS.sectionNames.some((s) => n === s || n.startsWith(`${s}.`));
};

const GLOBAL_VALUE = new Set(["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source", "--exec-path"]);

interface GitCall {
  sub: string;
  rest: string[];
  /** `-c key=value` and `--config-env key=ENV` keys. */
  overrides: string[];
  cwd: string | null;
}

function gitCall(seg: ShellSegment, env: FloorEnv): GitCall | null {
  if (base(seg.program) !== "git") return null;
  const a = seg.argv;
  const overrides: string[] = [];
  let cwd = seg.cwd ?? env.cwd;
  let i = 0;
  while (i < a.length && a[i].startsWith("-") && a[i] !== "--") {
    const w = a[i];
    if (w === "-c") {
      overrides.push(a[i + 1] ?? "");
      i += 2;
    } else if (/^-c.+/.test(w)) {
      overrides.push(w.slice(2));
      i++;
    } else if (w === "-C") {
      if (a[i + 1] !== undefined) cwd = path.resolve(cwd, a[i + 1]);
      i += 2;
    } else if (w === "--config-env") {
      overrides.push(a[i + 1] ?? "");
      i += 2;
    } else if (w.startsWith("--config-env=")) {
      overrides.push(w.slice("--config-env=".length));
      i++;
    } else if (GLOBAL_VALUE.has(w)) i += 2;
    else i++;
  }
  return { sub: (a[i] ?? "").toLowerCase(), rest: a.slice(i + 1), overrides, cwd };
}

const keyOfOverride = (o: string): string => o.split("=", 1)[0];

const CONFIG_VALUE_OPTS = new Set(["-f", "--file", "--blob", "-t", "--type", "--default", "--comment", "--url", "--value"]);
const CONFIG_READ_OPTS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--get-color", "--get-colorbool"]);
const CONFIG_WRITE_OPTS = new Set(["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"]);

function configFloor(call: GitCall): FloorHit | null {
  const words: string[] = [];
  const opts = new Set<string>();
  let ended = false;
  for (let i = 0; i < call.rest.length; i++) {
    const w = call.rest[i];
    if (!ended && w === "--") ended = true;
    else if (!ended && w.startsWith("--") && w.includes("=")) opts.add(w.slice(0, w.indexOf("=")));
    else if (!ended && w.startsWith("-") && w.length > 1) {
      opts.add(w);
      if (CONFIG_VALUE_OPTS.has(w)) i++;
    } else words.push(w);
  }
  const has = (set: Set<string>): boolean => [...opts].some((o) => set.has(o));
  const first = (words[0] ?? "").toLowerCase();
  const alt = "Set only user.name and user.email with `git config user.name <name>`; ask the user for any other git config change.";
  if (opts.has("-e") || opts.has("--edit") || first === "edit") return hit("git-config", `\`git config --edit\` can set any key, including core.hooksPath, remote urls and credential helpers. ${alt}`);
  if (has(CONFIG_READ_OPTS) || first === "get" || first === "list") return null;
  const sectionOp = opts.has("--rename-section") || opts.has("--remove-section") || first === "rename-section" || first === "remove-section";
  if (sectionOp) {
    const name = first === "rename-section" || first === "remove-section" ? words[1] : words[0];
    if (name === undefined || !isWord(name) || floorSection(name)) return hit("git-config", `Renaming or removing the config section '${name ?? "?"}' changes hooks, remotes, urls or credentials. ${alt}`);
    return null;
  }
  const setForm = first === "set" || first === "unset";
  const key = setForm ? words[1] : words[0];
  const writes = setForm || has(CONFIG_WRITE_OPTS) || words.length >= 2;
  if (!writes) return null; // `git config <key>` reads
  if (key === undefined) return null;
  if (!isWord(key)) return hit("git-config", `The config key '${key}' is computed, so the floor cannot rule it out. ${alt}`);
  if (floorKey(key)) return hit("git-config", `Writing the git config key '${key}' changes where code is fetched or pushed, which program git runs or which credentials it uses. ${alt}`);
  return null;
}

/** Whether `git remote <sub>` changes a remote. */
function remoteFloor(call: GitCall): FloorHit | null {
  const sub = call.rest.find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
  if (!REMOTE_SUBS.has(sub)) return null;
  return hit("git-config", `\`git remote ${sub}\` changes where fetches and pushes go. Push to the existing remote with \`git push -u origin <your branch>\`; ask the user to change remotes.`);
}

const PUSH_VALUE = new Set(["--repo", "--receive-pack", "--exec", "--push-option", "-o", "--signed"]);
const PUSH_FORCE = /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=.*)?$/;

function protectedSet(env: FloorEnv): Set<string> {
  return new Set([...KEYS.protectedBranches, ...(env.protectedBranches ?? [])].map((b) => b.trim()).filter(Boolean));
}

const stripHeads = (r: string): string => r.replace(/^refs\/heads\//, "");

/** The two push floors (plan Addendum 2): (a) force, delete, mirror, any `:` or `+` refspec; (b) any push whose target is a default or protected branch. */
function pushFloor(call: GitCall, env: FloorEnv): FloorHit | null {
  const positional: string[] = [];
  let force: string | null = null;
  let all = false;
  let ended = false;
  for (let i = 0; i < call.rest.length; i++) {
    const w = call.rest[i];
    if (!ended && w === "--") ended = true;
    else if (!ended && w.startsWith("--")) {
      const name = w.includes("=") ? w.slice(0, w.indexOf("=")) : w;
      if (PUSH_FORCE.test(w)) force ??= name;
      else if (name === "--all" || name === "--branches") all = true;
      else if (PUSH_VALUE.has(name) && !w.includes("=")) i++;
    } else if (!ended && w.startsWith("-") && w.length > 1) {
      const letters = w.slice(1);
      if (/[fd]/.test(letters)) force ??= w;
      if (letters.endsWith("o")) i++;
    } else positional.push(w);
  }
  const alt = "Push only your own branch explicitly: `git push -u origin <your-branch>`. Ask the user for force pushes, deletions, mirror pushes and pushes to a default branch.";
  if (force) return hit("git-push-force", `\`git push ${force}\` rewrites or deletes remote refs. ${alt}`);
  const refspecs = positional.slice(1).filter((r) => r !== "tag");
  const odd = refspecs.find((r) => r.startsWith("+") || r.includes(":"));
  if (odd !== undefined) return hit("git-push-force", `The refspec '${odd}' can overwrite or delete any remote ref. ${alt}`);
  const prot = protectedSet(env);
  const cwd = call.cwd ?? env.cwd;
  const head = env.remoteHead?.(cwd);
  if (head) prot.add(head);
  const targets = refspecs.map((r) => (r === "HEAD" ? env.currentBranch?.(cwd) ?? "HEAD" : stripHeads(r)));
  if (!refspecs.length && !all) {
    const cur = env.currentBranch?.(cwd);
    if (cur) targets.push(cur);
  }
  if (all) return hit("git-push-protected", `\`git push --all\` includes the default and protected branches. ${alt}`);
  const bad = targets.find((t) => prot.has(t));
  if (bad !== undefined) return hit("git-push-protected", `'${bad}' is a default or protected branch. ${alt}`);
  return null;
}

/** The repo's work tree root above `cwd` and, for a linked worktree, the main checkout (lexical fallback: `cwd` itself). */
function repoRoots(cwd: string): string[] {
  let cur = cwd;
  for (let n = 0; n < 64; n++) {
    const dotGit = path.join(cur, ".git");
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return [cur];
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      const main = m ? /^(.*)[\\/]\.git[\\/]worktrees[\\/]/.exec(m[1].trim())?.[1] : undefined;
      return main ? [cur, main] : [cur];
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return [cwd];
}

/** `git -c core.attributesFile=<path> <verb>`: only `merge` with the file under the repo's .workflow/ goes on to the review (a merge driver runs arbitrary commands). */
function attributesFloor(call: GitCall, value: string, env: FloorEnv): FloorHit | null {
  const alt = "Keep the attributes file under the repo's .workflow/ and use `git -c core.attributesFile=<repo>/.workflow/<file> merge ...`.";
  if (call.sub !== "merge") return hit("git-attributes-file", `\`-c core.attributesFile\` with \`git ${call.sub || "?"}\` can name a merge or filter driver that runs arbitrary commands; only merge is allowed. ${alt}`);
  const cwd = call.cwd ?? env.cwd;
  const abs = isWord(value) ? resolveWord(value, cwd, env) : null;
  const real = abs ? (realDeep(abs) ?? abs) : null;
  const under = real !== null && repoRoots(cwd).some((r) => insideRoot(real, path.join(realDeep(r) ?? r, ".workflow"), env.platform));
  if (!under) return hit("git-attributes-file", `The attributes file '${value}' is not under the repo's .workflow/ (or cannot be resolved); a merge driver it names runs arbitrary commands. ${alt}`);
  return null;
}

/** All git floors of one segment: config writes in every form, remote changes, the push floors. */
function gitFloors(seg: ShellSegment, env: FloorEnv): FloorHit | null {
  const call = gitCall(seg, env);
  if (!call) return null;
  for (const o of call.overrides) {
    const key = keyOfOverride(o);
    if (!isWord(key) || floorKey(key)) return hit("git-config", `Setting '${key || "?"}' with -c or --config-env changes where code is fetched or pushed, which program git runs or which credentials it uses. Run git without it.`);
    if (key.trim().toLowerCase() === "core.attributesfile") {
      const h = attributesFloor(call, o.slice(o.indexOf("=") + 1), env);
      if (h) return h;
    }
  }
  if (call.sub === "config") return configFloor(call);
  if (call.sub === "remote") return remoteFloor(call);
  if (call.sub === "push" && env.child) return hit("git-push-child", "Children never push; the foreman pushes. Commit your work and report the branch.");
  if (call.sub === "push") return pushFloor(call, env);
  return null;
}

// ------------------------------------------------------------------ other programs

const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const DISK = new Set(["fdisk", "sfdisk", "cfdisk", "parted", "wipefs", "diskpart", "mkswap"]);
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put"]);
const DOWNLOAD = new Set(["curl", "wget", "fetch", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "http", "https", "xh", "aria2c"]);
const SHELL_LIKE = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "nodejs", "perl", "ruby", "php", "pwsh", "powershell", "iex", "invoke-expression"]);
const SYSTEM_DIRS = ["bin", "boot", "dev", "etc", "lib", "lib32", "lib64", "opt", "proc", "root", "sbin", "srv", "sys", "usr", "var", "system", "library", "applications", "users", "home", "volumes", "private"];

const slash = (p: string): string => p.replace(/\\/g, "/").replace(/\/+/g, "/");

/** `p` is `root` or below it (lexical, case-folded on win32 and darwin). */
export function insideRoot(p: string, root: string, platform: string = process.platform): boolean {
  const fold = platform === "win32" || platform === "darwin";
  let a = slash(p).replace(/(.)\/$/, "$1");
  let b = slash(root).replace(/(.)\/$/, "$1");
  if (fold) {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b || a.startsWith(`${b}/`);
}

function resolveWord(word: string, cwd: string | null, env: FloorEnv): string | null {
  const win = env.platform === "win32";
  const px = win ? path.win32 : path.posix;
  const w = word.replace(/^(["'])(.*)\1$/, "$2");
  const home = env.home ?? "";
  let v = w;
  if (v === "~" || v.startsWith("~/") || v.startsWith("~\\")) {
    if (!home) return null;
    v = px.join(home, v.slice(1));
  } else if (v === "$HOME" || v.startsWith("$HOME/") || v === "${HOME}" || v.startsWith("${HOME}/")) {
    if (!home) return null;
    v = px.join(home, v.replace(/^\$\{?HOME\}?/, ""));
  }
  // a glob or variable tail: judge the literal directory prefix
  const cut = v.search(/[$`*?[{]/);
  if (cut >= 0) {
    const pre = v.slice(0, cut);
    v = pre.endsWith("/") || pre.endsWith("\\") ? pre : px.dirname(pre === "" ? "." : pre);
    if (pre === "") return null;
  }
  if (px.isAbsolute(v)) return px.normalize(v);
  return cwd ? px.resolve(cwd, v) : null;
}

function systemRemoval(word: string, env: FloorEnv): boolean {
  const w = slash(word.replace(/^(["'])(.*)\1$/, "$2")).replace(/\/\*$/, "/");
  const home = env.home ? slash(env.home).replace(/\/$/, "") : "";
  if (/^(~|\$HOME|\$\{HOME\})\/?$/.test(w)) return true;
  if (/^(~|\$HOME|\$\{HOME\})\/\.?\*?$/.test(w)) return true;
  if (w === "/" || w === "//") return true;
  if (home && (w.replace(/\/$/, "") === home || w.replace(/\/$/, "") === slash(path.dirname(home)))) return true;
  const lower = w.replace(/\/$/, "").toLowerCase();
  if (SYSTEM_DIRS.some((d) => lower === `/${d}`)) return true;
  return /^[a-z]:\/?$/.test(lower) || /^[a-z]:\/(windows|users|program files( \(x86\))?|programdata)$/.test(lower);
}

function deleteOperands(seg: ShellSegment, prog: string): string[] {
  const a = seg.argv;
  if (REMOVERS.has(prog)) {
    const out: string[] = [];
    let ended = false;
    for (const w of a) {
      if (!ended && w === "--") ended = true;
      else if (ended || !w.startsWith("-") || w === "-") out.push(w);
    }
    return out;
  }
  if (prog === "find" && a.some((w) => w === "-delete")) {
    const roots: string[] = [];
    for (const w of a) {
      if (/^-[HLP]$/.test(w)) continue;
      if (w.startsWith("-") || w === "(" || w === "!") break;
      roots.push(w);
    }
    return roots.length ? roots : ["."];
  }
  return [];
}

/** Destination operands of a recursive overwrite (cp -r, rsync, tar -x -C, unzip -d). */
function overwriteDests(seg: ShellSegment, prog: string): string[] {
  const a = seg.argv;
  const ops = a.filter((w) => !w.startsWith("-") || w === "-");
  if (prog === "cp") return a.some((w) => /^-[A-Za-z]*[rRa]|^--(recursive|archive)$/.test(w)) ? ops.slice(-1) : [];
  if (prog === "rsync") return ops.length >= 2 ? ops.slice(-1) : [];
  if (prog === "tar") {
    const extract = a.some((w) => /^-[A-Za-z]*x|^--extract$|^--get$/.test(w)) || /^[A-Za-z]*x/.test(a[0] ?? "");
    if (!extract) return [];
    const out: string[] = [];
    a.forEach((w, i) => {
      if (w === "-C" || w === "--directory") out.push(a[i + 1] ?? "");
      else if (w.startsWith("--directory=")) out.push(w.slice(12));
    });
    return out;
  }
  if (prog === "unzip") {
    const out: string[] = [];
    a.forEach((w, i) => {
      if (w === "-d") out.push(a[i + 1] ?? "");
      else if (/^-d.+/.test(w)) out.push(w.slice(2));
    });
    return out;
  }
  return [];
}

function outside(word: string, cwd: string | null, env: FloorEnv): boolean {
  const abs = resolveWord(word, cwd, env);
  if (abs === null) return false; // unknown: the walker cannot say, the gate's other steps decide
  return !(env.writeRoots ?? []).some((r) => insideRoot(abs, r, env.platform));
}

function segmentFloors(seg: ShellSegment, env: FloorEnv, line: ShellSegment[]): FloorHit | null {
  const prog = base(seg.program);
  const git = gitFloors(seg, env);
  if (git) return git;
  const pw = protectedWrite(seg, prog, env, line);
  if (pw) return pw;
  if (PRIVILEGE.has(prog)) return hit("privilege", `\`${prog}\` escalates privileges. Run the command as the current user; ask the user when root is needed.`);
  if (POWER.has(prog) || (prog === "init" && /^[06]$/.test(seg.argv[0] ?? "")) || (prog === "systemctl" && seg.argv.some((w) => /^(poweroff|reboot|halt|kexec)$/.test(w)))) return hit("shutdown", "Shutting down or rebooting the machine is not allowed. Ask the user.");
  if (prog.startsWith("mkfs") || DISK.has(prog) || (prog === "diskutil" && seg.argv.some((w) => /^(erase|partition|reformat|zero|secure|apfs)/i.test(w))) || (prog === "format" && seg.argv.some((w) => /^[a-z]:$/i.test(w)))) {
    return hit("disk", `\`${prog}\` formats or repartitions a disk. Ask the user.`);
  }
  if (prog === "dd" && seg.argv.some((w) => /^of=(\/dev\/|\\\\\.\\)/i.test(w))) return hit("disk", "`dd` to a device overwrites a disk. Write to a file inside the worktree or /tmp instead.");
  for (const r of seg.redirects) if (r.op !== "<" && r.op !== "dup" && /^\/dev\/(sd|nvme|hd|vd|xvd|disk|rdisk|mmcblk)/i.test(r.target)) return hit("disk", "Redirecting into a block device overwrites a disk. Write to a file inside the worktree or /tmp instead.");
  if (REMOVERS.has(prog) || (prog === "find" && seg.argv.includes("-delete"))) {
    const ops = deleteOperands(seg, prog);
    const sys = ops.find((w) => systemRemoval(w, env));
    if (sys !== undefined) return hit("rm-system", `Removing '${sys}' (the file system root, the home directory or a system directory) is never allowed. Remove specific files inside the worktree, scratch or /tmp.`);
    const out = ops.find((w) => outside(w, seg.cwd ?? env.cwd, env));
    if (out !== undefined) return hit("delete-outside", `Deleting '${out}' outside the worktree, your scratch dir and /tmp is not allowed. Delete only inside those, or report the path to the user.`);
  }
  const dests = overwriteDests(seg, prog);
  const dout = dests.find((w) => w !== "" && outside(w, seg.cwd ?? env.cwd, env));
  if (dout !== undefined) return hit("overwrite-outside", `A recursive copy or extract into '${dout}' overwrites files outside the worktree, your scratch dir and /tmp. Extract into your scratch dir or /tmp first.`);
  if (prog === "rsync" && seg.argv.some((w) => /^--delete/.test(w))) {
    const d = seg.argv.filter((w) => !w.startsWith("-")).slice(-1)[0];
    if (d !== undefined && outside(d, seg.cwd ?? env.cwd, env)) return hit("delete-outside", `\`rsync --delete\` into '${d}' deletes files outside the worktree, your scratch dir and /tmp.`);
  }
  const pub = publishFloor(prog, seg.argv);
  if (pub) return hit("publish", `${pub} publishes a package or image. Ask the user to publish; build and test locally instead.`);
  if (SHELL_LIKE.has(prog) && seg.opaque === "stdin_fed" && line.some((s) => s !== seg && DOWNLOAD.has(base(s.program)))) return hit("download-shell", "A download piped into a shell or interpreter runs unreviewed code. Download to your scratch dir, read the file, then run what you checked.");
  for (const w of [...seg.argv, ...seg.redirects.map((r) => r.target)]) {
    const s = secretPath(w, env);
    if (s) return s;
  }
  return null;
}

function publishFloor(prog: string, a: string[]): string | null {
  const sub = a.find((w) => !w.startsWith("-"));
  if (["npm", "pnpm", "yarn", "bun"].includes(prog) && (a.some((w) => w === "publish") || /^(unpublish|deprecate)$/.test(sub ?? ""))) return `\`${prog} ${a.includes("publish") ? "publish" : sub}\``;
  if ((prog === "cargo" || prog === "poetry" || prog === "uv" || prog === "hatch" || prog === "flit") && sub === "publish") return `\`${prog} publish\``;
  if (prog === "twine" && sub === "upload") return "`twine upload`";
  if (/^python[0-9.]*$/.test(prog) && a.includes("twine") && a.includes("upload")) return "`python -m twine upload`";
  if (prog === "gem" && sub === "push") return "`gem push`";
  if (prog === "dotnet" && a.includes("nuget") && a.includes("push")) return "`dotnet nuget push`";
  if ((prog === "docker" || prog === "podman") && sub === "push") return `\`${prog} push\``;
  if ((prog === "vsce" || prog === "ovsx") && sub === "publish") return `\`${prog} publish\``;
  if (prog === "gh" && a[0] === "release" && /^(create|upload|edit|delete)$/.test(a[1] ?? "")) return `\`gh release ${a[1]}\``;
  return null;
}

const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.config\/gcloud|\.config\/gh|\.kube\/config|\.docker\/config\.json|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc)(\/|$)/i;
const SECRET_FILE = /(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(_[\w-]+)?|[^/]+\.(pem|key|p12|pfx|jks|keystore))$/i;

/** A secret or key path (read or write), by the path alone. Bare names (no separator, no `~`) are not judged here; the overlay's path rules cover those. */
const SECRET_EXTRA = /(^|\/)(\.config\/hub|\.config\/glab-cli|\.pi\/extensions\/pi-permission-system|credentials(\.[^/]*)?)(\/|$)/i;
const ENV_FILE = /(^|\/)([^/]*\.env|\.env\.[^/]+)$/i;
/** A bare (separator-free) word is a secret only when it is a dotenv name itself, so `process.env` or `app.env` as an argument is not judged. `.envrc` is not a secret. */
const ENV_BARE = /^\.env(\.[^/]+)?$/i;
const GIT_CONFIG_FILE = /(^|\/)\.git\/config$/i;
const ENV_EXEMPT = /\.env\.(example|sample|template)$/i;

export function secretPath(word: string, env: FloorEnv): FloorHit | null {
  const w = slash(word.replace(/^(["'])(.*)\1$/, "$2"));
  const m = /^-{1,2}[\w-]+=(.+)$/.exec(w);
  const x = m ? m[1] : w;
  const pathLike = x.includes("/") || x.startsWith("~");
  const bareEnv = !pathLike && ENV_BARE.test(x) && !ENV_EXEMPT.test(x);
  let bad = bareEnv || (pathLike && !/\.pub$/.test(x) && (GIT_CONFIG_FILE.test(x) || SECRET_DIRS.test(x) || SECRET_FILE.test(x) || SECRET_EXTRA.test(x) || (ENV_FILE.test(x) && !ENV_EXEMPT.test(x))));
  if (!bad && pathLike) {
    const abs = resolveWord(x, env.cwd, env);
    if (abs !== null) {
      const mine = formsOf(abs, env);
      bad = authFiles(env).some((a) => formsOf(a, env).some((f) => mine.includes(f)));
    }
  }
  if (!bad) return null;
  return hit("secret-path", `'${x}' is a secret or key path (SSH, GnuPG, cloud or registry credentials, private keys, Pi's auth file). Never read or write it; ask the user for the value you need.`);
}

// ------------------------------------------------------------------ raw text

const CMD = "(?:^|[;&|(\\n`]|\\$\\()\\s*(?:\\w+=\\S*\\s+)*";
const RAW: { name: string; re: RegExp; reason: string }[] = [
  { name: "download-shell", re: /\b(?:curl|wget|fetch|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:env\s+\S+\s+)?(?:\/\S*\/)?(?:sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby|php|iex|invoke-expression|pwsh|powershell)\b/i, reason: "A download piped into a shell or interpreter runs unreviewed code. Download to your scratch dir, read the file, then run what you checked." },
  { name: "download-shell", re: /\b(?:sh|bash|zsh|dash|ksh|source|\.)\s+<\(\s*(?:curl|wget)\b/i, reason: "A download run through process substitution runs unreviewed code. Download to your scratch dir, read it, then run it." },
  { name: "download-shell", re: /\b(?:eval|iex|(?:ba|z|da|k)?sh\s+-c)\b[^\n;&|]*(?:\$\(|`)\s*(?:curl|wget|iwr|irm)\b/i, reason: "A downloaded script evaluated in the shell runs unreviewed code. Download to your scratch dir, read it, then run it." },
  { name: "privilege", re: new RegExp(`${CMD}(?:sudo|doas|su|pkexec)(?:\\s|$)`), reason: "Privilege escalation is not allowed. Run the command as the current user; ask the user when root is needed." },
  { name: "shutdown", re: new RegExp(`${CMD}(?:shutdown|reboot|halt|poweroff)(?:\\s|$)`), reason: "Shutting down or rebooting the machine is not allowed. Ask the user." },
  { name: "disk", re: new RegExp(`${CMD}(?:mkfs\\S*|fdisk|sfdisk|parted|wipefs|diskpart)(?:\\s|$)`), reason: "Formatting or repartitioning a disk is not allowed. Ask the user." },
  { name: "disk", re: /\bdd\b[^\n;&|]*\bof=(?:\/dev\/|\\\\\.\\)/i, reason: "`dd` to a device overwrites a disk. Write to a file inside the worktree or /tmp instead." },
  { name: "git-config", re: /(?:^|[\s;&|(=])GIT_CONFIG_(?:COUNT|KEY_[0-9]+|VALUE_[0-9]+|GLOBAL|SYSTEM|PARAMETERS)\s*=/, reason: "Injecting git config through GIT_CONFIG_* variables can change hooks, remotes and credentials. Run git without them." },
  { name: "git-config", re: /--config-env\b/, reason: "`--config-env` injects git config. Run git without it." },
];

/** Floors that need the raw text only: specific enough to apply to every shell line (a download piped into a shell, privilege, power, disk, injected git config). */
export function rawFloors(text: string): FloorHit | null {
  for (const r of RAW) if (r.re.test(text)) return hit(r.name, r.reason);
  return null;
}

/** The raw words of a line, split on whitespace, quotes and `=`, lower-cased (for the opaque-line key scan). */
const rawWords = (text: string): string[] => text.toLowerCase().split(/[\s'"`=;&|()<>]+/).filter(Boolean);

/**
 * Floors on the raw text of a line the walker could not state exactly (opaque segment or parse error): a floor pattern anywhere in the text
 * denies, so obfuscation reaches a review or a deny, never a default allow.
 */
export function opaqueTextFloors(text: string, env: FloorEnv): FloorHit | null {
  const lower = text.toLowerCase();
  if (/\bgit\b/.test(lower)) {
    if (env.child && /\bpush\b/.test(lower)) return hit("git-push-child", "The unparsed line looks like a git push. Children never push; the foreman pushes.");
    const key = rawWords(text).find((w) => floorKey(w) && w.includes("."));
    if (key !== undefined) return hit("git-config", `The unparsed line names the git config key '${key}', which changes where code is fetched or pushed, which program git runs or which credentials it uses. Run a plain, literal command.`);
    if (/\bremote\s+(?:add|set-url|rename|remove|rm|set-head|set-branches)\b/.test(lower)) return hit("git-config", "The unparsed line changes a git remote. Run a plain, literal command; ask the user to change remotes.");
    if (/\bpush\b/.test(lower) && /(?:\s--(?:force|force-with-lease|force-if-includes|mirror|delete|prune|all)\b|\s-[a-z]*[fd][a-z]*\b|\s\+\S|\s:\S)/.test(lower)) return hit("git-push-force", "The unparsed line looks like a force, delete, mirror or colon-refspec push. Push your own branch explicitly: `git push -u origin <your-branch>`.");
    const prot = [...protectedSet(env)].find((b) => new RegExp(`\\bpush\\b[^\\n;&|]*\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
    if (prot !== undefined) return hit("git-push-protected", `The unparsed line pushes '${prot}', a default or protected branch. Push your own branch explicitly: \`git push -u origin <your-branch>\`.`);
  }
  if (/\b(?:npm|pnpm|yarn|bun|cargo|twine|gem|poetry)\s+(?:\S+\s+)*(?:publish|upload|push)\b/.test(lower)) return hit("publish", "The unparsed line publishes a package. Ask the user to publish.");
  if (new RegExp(`${CMD}rm\\s+(?:-\\S+\\s+)*(?:--\\s+)?(?:/|~|\\$HOME|\\$\\{HOME\\})/?\\*?(?:\\s|$)`).test(text)) return hit("rm-system", "Removing the file system root or the home directory is never allowed.");
  return null;
}

/** The floors of a parsed shell line: raw-text floors, the opaque-line scan, then every segment. */
export function lineFloors(text: string, segments: ShellSegment[], env: FloorEnv): FloorHit | null {
  const raw = rawFloors(text);
  if (raw) return raw;
  if (segments.some((s) => s.opaque !== null)) {
    const o = opaqueTextFloors(text, env) ?? opaqueProtected(text, env);
    if (o) return o;
  }
  for (const s of segments) {
    const h = segmentFloors(s, env, segments);
    if (h) return h;
  }
  return null;
}

/** The floors of a path tool call (read, write, edit, grep, find, ls, foreman_move, foreman_copy): a secret or key path. */
export function pathFloors(input: Record<string, unknown>, env: FloorEnv, tool?: string): FloorHit | null {
  for (const k of ["path", "file_path", "filePath", "src", "dst", "glob", "pattern"]) {
    const v = input[k];
    if (typeof v === "string" && v) {
      const h = secretPath(v, env);
      if (h) return h;
    }
  }
  return tool !== undefined && WRITE_TOOLS.has(tool) ? protectedToolWrite(tool, input, env) : null;
}

// ------------------------------------------------------------------ policy files, harness state, config keys (writes)

const WRITE_TOOLS = new Set(["write", "edit", "foreman_move", "foreman_copy"]);
/** A foreman config file by name (`foreman.json`, `foreman.defaults.json`, `foreman.local.json`). */
const CONFIG_FILE = /(?:^|[\\/])foreman(?:[.-][\w.-]*)?\.json$/;
/** The config keys no agent write may touch: safety.permissions*, safety.policy*, gate.* (read from the written text, fail closed). */
const FLOOR_KEYS = /\b(?:permissions|policy[A-Za-z]*|gate)\b/;

const foldFor = (env: FloorEnv): boolean => (env.platform ?? process.platform) === "win32" || (env.platform ?? process.platform) === "darwin";

/** realpath of the deepest existing ancestor with the missing tail re-appended. */
function realDeep(abs: string): string | null {
  const tail: string[] = [];
  let cur = abs;
  for (let n = 0; n < 64; n++) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

/** The comparable spellings of an absolute path: lexical and symlink-resolved, slashes unified, case-folded where the file system is. */
function formsOf(abs: string, env: FloorEnv): string[] {
  const fold = foldFor(env);
  const real = realDeep(abs);
  return [...new Set([abs, ...(real ? [real] : [])].map((p) => {
    const s = slash(p).replace(/(.)\/$/, "$1");
    return fold ? s.toLowerCase() : s;
  }))];
}

/** The agent dirs: the session's and the default `<home>/.pi/agent`. */
const agentDirs = (env: FloorEnv): string[] => [env.agentDir, env.home ? path.join(env.home, ".pi", "agent") : undefined].filter((x): x is string => !!x);
const authFiles = (env: FloorEnv): string[] => agentDirs(env).map((a) => path.join(a, "auth.json"));

interface Protected {
  p: string;
  /** Covers everything below `p` too. */
  tree: boolean;
  /** Only files with this suffix below `p` (`flat`: directly in `p`). */
  ext?: string;
  flat?: boolean;
}

/** Whether the spelling `f` is covered by the entry spelled `g`. */
function covers(e: Protected, g: string, f: string): boolean {
  if (e.ext !== undefined) return f.endsWith(e.ext) && (e.flat ? path.posix.dirname(f) === g : f.startsWith(`${g}/`));
  return f === g || (e.tree && f.startsWith(`${g}/`));
}

/** Policy files of every layer and the harness state files. */
function protectedEntries(env: FloorEnv): Protected[] {
  const out: Protected[] = [];
  if (env.pkgRoot) out.push({ p: path.join(env.pkgRoot, "config", "permissions.policy.md"), tree: false });
  for (const a of agentDirs(env)) {
    const s = path.join(a, "pi-foreman");
    for (const f of ["policy.md", "managed.json", "state/round-parents.json", "state/bridge-trust.json"]) out.push({ p: path.join(s, f), tree: false });
    for (const d of ["state/approvals", "state/gate"]) out.push({ p: path.join(s, d), tree: true });
    out.push({ p: path.join(a, "sessions"), tree: true, ext: ".jsonl" });
  }
  if (env.sessionDir) out.push({ p: env.sessionDir, tree: false, ext: ".jsonl", flat: true });
  out.push({ p: path.join(env.cwd, ".workflow", "policy.md"), tree: false });
  for (const f of env.policyFiles ?? []) {
    const r = f.startsWith("~") ? resolveWord(f, env.cwd, env) : path.resolve(env.cwd, f);
    if (r) out.push({ p: r, tree: false });
  }
  return out;
}

const globRe = (g: string, fold: boolean): RegExp => new RegExp(`^${g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`, fold ? "i" : "");

/** The protected entry a word names (a glob word is matched against the entries), or null. */
function protectedWord(word: string, cwd: string, env: FloorEnv, entries: Protected[]): string | null {
  const w = slash(word.replace(/^(['"])(.*)\1$/, "$2"));
  const m = /^-{1,2}[\w-]+=(.+)$/.exec(w) ?? /^[A-Za-z_]\w*=(.+)$/.exec(w);
  for (const x of m ? [w, m[1]] : [w]) {
    if (!x || /\s/.test(x)) continue;
    let v = x;
    if (/^(~|\$HOME|\$\{HOME\})(\/|$)/.test(v)) {
      if (!env.home) continue;
      v = path.posix.join(slash(env.home), v.replace(/^(~|\$HOME|\$\{HOME\})/, ""));
    }
    const cut = v.search(/[$`]/);
    if (cut >= 0) v = v.slice(0, cut);
    if (!v) continue;
    const abs = path.posix.isAbsolute(v) || path.win32.isAbsolute(v) ? v : slash(path.resolve(cwd, v));
    if (/[*?]/.test(abs)) {
      const re = globRe(abs, foldFor(env));
      const lit = abs.slice(0, abs.search(/[*?]/));
      const dir = formsOf(lit.endsWith("/") ? lit.slice(0, -1) : path.posix.dirname(lit), env);
      const found = entries.find((e) => formsOf(e.p, env).some((g) => (e.ext !== undefined ? (abs.endsWith(e.ext) || /[*?]$/.test(abs)) && dir.some((f) => (e.flat ? f === g : f === g || f.startsWith(`${g}/`))) : re.test(g) || (e.tree && dir.some((f) => f === g || f.startsWith(`${g}/`))))));
      if (found) return found.p;
      continue;
    }
    const mine = formsOf(abs, env);
    const found = entries.find((e) => formsOf(e.p, env).some((g) => mine.some((f) => covers(e, g, f))));
    if (found) return found.p;
  }
  return null;
}

const protHit = (what: string, word: string): FloorHit => hit("policy-file", `${what} '${word.slice(0, 120)}', a policy file or a harness state file (policy.md of any layer, managed.json, state/round-parents.json, state/bridge-trust.json, state/approvals, state/gate) or a Pi session file (*.jsonl under the sessions dir). Ask the user to change it.`);
const configHit = (what: string, word: string): FloorHit => hit("config-keys", `${what} the safety.permissions*, safety.policy* or gate.* keys of the foreman config file '${word.slice(0, 120)}'. The agent never changes these keys. Ask the user to change them.`);

const READ_PROGS = new Set(["cat", "head", "tail", "less", "more", "ls", "stat", "file", "wc", "grep", "egrep", "fgrep", "rg", "diff", "cmp", "echo", "printf", "cd", "pushd", "popd", "pwd", "test", "[", "realpath", "readlink", "basename", "dirname", "md5sum", "shasum", "sha256sum", "nl", "od", "hexdump", "strings", "tree", "du", "df", "which", "type", "true", "false", "jq", "sort", "uniq", "cut", "tr"]);
const GIT_NONWRITE = new Set(["diff", "log", "show", "status", "blame", "ls-files", "grep", "cat-file", "rev-parse", "check-ignore", "add", "commit", "rev-list", "describe", "shortlog"]);

/** Whether the segment only reads (or stages) its path operands. */
function readOnlySegment(seg: ShellSegment, prog: string): boolean {
  const a = seg.argv;
  if (READ_PROGS.has(prog)) return true;
  if (prog === "sed") return !a.some((w) => /^-[A-Za-z]*i|^--in-place/.test(w));
  if (prog === "find") return !a.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w));
  if (prog === "git") {
    const sub = a.find((w, i) => !w.startsWith("-") && (i === 0 || !/^(-C|-c|--git-dir|--work-tree)$/.test(a[i - 1])));
    return sub !== undefined && GIT_NONWRITE.has(sub);
  }
  return false;
}

/** The source operands of a copy (every positional but the destination): read only. */
function copySourceWords(seg: ShellSegment, prog: string): Set<string> {
  const out = new Set<string>();
  if (prog !== "cp" && prog !== "rsync") return out;
  const a = seg.argv;
  const target = a.some((w) => w === "-t" || w.startsWith("--target-directory"));
  const pos = a.filter((w) => !w.startsWith("-"));
  (target ? pos : pos.slice(0, -1)).forEach((w) => out.add(w));
  return out;
}

const lineWords = (line: ShellSegment[]): string[] => line.flatMap((s) => [s.program, ...s.argv, ...s.redirects.map((r) => r.target)]);

/** Floor: a shell write to a policy file or harness state file, or to a foreman config file in a line that carries a floored key. */
function protectedWrite(seg: ShellSegment, prog: string, env: FloorEnv, line: ShellSegment[]): FloorHit | null {
  const cwd = seg.cwd ?? env.cwd;
  const entries = protectedEntries(env);
  const keys = lineWords(line).some((w) => FLOOR_KEYS.test(w));
  const configWord = (w: string): boolean => keys && CONFIG_FILE.test(slash(resolveWord(w.replace(/^[^=/]*=/, ""), cwd, env) ?? w));
  for (const r of seg.redirects) {
    if (r.op === "<" || r.op === "dup") continue;
    if (protectedWord(r.target, cwd, env, entries)) return protHit("This shell redirect writes", r.target);
    if (configWord(r.target)) return configHit("This shell redirect writes", r.target);
  }
  if (readOnlySegment(seg, prog)) return null;
  const src = copySourceWords(seg, prog);
  for (const w of seg.argv) {
    if (src.has(w)) continue;
    if (protectedWord(w, cwd, env, entries)) return protHit(`\`${prog}\` writes`, w);
    if (configWord(w)) return configHit(`\`${prog}\` writes`, w);
  }
  return null;
}

/** Raw-text scan of an opaque line: a protected path, or a config file beside a floored key, in any word denies. */
function opaqueProtected(text: string, env: FloorEnv): FloorHit | null {
  const entries = protectedEntries(env);
  const words = text.replace(/\$(?=['"])/g, "").replace(/['"`]/g, "").split(/[\s;&|<>(){},]+/).filter(Boolean);
  const w = words.find((x) => protectedWord(x, env.cwd, env, entries));
  if (w !== undefined) return protHit("The unparsed line names", w);
  if (FLOOR_KEYS.test(text)) {
    const c = words.find((x) => CONFIG_FILE.test(x));
    if (c !== undefined) return configHit("The unparsed line names a file next to", c);
  }
  return null;
}

/** Floor: a write, edit, move or copy tool call whose written path is a policy or state file, or a foreman config file written with a floored key. */
function protectedToolWrite(tool: string, input: Record<string, unknown>, env: FloorEnv): FloorHit | null {
  const entries = protectedEntries(env);
  const moves = tool === "foreman_move" || tool === "foreman_copy";
  const keys = moves ? ["dst", ...(tool === "foreman_move" ? ["src"] : [])] : ["path", "file_path", "filePath"];
  const body = Object.entries(input).filter(([k, v]) => typeof v === "string" && !keys.includes(k)).map(([, v]) => v as string).concat(JSON.stringify(input.edits ?? ""));
  for (const k of keys) {
    const v = input[k];
    if (typeof v !== "string" || !v) continue;
    if (protectedWord(v, env.cwd, env, entries)) return protHit(`\`${tool}\` writes`, v);
    const abs = resolveWord(v, env.cwd, env);
    if (!moves && abs !== null && CONFIG_FILE.test(slash(abs)) && body.some((b) => FLOOR_KEYS.test(b))) return configHit(`\`${tool}\` writes`, v);
  }
  return null;
}
