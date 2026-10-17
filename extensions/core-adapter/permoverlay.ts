// Permission overlay (design section 5, layer 1b). Runs in `tool_call` BEFORE everything else,
// independent of @gotgenes/pi-permission-system (PS).
//
// Why it exists: PS merges its project file over the global one and that merge can loosen
// (a project `bash: "allow"` replaces the whole global deny map), and PS has no session scope.
// So the adapter enforces, by itself:
//   (a) the full merged DENY set: the packaged baseline + safety.permissions.deny/paths.deny of
//       L1 -> L3 -> L2 + whatever the project and session layers added. Deny beats any allow.
//   (b) the ASK entries the project/session layers added on top of L1 -> L3 -> L2 (the rest of
//       the asks live in the generated PS file and PS prompts for them). Confirm in TUI/RPC;
//       print mode and children are denied ("ask the foreman").
//
// Matcher differences from PS (tree-sitter bash parser + wildcard matcher), by design:
//  1. Wildcards are PS's: `*` = any characters including `/` (so `**` == `*`), `?` = one
//     character, a trailing ` *` also matches the bare command; a `/` in a pattern also matches
//     `\`. Bash patterns are case-sensitive (case-insensitive for the powershell tool); path
//     patterns are case-insensitive on darwin and win32 (case-insensitive file systems, so
//     `.ENV` is `.env`) and separator-agnostic on win32.
//  2. Parsing: PS uses a real bash grammar. This is a small hand-written lexer (quotes, `\`
//     escapes, ANSI-C `$'\x2e'` quoting, `; && || | & newline ( ) ` and `<`/`>`, `$(...)` and
//     backticks anywhere, `# ` comments, `sh|bash|zsh|... -c`, `eval`, `pwsh -c`, `find -exec`,
//     wrapper commands like sudo/env/nohup/xargs up to depth 4). PS floors the same constructs
//     to `ask`; here a deny rule is looked up inside them instead. Heredoc bodies are lexed as
//     ordinary text (more words are checked, never fewer). Brace expansion (`.{e,x}nv`,
//     `{1..3}`) is applied to every word, quoted or not (more words, never fewer). Inline code
//     of `python -c`, `node -e/-p`, `perl -e`, `ruby -e` is split into its string literals, and
//     literals joined by `+`/`.` are joined (`"."+"env"`), each checked as a path. On win32 a
//     bash command is lexed a second time with `\` kept literal (native `C:\...` paths), and
//     `/c/...` is read as `C:/...`.
//  3. Paths in shell commands: EVERY word of every command (options' `=value` parts, redirect
//     targets, quoted words) is resolved (`~`, `$HOME`, cwd, `..`, symlinks, globs in any
//     segment) and checked against the deny paths, so `cat .env`, `head ~/.ssh/id_x`,
//     `grep -r t .env`, `grep -r x ~/.ssh`, `git diff --no-index a .env` all deny. PS gates only
//     tokens it classifies as path candidates and, for a bare name, only when the file exists;
//     here a path-shaped word (contains `/` or `\`, or starts with `.` or `~`) is checked whether or not the file
//     exists (so `touch .env` and `echo x > .env` deny), and a bare word only when it exists.
//     A directory that holds denied files is denied by its own name when a pattern matches
//     `<dir>/` (`~/.ssh`, `~/.aws`), but not when it is an ANCESTOR (`grep -r x ~`): like PS,
//     the overlay does not know what a recursive command will walk into.
//  4. Not modelled (both PS and the overlay): other shell variables, command output used as a
//     path, `cd` tracking (the overlay checks words against the session cwd and as typed),
//     hard links, string building beyond adjacent literals in inline code, heredoc-fed scripts
//     (`python3 - <<EOF`: the body's words are checked only as plain words).
//  5. Exceptions: the baseline lists `*.env.example` etc. as exceptions; they apply as in the
//     generated PS file (last matching rule wins, exceptions sit after the baseline denies and
//     before the user's own denies).
//  6. The overlay ignores PS's per-agent frontmatter and `yoloMode`: deny is deny.
//  7. Write protection (baseline `protect`, overlay only; PS cannot tell reads from writes):
//     `.git` (S1/S2, every session), the project's `.pi/` and `.agents/`, `<agentDir>`'s
//     foreman.json, settings.json, agents/, npm/, extensions/, pi-foreman/claude-config/ and
//     pi-foreman/state/ (the drift snapshots and their seen markers), the
//     project's `.claude/` and `.mcp.json`, `~/.claude/`, `~/.gitconfig` and the git config
//     dirs (asked in the foreman, denied in children) and the package root (file tools; shell
//     words in children only). Paths resolve symlinks of the deepest existing ancestor, so a
//     new file below a symlinked directory is seen at its target; `<rev>:<path>` words are
//     also checked by their path part. Checked on write/edit, the paths of
//     foreman_move/foreman_copy and, as for deny paths, every shell word — so in a shell
//     command these also block reads (`cat .git/config`); `git status` names no such path.
//     Shell words are path arguments only: the pattern/script operands of a line made of pure
//     read commands are skipped, `*` skips dot entries and `\` is no separator off win32 (checkShell).
//     The pattern of grep/rg and their --include/--exclude/--exclude-dir/--glob values are never path words.
//     Heredoc bodies are scanned like any shell text (a `.pi` or `$x` in prose still trips the guards). A command of read-only verbs only (no in-place sed, `sort -o`,
//     `find -exec`, tee, xargs, PowerShell) and no write redirect at all (any target) skips the write-only rules:
//     writeAsk/writeAskSelfHost for children, the ask list for the foreman; deny and childDeny never skip.
//     Children may not touch childBlock paths (handoffs except plan/result.md, subagent artifacts,
//     foreman.json, pi-foreman/claude-config, sibling round worktrees, other children's scratch dirs) nor run `git worktree` beyond list/remove; a child may cd inside its workspace root and scratch dir.
//     grep's `glob` and find's `pattern` are checked joined to the tool's `path`.
//     removeAsk (`<agentDir>`, its parent (`~/.pi` by default) and `<agentDir>/pi-foreman`, the
//     ancestors of the state folder):
//     only a remove or rename of the folder itself is asked/denied — an operand of rm, rmdir,
//     unlink, trash, mv, rename, del/rd, Remove-Item/Move-Item/Rename-Item and aliases, find
//     -delete, a literal in inline code (`python -c`), or foreman_move's source. Reads and
//     listings of those folders stay allowed; `cd` + a relative operand is not seen (item 4).
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Json } from "./config.ts";
import { workspaceOf } from "./python.ts";
import { resolveVars } from "./shellvars.ts";
import { probeFileHit } from "./splitliteral.ts";

export interface PathRule {
  pattern: string;
  action: "deny" | "allow";
}

/** Write protection: `main`/`child` = the decision per session kind; `shell` = also shell words. */
export interface ProtectRule {
  pattern: string;
  main: "deny" | "ask" | null;
  child: "deny";
  shell: boolean;
  /** Children: also check shell words (writeAsk: the package root, T11). */
  childShell?: boolean;
  /** removeAsk: only a remove or rename of the path itself (operands of rm/mv/trash/..., inline code, foreman_move src). */
  removeOnly?: boolean;
  /**
   * A shell command made only of read-only verbs skips this rule: `main` = the foreman (ask list),
   * `child` = a child (writeAsk lists). deny and childDeny rules never carry it.
   */
  readOk?: "main" | "child";
  /** Comes from the writeAsk lists (the foreman's owned-root skip applies to these only). */
  fromWriteAsk?: boolean;
}

/** Roots owned by the foreman session (owned.ts provides them); optional, today's behaviour without it. */
export interface OwnedRoots {
  readWrite: string[];
  readOnly: string[];
  /** The child's own scratch dir (the `$FOREMAN_SCRATCH` subtree). */
  childScratch?: string;
  /** `<tmp>/pi-foreman-scratch`: a child may use only its own subdir (`childScratch` / `ctx.scratch`). */
  childScratchRoot?: string;
}

export interface OverlayRules {
  bashDeny: string[];
  bashAsk: string[];
  pathRules: PathRule[];
  pathAsk: string[];
  protect: ProtectRule[];
  /** Children only: path tools and shell operands below these are denied (the foreman's handoff, artifact and config paths). */
  childBlock?: string[];
  /** Paths below childBlock that stay open to children. */
  childBlockExcept?: string[];
  /** childBlock patterns that stay open below the child's own workspace root (its round worktree). */
  childBlockInWorkspace?: string[];
  owned?: OwnedRoots;
}

export interface Baseline {
  bash: { deny: string[]; ask: string[]; allow?: string[] };
  paths: { deny: string[]; except: string[] };
  protect: { deny: string[]; ask: string[]; childDeny: string[]; writeAsk: string[]; writeAskSelfHost?: string[]; removeAsk?: string[] };
}

export type Decision = { kind: "deny" | "ask"; reason: string };

export interface MatchCtx {
  cwd: string;
  home: string;
  platform: string;
  /** Shell grammar of the tool: bash-like or PowerShell. */
  shell?: "posix" | "powershell";
  /** Session kind for the write protection (default main). */
  role?: "main" | "child";
  /** Child only: the round worktree the child's cwd lies in, or its own isolation worktree under a round (roundsurface.ts roundRoots); never a sibling isolation worktree, so `*.worktrees/*` stays closed around them. */
  roundRoots?: string[];
  /** Child only: round worktrees the child may read but not write (roundsurface.ts childSurface); a write below one outside `roundRoots` and the scratch dir is denied. */
  roundReadRoots?: string[];
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  realpath?: (p: string) => string | null;
  list?: (dir: string) => string[];
  /** Write protection of bash words: `\` is no separator off win32, and `*` skips dot entries unless `dotGlob`. */
  bashWords?: boolean;
  dotGlob?: boolean;
  /** Child only: its scratch dir (childscratch.ts); `$FOREMAN_SCRATCH` expands to it and cd may enter it. */
  scratch?: string;
  /** Owned roots; `owned.childScratch` stands in for `scratch`. Defaults to the rules' own. */
  owned?: OwnedRoots;
  /**
   * Child only: path patterns a child may READ although the child block names them (the bound round ledger and its `LEDGER-*.md` siblings, the
   * session's own handoff dirs, the session's round worktrees). A write there stays closed; a `*` path rule does not fire on them either.
   */
  readable?: string[];
  /** Variable names the checked line binds somewhere (boundNames): `expandWord` trusts no `$S` / `$HOME` among them. */
  bound?: ReadonlySet<string>;
}

const scratchOf = (ctx: MatchCtx): string | undefined => ctx.scratch ?? ctx.owned?.childScratch;

/** The names `expandWord` trusts while the line binds them nowhere. */
const TRUSTED_VARS = new Set(["HOME", "S", "FOREMAN_SCRATCH"]);
/** The names a line with `eval` / `source` / `.` binds (boundNames): the trusted ones and `$env:USERPROFILE`'s. */
const EVAL_BOUND = [...TRUSTED_VARS, "USERPROFILE"];

/**
 * The variable names a shell line may bind anywhere (fail closed: over-matching is fine): `N=`, `N+=`, `N[..]=`
 * (also after export/env/declare/local/readonly/typeset/let), `${N=..}` / `${N:=..}`, and N as a bare word
 * (`read N`, `read N<f`, `read N<<<x`, `for N in`, `printf -v N`, `unset N`, `mapfile -t N<f`, `getopts o N`, `declare -n r=N`):
 * any standalone name token after a non-identifier, non-`$`, non-`-` lead counts, whatever follows it (`$HOME_OLD` and
 * `HOMEDIR=` never bind HOME). `eval`, `source` or `.` as a command word binds every trusted name (EVAL_BOUND).
 */
export function boundNames(command: string, shell: "posix" | "powershell" = "posix"): Set<string> {
  const out = new Set<string>();
  const all = (): void => EVAL_BOUND.forEach((n) => out.add(n));
  // PowerShell (case-insensitive): `$N = ..`, `$env:N = ..`, `${env:N} = ..`, an `env:N` / `Env:\N` drive path (Set-Item, New-Item,
  // si, ni, -Path ..), `[System.Environment]::SetEnvironmentVariable('N', ..)`; a non-literal env: name or variable name binds every trusted name
  if (shell === "powershell") {
    const add = (n: string): void => void out.add(n).add(n.toUpperCase());
    // backtick escapes (`${env:HO`ME}`, `Set-Item env:HO`ME`) vanish before PowerShell reads the name
    const plain = command.replace(/`([^\r\n])/g, "$1");
    // the colon form `-Path:env:HOME` / `-Name: HOME` is also read as `-Path env:HOME` (an extra text: the name regexes only add)
    const colon = (s: string): string => s.replace(/(^|[\s;|({}=])(-[A-Za-z]+):[ \t]*(?=\S)/g, "$1$2 ");
    for (const text of new Set([command, plain, colon(command), colon(plain)])) {
      for (const m of text.matchAll(/\$(?:[A-Za-z]+:)?([A-Za-z_][A-Za-z0-9_]*)\s*[-+*/%]?\?{0,2}=(?!=)/gi)) add(m[1]);
      for (const m of text.matchAll(/\$\{(?:[A-Za-z]+:)?([A-Za-z_][A-Za-z0-9_]*)\}\s*[-+*/%]?\?{0,2}=(?!=)/gi)) add(m[1]);
      // `.Home = ..` (a provider's Home property), any property or name assigned
      for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[-+*/%]?\?{0,2}=(?!=)/g)) add(m[1]);
      for (const m of text.matchAll(/(?<![\w$:{])(?:env|variable):[\\/]?([A-Za-z_][A-Za-z0-9_]*)?/gi)) (m[1] ? [m[1]] : EVAL_BOUND).forEach(add);
      // provider-qualified paths: `Environment::HOME`, `Microsoft.PowerShell.Core\Environment::HOME`, `Variable::HOME`
      for (const m of text.matchAll(/(?<![\w\]])(?:environment|variable)::([A-Za-z_][A-Za-z0-9_]*)?/gi)) (m[1] ? [m[1]] : EVAL_BOUND).forEach(add);
      // a name argument that is not one quoted literal (`'HO'+'ME'`, `$n`) may be any name
      for (const m of text.matchAll(/SetEnvironmentVariable\s*\(\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1(?=\s*[,)]))?/gi)) (m[2] ? [m[2]] : EVAL_BOUND).forEach(add);
      // `$ExecutionContext.SessionState.PSVariable.Set('HO'+'ME', ..)`, `.SetValue(..)`: the same
      for (const m of text.matchAll(/\.Set(?:Value)?\s*\(\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1(?=\s*[,)]))?/gi)) (m[2] ? [m[2]] : EVAL_BOUND).forEach(add);
      // every name token, in any case: `Set-Variable -Name home`, `Rename-Item env:X -NewName home`
      for (const m of text.matchAll(/(?<![\w$:])(?<!\$\{)([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g)) add(m[1]);
      // code this check never sees, or an item path built at run time: every trusted name may be rebound
      // (`.InvokeReturnAsIs(`, `.InvokeWithContext(`, `.NewScriptBlock(`, anything reached through `$ExecutionContext.InvokeCommand`)
      if (/\[\s*scriptblock\s*\]\s*::\s*create|\.invoke\w*\s*\(|\.newscriptblock\s*\(|\$\{?executioncontext\}?\s*\.\s*invokecommand|\badd-type\b/i.test(text)) all();
      // a splat (`Set-Item @p`, `Remove-Variable @{..}`, `@(..)`) on an item cmdlet anywhere may name any item
      for (const m of text.matchAll(/(?<![\w$.\\/:-])([A-Za-z][\w-]*)(?![\w-])(?=([^;|\n]*))/g)) if (PS_ITEM.has(m[1].toLowerCase()) && /(?:^|\s)@[\w{(]/.test(m[2])) all();
      // eval-like cmdlets anywhere, not only as a command word (`$null = iex $c`, `(iex $c)`, `[void](iex $c)`), the `&` call operator
      // and a dot-source after `=`, `(`, `;`, `|`, `{`, `}`, `]`
      for (const m of text.matchAll(/(?<![\w$.\\/:-])([A-Za-z][\w.-]*)(?![\w.-])/g)) if (PS_EVAL.has(m[1].toLowerCase())) all();
      if (/(?<![&\w])&(?!&)|(?:^|[=(;|{}\]])\s*\.\s+\S/.test(text)) all();
      // item cmdlets anywhere (`$null = New-Item -Path ('en'+'v:HOME')`): a path / name that is not one literal may name any item
      for (const m of text.matchAll(/(?<![\w$.\\/:-])(set-item|si|new-item|ni|rename-item|rni|set-content|sc|set-variable|sv|new-variable|nv)(?![\w-])([^;|\n]*)/gi)) {
        const args = m[2].match(/'[^']*'|"[^"]*"|\([^)]*\)?|[^\s(]+/g) ?? [];
        const target = psTarget(args);
        const fsPath = target !== undefined && /^(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|~)[\\/][^$()`+{}'"]*$/i.test(target);
        const literal = target !== undefined && (/^'[^']*'$/.test(target) || /^"[^"$`]*"$/.test(target) || /^[^$()`+{}'"]+$/.test(target) || fsPath);
        if (!literal) all();
      }
    }
    for (const pipe of parseShell(command, "powershell").pipelines) {
      for (const unit of pipe) {
        const verb = (unit[0] ?? "").toLowerCase();
        // `& $sb`, `$cmd args` (not `$x = ..`)
        const call = /^\$[^=]*$/.test(verb) && !(unit[1] ?? "").startsWith("=");
        if (PS_EVAL.has(verb) || /\.ps[md]?1$/i.test(verb) || call) all();
        if (PS_ITEM.has(verb)) {
          const args = unit.slice(1);
          if (args.some((a) => /^@[\w{(]/.test(a))) all();
          const target = psTarget(args);
          // a path built at run time may name an env: / variable: item; a file path below `$env:N` / `$HOME` / `~` stays a file path
          const fsPath = target !== undefined && /^(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|~)[\\/][^$()`+{}]*$/i.test(target);
          if (target === undefined || (/[$()`+{}]/.test(target) && !fsPath)) all();
        }
      }
    }
  }
  for (const m of command.matchAll(/(?:^|[^\w$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/g)) out.add(m[1]);
  // the same over the line with quotes and backslashes removed (`HO""ME=`, `H\OME=`, `"HO"ME=`, `$'HO''ME'=`, `read \S`)
  const norm = command.replace(/\$'/g, "'").replace(/[\\"']/g, "");
  for (const text of norm === command ? [command] : [command, norm]) {
    for (const m of text.matchAll(/(?:^|[^\w$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=/g)) out.add(m[1]);
    for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?:?[=?]/g)) out.add(m[1]);
    for (const m of text.matchAll(/(?:^|[\s;&|("'=`\\]|(?<!\$)\{)([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g)) out.add(m[1]);
  }
  // `{N}>f` / `{N}<f`: bash stores the fd in N; a non-literal one may be any name
  for (const m of command.matchAll(/(?<!\$)\{([^{}\s]*)\}\d*[<>]/g)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1])) out.add(m[1]);
    else all();
  }
  // arithmetic (`(( ++S ))`, `$(( N=1 ))`, `$[..]`, `let ..`): every name inside may be assigned; an expansion in it may name any
  const arith = /\(\(([\s\S]*?)\)\)|\$\[([^\]]*)\]|\blet\s+([^;&|\n]*)/g;
  const bodies: string[] = [];
  for (const m of command.matchAll(arith)) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    bodies.push(body);
    for (const t of body.matchAll(/(?<![\w$])([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(t[1]);
  }
  // array subscripts (`${a[S++]}`, `a[i]=`) and `[[ x -eq y ]]` operands are arithmetic too
  for (const m of command.matchAll(/[A-Za-z0-9_]\[([^\]]*)\]/g)) bodies.push(m[1]);
  for (const m of command.matchAll(/\[\[([^\]]*)\]\]/g)) if (/\s-(?:eq|ne|lt|le|gt|ge)\s/.test(m[1])) bodies.push(m[1]);
  // `${a:off}` / `${a:off:len}` (not `${a:-x}` / `${a:=x}` / `${a:+x}` / `${a:?x}`; `${a: -1}` is one) evaluate off and len as arithmetic,
  // and so does every `x=RHS` / `x+=RHS` once x has the integer attribute: only a plain numeric expression stays benign there
  if (shell === "posix") {
    const strict: string[] = [];
    for (const m of command.matchAll(/\$\{!?(?:[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|[@*]|\d+):(?![-=+?])([^}]*)/g)) strict.push(m[1]);
    for (const text of norm === command ? [command] : [command, norm]) strict.push(...intBodies(text, all));
    for (const body of strict) if (!/^[\s\d+\-*/%():]*$/.test(body.replace(/["']/g, ""))) all();
  }
  // a name the line sets from a non-literal (`x=$'\x53=1'`, `read x`, `for x in`) may hold an assignment the arithmetic evaluates
  const nonLit = new Set<string>();
  for (const m of command.matchAll(/(?:^|[^\w$-])([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=([^\s;&|)]*)/g)) if (!/^[\w./:,@%+-]*$/.test(m[2])) nonLit.add(m[1]);
  const outside = command.replace(arith, " ").replace(/\[\[[^\]]*\]\]|\[[^\]]*\]/g, " ").replace(/(?<![\w$-])[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=[\w./:,@%+-]*(?=$|[\s;&|)])/g, " ");
  for (const body of bodies) {
    if (/(?:^|[^=!<>])=(?!=)|\+\+|--/.test(body)) all();
    // an expansion's text is evaluated as arithmetic too (`y='S=1'; (( $y ))`): `$y` / `${y}` count like `y`, and a positional,
    // `$@` / `$*`, an indirect `${!y}` or a substitution may hold any assignment
    if (/\$(?:\d|[@*(]|\{[\d@*!])|`/.test(body)) all();
    for (const t of body.matchAll(/(?<![\w$])(?:\$\{?)?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (nonLit.has(t[1]) || new RegExp(`(?:^|[^\\w$-])${t[1]}(?![A-Za-z0-9_])`).test(outside)) all();
    }
  }
  // `${x@P}` (prompt expansion runs substitutions), `${!x:=..}` / `${!x=..}` (assigns the name x holds)
  if (/\$\{[^{}]*@P\}|\$\{![A-Za-z0-9_]+(?:\[[^\]]*\])?:?=/.test(command)) all();
  // `eval` / `source` / `.` run text this check never sees: every trusted name may be rebound
  if (/(?:^|[\s;&|("'`])(?:eval|source)(?=$|[\s;&|)"'`])/.test(command) || /(?:^|[;&|(`{}!\n'"]|\b(?:then|do|else|command|builtin|exec|env|xargs|sudo|nohup|time)\s)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\.(?=$|\s)/.test(command)) all();
  // arithmetic was handled above: `x=$(( $a + 1 ))` holds no command word
  if (shell === "posix") boundWords(command.replace(/\$?\(\(([\s\S]*?)\)\)/g, "0"), out, all);
  // a shell started with BASH_ENV / ENV sources that file first
  if (out.has("BASH_ENV") || /(?<![\w$])ENV(?:\[[^\]]*\])?\+?=/.test(norm)) all();
  // PowerShell names are case-insensitive
  if (shell === "powershell") for (const n of [...out]) out.add(n.toUpperCase());
  return out;
}

/**
 * The item a PowerShell item cmdlet names: the value of `-Path` / `-LiteralPath` / `-Name` / `-PSPath`, in the space form or the
 * colon form (`-Path:env:HOME`, `-Path: $p`), else the first non-option word; undefined when there is none.
 */
function psTarget(args: string[]): string | undefined {
  const pi = args.findIndex((a) => /^-(?:path|literalpath|name|pspath)(?::|$)/i.test(a));
  if (pi < 0) return args.find((a) => !a.startsWith("-"));
  const rest = args[pi].replace(/^-[A-Za-z]+:?/, "");
  return rest !== "" ? rest : args[pi + 1];
}

/** PowerShell command words that run code this check never sees. */
const PS_EVAL = new Set(["iex", "invoke-expression", ".", "&", "import-module", "ipmo", "invoke-command", "icm", "start-job", "sajb", "invoke-item", "ii", "powershell", "pwsh", "powershell.exe", "pwsh.exe"]);
/** PowerShell item cmdlets whose path may be an env: / variable: drive item. */
const PS_ITEM = new Set(["set-item", "si", "new-item", "ni", "rename-item", "rni", "copy-item", "cpi", "copy", "cp", "move-item", "mi", "move", "mv", "clear-item", "cli", "remove-item", "ri", "del", "rm", "erase", "set-variable", "sv", "set", "new-variable", "nv", "clear-variable", "clv", "remove-variable", "rv", "set-content", "sc", "add-content", "ac", "set-itemproperty", "sp", "new-itemproperty"]);
/** Bash keywords before a command word. */
const SH_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "}", "time", "coproc", "fi", "done", "esac", "in"]);
/** Bash builtins whose operands (or some of them) are variable names; with the options that take a non-name value. */
const SH_BINDERS: Record<string, string> = { declare: "", typeset: "", local: "", export: "", readonly: "", unset: "", read: "pdtunNi", readarray: "dnOsuCc", mapfile: "dnOsuCc", getopts: "" };
/** Wrappers that run the next word as the command. */
const SH_WRAPS = new Set(["command", "builtin", "exec", "env", "nohup", "time", "sudo", "doas", "nice", "xargs", "setsid", "stdbuf", "timeout"]);

/**
 * boundNames over the parsed words (quotes and backslashes removed): the command word after keywords, leading redirects, assignments
 * and wrappers; `.` / `source` / `eval` or a command word that is an expansion binds every trusted name (`all`), and so does an
 * expansion, brace or substitution in a name position of declare/export/local/readonly/typeset/read/readarray/mapfile/unset/getopts/
 * printf -v/env. Attached option values (`printf -vS`, `read -aHOME`) count as names.
 */
function boundWords(command: string, out: Set<string>, all: () => void): void {
  const nameAt = (w: string): void => {
    const head = w.split("=")[0];
    if (/[$`{}()]/.test(head)) return all();
    const n = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(head.replace(/^\+/, ""));
    if (n) out.add(n[1]);
  };
  const attached = (w: string): void => {
    // `-vS`, `-aHOME`: any tail of an option group may be the value of an option taking a name
    for (let k = 2; k < w.length; k++) nameAt(w.slice(k));
  };
  for (const pipe of parseShell(command, "posix").pipelines) {
    for (const unit of pipe) {
      const redir = REDIRECTS.get(unit) ?? new Set<number>();
      let i = 0;
      const skip = (): void => {
        while (i < unit.length && (redir.has(i) || SH_KEYWORDS.has(unit[i]) || /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/.test(unit[i]))) {
          if (!redir.has(i)) nameAt(unit[i]);
          i++;
        }
      };
      skip();
      while (i < unit.length && SH_WRAPS.has(unit[i])) {
        const env = unit[i] === "env";
        i++;
        while (i < unit.length && (unit[i].startsWith("-") || redir.has(i))) {
          if (env && /^-(?:u|-unset)$/.test(unit[i]) && i + 1 < unit.length) nameAt(unit[++i]);
          else if (env && /^-u./.test(unit[i])) nameAt(unit[i].slice(2));
          i++;
        }
        if (env) while (i < unit.length && unit[i].includes("=") && !unit[i].startsWith("-")) nameAt(unit[i++]);
        skip();
      }
      const verb = unit[i];
      if (verb === undefined) continue;
      if (verb === "." || verb === "source" || verb === "eval" || /^[$`]/.test(verb)) {
        all();
        continue;
      }
      // a nested shell's body (`bash -c '..'`) binds what it binds
      const inner = innerScript(unit.slice(i));
      if (inner) for (const n of boundNames(inner.script, inner.shell)) out.add(n);
      const args = unit.slice(i + 1).filter((_, k) => !redir.has(i + 1 + k));
      // `trap 'cmd' SIG` runs text this check never sees; `trap - SIG` / `trap '' SIG` / `trap -p` do not
      if (verb === "trap") {
        const ops = args.filter((a) => !/^-[lp]$/.test(a) && a !== "--");
        if (ops.length > 0 && ops[0] !== "-" && ops[0] !== "") all();
        continue;
      }
      // `mapfile -C callback` / `readarray -C callback` evaluates the callback
      if ((verb === "mapfile" || verb === "readarray") && args.some((a) => /^-[A-Za-z]*C/.test(a))) all();
      // `declare -n r=VALUE`: VALUE is the name r refers to; an expansion there may name any
      const nameref = (verb === "declare" || verb === "typeset" || verb === "local") && args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a));
      if (verb === "printf") {
        for (let k = 0; k < args.length && args[k].startsWith("-"); k++) {
          if (args[k] === "--") break;
          if (args[k] === "-v") nameAt(args[++k] ?? "");
          else if (args[k].startsWith("-v")) nameAt(args[k].slice(2));
        }
        continue;
      }
      const valueOpts = SH_BINDERS[verb];
      if (valueOpts === undefined || !Object.hasOwn(SH_BINDERS, verb)) continue;
      let ops = 0;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^[-+][A-Za-z]/.test(a)) {
          attached(a);
          const last = a[a.length - 1];
          if (a.length === 2 && valueOpts.includes(last)) k++;
          continue;
        }
        // getopts: only the second operand is a name
        if (verb === "getopts" && ops++ !== 1) continue;
        nameAt(a);
        // `r=$x; declare -n r`, `for r in $x; do declare -n r`: without a value here, r refers to whatever name it already holds
        if (nameref && !a.includes("=")) all();
        if (nameref && a.includes("=")) {
          const value = a.slice(a.indexOf("=") + 1);
          if (/[$`{}()\\]/.test(value)) all();
          else nameAt(value);
        }
      }
    }
  }
}

/**
 * The right-hand sides of every `x=RHS` / `x+=RHS` / `x[..]=RHS` whose name some `declare` / `typeset` / `local` with an `i` option
 * (`-i`, `-ix`, `-ai`) gives the integer attribute: bash evaluates them as arithmetic. Any other bare mention of such a name outside
 * those statements (`read x`, `for x in`, `printf -v x`) may assign it a text bash evaluates too, so it binds every trusted name (`all`).
 */
function intBodies(text: string, all: () => void): string[] {
  const stmt = /(?:^|[\s;&|({}!`])(?:declare|typeset|local)(?=\s)([^;&|\n)]*)/g;
  const names = new Set<string>();
  for (const m of text.matchAll(stmt)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    if (!words.some((w) => /^-[A-Za-z]*i[A-Za-z]*$/.test(w))) continue;
    for (const w of words) {
      const n = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(?:\+?=|$)/.exec(w);
      if (n && !w.startsWith("-") && !w.startsWith("+")) names.add(n[1]);
    }
  }
  const out: string[] = [];
  for (const n of names) {
    const assign = new RegExp(`(?<![\\w$-])${n}(?:\\[[^\\]]*\\])?\\+?=([^\\s;&|)]*)`, "g");
    for (const m of text.matchAll(assign)) out.push(m[1]);
    const rest = text.replace(stmt, " ").replace(assign, " ");
    if (new RegExp(`(?<![\\w$])(?<!\\$\\{)${n}(?![A-Za-z0-9_])`).test(rest)) all();
  }
  return out;
}

/** Whether `word` holds a `$N` / `${N}` reference to a name in `names`. */
function refsBound(word: string, names: ReadonlySet<string>): boolean {
  for (const m of word.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) if (names.has((m[1] ?? m[2])!)) return true;
  return false;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export function readBaseline(pkgRoot: string): Baseline | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pkgRoot, "config", "permissions.baseline.json"), "utf8")) as Json;
    const bash = obj(raw.bash);
    const paths = obj(raw.paths);
    const pr = obj(raw.protect);
    return {
      bash: { deny: strs(bash.deny), ask: strs(bash.ask), allow: strs(bash.allow) },
      paths: { deny: strs(paths.deny), except: strs(paths.except) },
      protect: { deny: strs(pr.deny), ask: strs(pr.ask), childDeny: strs(pr.childDeny), writeAsk: strs(pr.writeAsk), writeAskSelfHost: strs(pr.writeAskSelfHost), removeAsk: strs(pr.removeAsk) },
    };
  } catch {
    return null;
  }
}

/** Foreman-owned paths a child never touches, on path tools and shell operands (the child's own scratch dir stays its own). */
const CHILD_BLOCK = ["{agentDir}/pi-foreman/handoffs", "{agentDir}/pi-foreman/handoffs/*", "{agentDir}/sessions/*/subagent-artifacts", "{agentDir}/sessions/*/subagent-artifacts/*", "{agentDir}/foreman.json", "{agentDir}/pi-foreman/claude-config", "{agentDir}/pi-foreman/claude-config/*"];

/** Round worktrees (`../<repo>.worktrees/*`): a child's own workspace root subtree stays open, siblings are the foreman's. */
const CHILD_BLOCK_WORKTREES = ["*.worktrees/*"];

/** Files of a handoff dir a child still writes and reads (the plan it was given, the report it hands back); everything else there stays the foreman's. */
const CHILD_BLOCK_EXCEPT = ["plan.md", "result.md"].map((f) => `{agentDir}/pi-foreman/handoffs/*/${f}`);

function without(list: string[], base: string[]): string[] {
  return list.filter((x) => !base.includes(x));
}

/** True when the session cwd is the package root or inside it (a dev checkout). Paths are resolved through symlinks; case-insensitive on win32/darwin. */
export function isSelfHost(cwd: string, pkgRoot: string, platform: string = process.platform): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const fold = platform === "win32" || platform === "darwin";
  const norm = (p: string): string => (fold ? p.toLowerCase() : p);
  const rel = (platform === "win32" ? path.win32 : path.posix).relative(norm(real(pkgRoot)), norm(real(cwd)));
  return rel === "" || (!rel.startsWith("..") && !(platform === "win32" ? path.win32 : path.posix).isAbsolute(rel));
}

/**
 * Rules from the baseline plus the merged `safety.permissions`. `base` is the same block before
 * the project and session layers (the config CLI's `basePermissions`); asks present there are
 * PS's job, only the added ones are enforced here. Without `base` no ask is enforced.
 */
export function buildOverlayRules(baseline: Baseline, merged: unknown, base: unknown, agentDir: string, pkgRoot?: string, xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME, selfHost = false, owned?: OwnedRoots): OverlayRules {
  const m = obj(merged);
  const b = obj(base);
  const slash = (d: string): string => d.split(path.sep).join("/").replace(/\/+$/, "");
  // {agentDirParent}: the agent dir's parent (`~/.pi` by default), derived, never hard-coded.
  const parent = slash(agentDir).replace(/[\\/][^\\/]*$/, "") || "/";
  const sub = (p: string): string => p.replace(/\{agentDirParent\}/g, parent).replace(/\{agentDir\}/g, slash(agentDir));
  const xdg = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : undefined;
  const prot = (list: string[] | undefined, main: ProtectRule["main"], shell: boolean, extra: Partial<ProtectRule> = {}): ProtectRule[] =>
    (list ?? [])
      .filter((p) => (pkgRoot !== undefined || !p.includes("{pkgRoot}")) && (xdg !== undefined || !p.includes("{xdgConfigHome}")))
      .map((p) => ({
        pattern: sub(p).replace(/\{pkgRoot\}/g, slash(pkgRoot ?? "")).replace(/\{xdgConfigHome\}/g, slash(xdg ?? "")),
        main,
        child: "deny",
        shell,
        childShell: true,
        ...extra,
      }));
  const pb = baseline.protect;
  const mp = obj(m.paths);
  const bp = obj(b.paths);
  const hasBase = Object.keys(b).length > 0;
  return {
    bashDeny: [...baseline.bash.deny, ...strs(m.deny)],
    bashAsk: hasBase ? without(strs(m.ask), strs(b.ask)) : [],
    pathRules: [
      ...baseline.paths.deny.map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
      ...baseline.paths.except.map((pattern): PathRule => ({ pattern: sub(pattern), action: "allow" })),
      ...strs(mp.deny).map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
    ],
    pathAsk: hasBase ? without(strs(mp.ask), strs(bp.ask)) : [],
    protect: [...prot(pb?.deny, "deny", true), ...prot(pb?.ask, "ask", true, { readOk: "main" }), ...prot(pb?.childDeny, null, true), ...prot(selfHost ? [...(pb?.writeAsk ?? []).filter((p) => p !== "{pkgRoot}" && p !== "{pkgRoot}/*"), ...(pb?.writeAskSelfHost ?? [])] : pb?.writeAsk, "ask", false, { readOk: "child", fromWriteAsk: true }), ...prot(pb?.removeAsk, "ask", true).map((r) => ({ ...r, removeOnly: true }))],
    childBlock: [...CHILD_BLOCK.map(sub), ...CHILD_BLOCK_WORKTREES, ...(owned?.childScratchRoot ? [slash(owned.childScratchRoot), `${slash(owned.childScratchRoot)}/*`] : [])],
    childBlockExcept: CHILD_BLOCK_EXCEPT.map(sub),
    childBlockInWorkspace: CHILD_BLOCK_WORKTREES,
    ...(owned ? { owned } : {}),
  };
}

// ------------------------------------------------------------------ wildcard

const reCache = new Map<string, RegExp>();

function expandHomePattern(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + p.slice(1);
  if (p.startsWith("$HOME")) return home + p.slice(5);
  if (p.startsWith("${HOME}")) return home + p.slice(7);
  return p;
}

/** PS's compileWildcardPattern: split on `*`, `?` = one char, trailing " *" makes the args optional. */
export function wildcardRegExp(pattern: string, opts: { home: string; ignoreCase: boolean; foldSeparators: boolean }): RegExp {
  const key = `${opts.ignoreCase ? "i" : "s"}${opts.foldSeparators ? "f" : "-"}${opts.home}\u0000${pattern}`;
  const hit = reCache.get(key);
  if (hit) return hit;
  let expanded = expandHomePattern(pattern, opts.home);
  if (opts.foldSeparators) expanded = expanded.replace(/\\/g, "/");
  let escaped = expanded
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\?/g, ".").replace(/\//g, () => "[\\\\/]"))
    .join(".*");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  const re = new RegExp(`^${escaped}$`, opts.ignoreCase ? "si" : "s");
  reCache.set(key, re);
  return re;
}

function bashMatches(pattern: string, text: string, ctx: MatchCtx): boolean {
  return wildcardRegExp(pattern, { home: ctx.home, ignoreCase: ctx.shell === "powershell", foldSeparators: false }).test(text);
}

/** Case-insensitive file systems by default: path rules fold case there. */
export const foldsCase = (platform: string): boolean => platform === "win32" || platform === "darwin";

/** Win32 path normalisation (M1): every segment loses trailing dots and spaces (`.git.\config` is `.git\config`). */
export function winSegments(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((seg) => (/^\.+$/.test(seg) ? seg : seg.replace(/[. ]+$/, "")))
    .join("/");
}

function pathMatches(pattern: string, value: string, ctx: MatchCtx): boolean {
  const win = ctx.platform === "win32";
  const pat = pattern.includes("{cwd}") ? pattern.replace(/\{cwd\}/g, ctx.cwd.split(/[\\/]/).join("/").replace(/\/+$/, "")) : pattern;
  return wildcardRegExp(pat, { home: ctx.home, ignoreCase: foldsCase(ctx.platform), foldSeparators: win }).test(win ? winSegments(value) : value);
}

const SHORT_NAME = /^[^~\\/]{1,6}~[0-9]+(\.[^\\/]{0,3})?$/i;

/**
 * Could the 8.3 short name `short` stand for `long`? Windows builds it from the long name with
 * dots and spaces removed, upper case, `+,;=[]` as `_`: the first six characters (`~1`..`~4`) or
 * two characters plus a 4-hex hash (`~5` on). The extension is not compared (more matches, never fewer).
 */
export function shortNameFits(short: string, long: string): boolean {
  const base = short.slice(0, short.indexOf("~")).toUpperCase();
  const norm = (s: string): string => s.toUpperCase().replace(/[. ]/g, "").replace(/[+,;=[\]]/g, "_");
  const lastDot = long.lastIndexOf(".");
  const forms = [norm(long), ...(lastDot > 0 ? [norm(long.slice(0, lastDot))] : [])];
  return forms.some((f) => f.length > 0 && (f.slice(0, 6) === base || (/^..[0-9A-F]{4}$/.test(base) && f.slice(0, 2) === base.slice(0, 2))));
}

/**
 * Win32 8.3 spellings (M1): each candidate with every short-name segment (`CLAUDE~1`) replaced by
 * the literal segments of the (protect or deny) patterns it could abbreviate. Only those
 * spellings that then match a pattern decide, so a `PROGRA~1` in an unrelated path changes nothing:
 * the short name must sit exactly where a protected name sits and fit that name.
 */
function shortNameVariants(cands: string[], patterns: string[]): string[] {
  const names = [...new Set(patterns.flatMap((p) => p.split(/[\\/]/)).filter((s) => s && !/[*?]/.test(s)))];
  const out: string[] = [];
  for (const cand of cands) {
    const segs = winSegments(cand).split("/");
    if (!segs.some((s) => SHORT_NAME.test(s))) continue;
    let variants: string[][] = [[]];
    for (const seg of segs) {
      const alts = SHORT_NAME.test(seg) ? [seg, ...names.filter((n) => shortNameFits(seg, n))] : [seg];
      variants = variants.flatMap((v) => alts.map((a) => [...v, a])).slice(0, 64);
    }
    for (const v of variants) {
      const joined = v.join("/");
      if (joined !== segs.join("/")) out.push(joined);
    }
  }
  return out;
}

// --------------------------------------------------------------------- lexer

interface Parsed {
  pipelines: string[][][];
  /** The operator that ended each pipeline: `&&`, `||`, `&`, `;` (also newline), `(`/`)`, `` ` ``, `{`/`}`, or `end`. */
  seps: string[];
  subs: string[];
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return src.length;
      i = j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return src.length;
}

/** Inner text of `$( )` and backtick substitutions, also inside double quotes (never inside single quotes). */
function substitutions(src: string, shell: "posix" | "powershell"): string[] {
  const out: string[] = [];
  let inDq = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && shell === "posix") i++;
    else if (c === "`" && shell === "powershell") i++;
    else if (c === '"') inDq = !inDq;
    else if (c === "'" && !inDq) {
      const j = src.indexOf("'", i + 1);
      if (j < 0) break;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      const end = matchParen(src, i + 1);
      out.push(src.slice(i + 2, end));
    } else if (c === "`" && shell === "posix") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      out.push(src.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

const ANSI: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/** Body of `$'...'` from `start` (after the quote) -> [decoded text, index of the closing quote]. Port of git_guard.py's decoder. */
function ansiC(src: string, start: number): [string, number] {
  let out = "";
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === "'") return [out, j];
    if (c === "\\" && j + 1 < src.length) {
      const e = src[j + 1];
      let m: RegExpExecArray | null;
      if (e in ANSI) {
        out += ANSI[e];
        j += 2;
      } else if ((e === "x" || e === "u" || e === "U") && (m = new RegExp(`^[0-9A-Fa-f]{1,${e === "x" ? 2 : e === "u" ? 4 : 8}}`).exec(src.slice(j + 2)))) {
        const cp = parseInt(m[0], 16);
        out += cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
        j += 2 + m[0].length;
      } else if ((m = /^[0-7]{1,3}/.exec(src.slice(j + 1)))) {
        out += String.fromCharCode(parseInt(m[0], 8) & 0xff);
        j += 1 + m[0].length;
      } else if (e === "c" && j + 2 < src.length) {
        out += String.fromCharCode(src.charCodeAt(j + 2) & 0x1f);
        j += 3;
      } else {
        out += "\\" + e;
        j += 2;
      }
      continue;
    }
    out += c;
    j++;
  }
  return [out, src.length];
}

/** Bash brace expansion of one word (`a{b,c}d`, `{1..3}`, nested), at most `budget` results; [] when it has none. */
export function expandBraces(w: string, budget = 64): string[] {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== "{" || w[i - 1] === "$") continue;
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < w.length; j++) {
      if (w[j] === "{") depth++;
      else if (w[j] === "}" && --depth === 0) break;
      else if (w[j] === "," && depth === 1) commas.push(j);
    }
    if (j >= w.length) return [];
    const body = w.slice(i + 1, j);
    let alts: string[] | null = null;
    if (commas.length) alts = [i, ...commas].map((k, n) => w.slice(k + 1, n < commas.length ? commas[n] : j));
    else {
      const r = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(body);
      if (r) {
        const num = /\d/.test(r[1]);
        const a = num ? parseInt(r[1], 10) : r[1].charCodeAt(0);
        const b = num ? parseInt(r[2], 10) : r[2].charCodeAt(0);
        alts = [];
        for (let k = a; alts.length < budget && (a <= b ? k <= b : k >= b); k += a <= b ? 1 : -1) alts.push(num ? String(k) : String.fromCharCode(k));
      }
    }
    if (!alts) continue;
    const out: string[] = [];
    for (const alt of alts) {
      const next = w.slice(0, i) + alt + w.slice(j + 1);
      const more = expandBraces(next, budget - out.length);
      for (const x of more.length ? more : [next]) {
        out.push(x);
        if (out.length >= budget) return out;
      }
    }
    return out;
  }
  return [];
}

const INTERPRETERS: { re: RegExp; flag: RegExp }[] = [
  { re: /^python[0-9.]*$|^pypy[0-9.]*$/, flag: /^-[A-Za-z]*c$/ },
  { re: /^(node|nodejs|bun|deno)$/, flag: /^(-[A-Za-z]*[ep]|--eval|--print)$/ },
  { re: /^perl[0-9.]*$/, flag: /^-[A-Za-z]*[eE]$/ },
  { re: /^ruby[0-9.]*$/, flag: /^-[A-Za-z]*e$/ },
];

/** The inline code of `python -c CODE`, `node -e CODE`, `perl -e CODE`, `ruby -e CODE`, or null. */
function inlineCode(core: string[]): string | null {
  if (!core.length) return null;
  const it = INTERPRETERS.find((x) => x.re.test(baseName(core[0])));
  if (!it) return null;
  const py = /^(python|pypy)/.test(baseName(core[0]));
  for (let k = 1; k < core.length; k++) {
    // python option parsing ends at `-m` and at the script name: a later `-c` is the script's argument
    if (py && (/^-[A-Za-z]*m$/.test(core[k]) || !core[k].startsWith("-"))) return null;
    if (py && /^-[WX]$/.test(core[k]) && !it.flag.test(core[k])) {
      k++;
      continue;
    }
    const eq = /^--(eval|print)=(.*)$/s.exec(core[k]);
    if (eq && it.flag.test(`--${eq[1]}`)) return eq[2];
    if (it.flag.test(core[k])) return core[k + 1] ?? null;
  }
  return null;
}

const PY_IDENTS = new Set(["import", "json", "print", "list", "len", "sorted", "open", "dict", "str", "int", "for", "in", "if", "else", "and", "or", "not", "None", "True", "False"]);
const PY_CALLABLES = new Set(["print", "list", "len", "sorted", "open", "dict", "str", "int"]);
const PY_ATTRS = new Set(["load", "loads", "keys", "values", "items", "get", "read"]);

/**
 * Inline python that can only read files: it imports nothing but pure-data modules, every `open` is a call with a literal path and
 * no mode or a read mode, and nothing can reach another way to write (`__`, getattr, eval, exec, compile, input, breakpoint).
 * Anything else (a computed path, `os`, `pathlib`, `subprocess`) is not provably a read and stays scanned as a possible write.
 */
export function pythonReadOnlyCode(code: string): boolean {
  // strict allowlist, fail closed: pure ASCII, no backslash, no assignment or keyword argument, no def/with/lambda/class, no f-/b-/r-strings
  if (!/^[\t\n\x20-\x7e]*$/.test(code) || code.includes("\\")) return false;
  type Tok = { k: "str" | "id" | "num" | "p"; v: string };
  const toks: Tok[] = [];
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (c === "'" || c === '"') {
      const j = code.indexOf(c, i + 1);
      if (j < 0) return false;
      // a prefix letter (f, b, r, u ...) glued to the quote, or a second literal right after this one (implicit concatenation)
      if (toks.length && toks[toks.length - 1].k === "id" && !/\s/.test(code[i - 1] ?? " ") && !PY_IDENTS.has(toks[toks.length - 1].v)) return false;
      if (toks.length && toks[toks.length - 1].k === "str") return false;
      toks.push({ k: "str", v: code.slice(i + 1, j) });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z0-9_]+/.exec(code.slice(i))![0];
      toks.push({ k: "id", v: m });
      i += m.length;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+/.exec(code.slice(i))![0];
      if (/[A-Za-z_.]/.test(code[i + m.length] ?? "")) return false;
      toks.push({ k: "num", v: m });
      i += m.length;
    } else if ("()[],;.:".includes(c)) {
      toks.push({ k: "p", v: c });
      i++;
    } else {
      return false;
    }
  }
  for (let n = 0; n < toks.length; n++) {
    const t = toks[n];
    const prev = toks[n - 1];
    const next = toks[n + 1];
    if (t.k === "id") {
      if (prev?.k === "p" && prev.v === ".") {
        if (!PY_ATTRS.has(t.v)) return false;
        continue;
      }
      if (t.v === "import") {
        if (!(n === 0 || (prev.k === "p" && prev.v === ";")) || next?.k !== "id" || next.v !== "json") return false;
        const after = toks[n + 2];
        if (after && !(after.k === "p" && after.v === ";")) return false;
        continue;
      }
      if (!PY_IDENTS.has(t.v) && !/^[a-z]$/.test(t.v)) return false;
      if (t.v === "json" && !(prev?.k === "id" && prev.v === "import") && !(next?.k === "p" && next.v === ".")) return false;
      if (next?.k === "p" && next.v === "(" && !PY_CALLABLES.has(t.v)) return false;
      if (t.v === "open") {
        // exactly `open('<literal>')` or `open('<literal>', 'r')`
        if (next?.v !== "(" || toks[n + 2]?.k !== "str") return false;
        const a = toks[n + 3];
        if (a?.v === ")" && a.k === "p") continue;
        if (!(a?.k === "p" && a.v === "," && toks[n + 4]?.k === "str" && toks[n + 4].v === "r" && toks[n + 5]?.k === "p" && toks[n + 5].v === ")")) return false;
      }
    } else if (t.k === "p" && t.v === "(") {
      // a call needs a callable name or an attribute before it; a bare `(` is a group
      if (prev?.k === "p" && (prev.v === ")" || prev.v === "]")) return false;
      if (prev?.k === "str" || prev?.k === "num") return false;
    } else if (t.k === "p" && t.v === "[") {
      // a subscript only, holding one string or int literal
      if (!(prev?.k === "id" || (prev?.k === "p" && (prev.v === ")" || prev.v === "]")))) return false;
      if (prev.k === "id" && PY_IDENTS.has(prev.v) && prev.v !== "None") return false;
      if ((next?.k !== "str" && next?.k !== "num") || toks[n + 2]?.v !== "]" || toks[n + 2].k !== "p") return false;
    } else if (t.k === "p" && t.v === ".") {
      if (next?.k !== "id" || !(prev?.k === "id" || (prev?.k === "p" && (prev.v === ")" || prev.v === "]")))) return false;
    }
  }
  return toks.length > 0;
}

/** String literals of inline code, plus runs of literals joined by `+`, `.` or nothing (`"."+"env"` -> `.env`). */
export function codeLiterals(code: string): string[] {
  const lits: { text: string; start: number; end: number }[] = [];
  const rawLits: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const q = code[i];
    if (q !== "'" && q !== '"' && q !== "`") continue;
    let text = "";
    let j = i + 1;
    for (; j < code.length && code[j] !== q; j++) {
      if (code[j] === "\\" && j + 1 < code.length) j++;
      text += code[j];
    }
    lits.push({ text, start: i, end: j });
    // as written too: a raw string (`r'C:\x'`) or an unknown escape keeps its backslashes (Windows paths)
    const raw = code.slice(i + 1, j);
    if (raw !== text) rawLits.push(raw);
    i = j;
  }
  const out = [...lits.map((l) => l.text), ...rawLits];
  for (let a = 0; a < lits.length; a++) {
    let joined = lits[a].text;
    for (let b = a + 1; b < lits.length && /^\s*[+.]?\s*$/.test(code.slice(lits[b - 1].end + 1, lits[b].start)); b++) {
      joined += lits[b].text;
      out.push(joined);
    }
  }
  return out.filter(Boolean);
}

/** Word indices of a parsed unit that are redirect targets (`> f`, `2>> f`, `< f`). */
const REDIRECTS = new WeakMap<string[], Set<number>>();
/** The subset of REDIRECTS written to (`>`, `>>`, `&>`, `>|`, `>&`), not read from. */
const WRITE_REDIRECTS = new WeakMap<string[], Set<number>>();

/** pipelines -> units -> words (quotes removed). */
export function parseShell(src: string, shell: "posix" | "powershell" = "posix"): Parsed {
  const pipelines: string[][][] = [];
  const seps: string[] = [];
  let units: string[][] = [];
  let words: string[] = [];
  let cur: string | null = null;
  let redir = new Set<number>();
  let wredir = new Set<number>();
  let redirNext = false;
  let writeNext = false;
  const flush = (): void => {
    if (cur !== null) {
      if (redirNext) {
        redir.add(words.length);
        if (writeNext) wredir.add(words.length);
      }
      redirNext = false;
      writeNext = false;
      words.push(cur);
    }
    cur = null;
  };
  const endUnit = (): void => {
    flush();
    if (words.length) {
      units.push(words);
      if (redir.size) REDIRECTS.set(words, redir);
      if (wredir.size) WRITE_REDIRECTS.set(words, wredir);
    }
    words = [];
    redir = new Set();
    wredir = new Set();
    redirNext = false;
    writeNext = false;
  };
  const endPipe = (sep: string): void => {
    endUnit();
    if (units.length) {
      pipelines.push(units);
      seps.push(sep);
    }
    units = [];
  };
  const add = (s: string): void => {
    cur = (cur ?? "") + s;
  };
  const posix = shell === "posix";
  let pipeOpen = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== " " && c !== "\t" && c !== "\r" && c !== "\n" && c !== "|") pipeOpen = false;
    if (c === (posix ? "\\" : "`")) {
      if (src[i + 1] === "\n") i++;
      else if (i + 1 < src.length) add(src[++i]);
    } else if (!posix && c === "\\") add(c);
    else if (posix && c === "$" && src[i + 1] === "'") {
      const [text, end] = ansiC(src, i + 2);
      add(text);
      i = end;
    } else if (posix && c === "$" && src[i + 1] === '"') {
      // $"..." (locale translation): the double-quoted string follows
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      add(src.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === (posix ? "\\" : "`") && j + 1 < src.length && (posix ? '"\\$`\n'.includes(src[j + 1]) : true)) j++;
        s += src[j++];
      }
      add(s);
      i = j;
      cur = cur ?? "";
    } else if (c === " " || c === "\t" || c === "\r") flush();
    else if (c === "\n" && pipeOpen && cur === null && words.length === 0) continue; // `a |\nb`: one pipeline
    else if (c === "\n" || c === ";") endPipe(";");
    else if (c === "&" && src[i + 1] === ">" && posix) {
      // `&>file` / `&>>file`: both streams to a file
      flush();
      redirNext = true;
      writeNext = true;
      i++;
      while (src[i + 1] === ">") i++;
    } else if (c === "&") {
      const and = src[i + 1] === "&";
      if (and) i++;
      endPipe(and ? "&&" : "&");
    } else if (c === "|") {
      if (src[i + 1] === "|") {
        i++;
        endPipe("||");
      } else {
        if (src[i + 1] === "&") i++;
        endUnit();
        pipeOpen = true;
      }
    } else if (c === "(" || c === ")" || (posix && c === "`") || (!posix && (c === "{" || c === "}"))) endPipe(c);
    else if (c === "<" || c === ">") {
      if (cur !== null && /^\d+$/.test(cur)) cur = null; // 2>file: the fd number is not a word
      flush();
      redirNext = true;
      writeNext = c === ">";
      while (src[i + 1] === c) i++;
      // `>&2`, `<&-`, `<&3`: an fd dup or close, its operand is no word of the command and `&` is no background operator
      if ((c === ">" || (posix && c === "<")) && src[i + 1] === "&") i++;
      else if (c === ">" && posix && src[i + 1] === "|") i++;
    } else if (c === "#" && cur === null && (i === 0 || /\s|[;&|()]/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== "\n") i++;
      i--;
    } else add(c);
  }
  endPipe("end");
  return { pipelines, seps, subs: substitutions(src, shell) };
}

// -------------------------------------------------------------- command units

const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "timeout", "stdbuf", "setsid", "xargs", "watch", "chroot"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);

/** Verbs whose operands (all, or the last one) are written; with the redirects they feed a child's /tmp deny. */
const TMP_WRITERS = new Map<string, "all" | "last">([["tee", "all"], ["touch", "all"], ["mkdir", "all"], ["mv", "all"], ["cp", "last"], ["install", "last"], ["ln", "last"]]);

/** A bare name that does not exist yet is not path-shaped to pathCandidates: `./` makes it a path against the cwd. */
function asPathWord(t: string): string {
  return /^[./~$\\]|^[A-Za-z]:/.test(t) ? t : `./${t}`;
}

/** Verbs that write, move or delete their path operands; which operands count: all, the last one, or all but the leading mode/owner word. */
const RO_WRITERS = new Map<string, "all" | "last" | "mode">([
  ["rm", "all"], ["rmdir", "all"], ["unlink", "all"], ["shred", "all"], ["truncate", "all"], ["touch", "all"], ["mkdir", "all"], ["mv", "all"], ["tee", "all"], ["patch", "all"],
  ["trash", "all"], ["trash-put", "all"], ["srm", "all"], ["del", "all"], ["erase", "all"], ["rd", "all"], ["remove-item", "all"], ["ri", "all"], ["rename", "all"], ["ren", "all"], ["move", "all"], ["rni", "all"], ["rename-item", "all"], ["move-item", "all"], ["mi", "all"],
  ["cp", "last"], ["install", "last"], ["ln", "last"], ["rsync", "last"],
  ["chmod", "mode"], ["chown", "mode"], ["chgrp", "mode"],
]);

/** Read-only verbs (with unitReadOnly) and shell builtins that never write a path by themselves. */
const RO_READERS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "nawk", "find", "echo", "printf", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "ls", "cd", "pwd", "nl", "column", "diff", "true", "false", "stat", "file", "tree", "cmp", "md5sum", "sha1sum", "sha256sum", "shasum", "date", "which", "basename", "dirname", "realpath", "readlink", "jq", "od", "hexdump", "xxd", "test", "[", "[[", ":", "sleep", "uname", "whoami", "id", "export", "local", "declare", "typeset", "readonly", "read", "set", "unset", "shift", "return", "exit", "break", "continue", "wait", "type"]);

/** Read-only git subcommands, and the ones that touch only .git (branch/tag/remote list and edit refs, never the worktree). `config` is a read only in the forms of gitConfigRead. */
const GIT_RO_SUBS = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe", "grep", "shortlog", "cat-file", "rev-list", "for-each-ref", "show-ref", "name-rev", "merge-base", "diff-tree", "diff-files", "diff-index", "count-objects", "branch", "tag", "remote", "worktree", "fetch", "version", "help"]);

/** Options of a build/test run that name an output path, a cache, a log or a program. */
const BUILD_OUT_OPT = /^--?(o\b|[\w-]*(out|dir|file|log|xml|report|exec|command|cache|profile|prefix|script-shell)[\w-]*(=|$))/;

/**
 * A test/lint/typecheck run: npm test / npm run test|lint|typecheck|check[:x], node --test, cargo test|check|clippy, go test|vet,
 * pytest, python -m pytest|unittest, make test*. Such runs write only caches and build output (node_modules/.cache, dist,
 * coverage, scratch), not sources, and a reviewer must be able to run them; options that name an output path or program are refused.
 */
/**
 * `python3 [-I] scripts/x.py ...` / `node scripts/x.mjs ...`: a script file named by a relative path with no `..`, `~` or `$`
 * (so it lies under the cwd, in a read-only child the round worktree). It runs as a test run: caches and scratch writes are
 * allowed like for other test runs, but what the script itself writes is not classified. `-c`/`-e`/`-` and stdin forms are not scripts.
 */
function repoScriptWord(verb: string, args: string[]): string | null {
  if (verb !== "python" && verb !== "python3" && verb !== "node") return null;
  let i = 0;
  if (verb !== "node") while (i < args.length && /^-[IBEsSu]+$/.test(args[i])) i++;
  const s = args[i];
  if (s === undefined || s === "" || /^[-~$\\/]|^[A-Za-z]:|(^|\/)\.\.(\/|$)|[`$*?[\]{}]/.test(s)) return null;
  return (verb === "node" ? /\.(mjs|cjs|js)$/.test(s) : /\.py$/.test(s)) ? s : null;
}

const CONFIG_MODES = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);
const CONFIG_MODS = new Set(["--local", "--worktree", "--global", "--system", "--includes", "--no-includes", "-z", "--null", "--show-origin", "--show-scope", "--name-only", "--bool", "--int", "--bool-or-int", "--path", "--expiry-date"]);

/**
 * `git config` args (after the subcommand) that only read: `<key>`, `get <key> [<re>]`, `list`, `--get|--get-all|--get-regexp <key> [<re>]`,
 * `--get-urlmatch <name> <url>`, `--list`, with the modifiers above and `--default <v>` / `--type=<t>`. `--file`, `--blob`, `set`, `unset`,
 * `--add`, `--replace-all`, `--edit`, any other flag, or a second operand without a --get mode is a write.
 */
function gitConfigRead(rest: string[]): boolean {
  let mode: string | undefined;
  const ops: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--default") {
      if (++i >= rest.length) return false;
    } else if (a.startsWith("--type=") || CONFIG_MODS.has(a)) {
      continue;
    } else if (CONFIG_MODES.has(a)) {
      if (mode !== undefined) return false;
      mode = a === "-l" ? "--list" : a;
    } else if (a.startsWith("-")) {
      return false;
    } else ops.push(a);
  }
  if (mode === undefined && (ops[0] === "get" || ops[0] === "list")) mode = `--${ops.shift()}`;
  if (mode === "--list") return ops.length === 0;
  if (mode === "--get-urlmatch") return ops.length === 2;
  if (mode === undefined) return ops.length === 1;
  return ops.length >= 1 && ops.length <= 2;
}

/** Options of a test runner whose next word (or `=value`) is a program or path it loads, and ones whose value is no path. */
const RUN_PATH_OPTS = new Set(["--require", "--import", "--loader", "--experimental-loader", "--test-reporter", "--test-reporter-destination", "--test-global-setup", "--config", "--directory", "--include-dir", "--file", "--makefile", "--start-directory", "--top-level-directory", "--env-file"]);
/** The short path options of each runner (`-sv` of pytest is no `-s` path). */
const RUN_SHORT_PATH_OPTS: Record<string, string> = { node: "r", pytest: "c", unittest: "st", make: "CfIoW" };
/** The short options whose value is a selection expression, plugin name or number (never a path): the rest of the group, or the next word. */
const RUN_SHORT_VALUE_OPTS: Record<string, string> = { node: "", pytest: "kmpWnr", unittest: "kp", make: "jlO" };
/** The long options a `make test` run may carry; any other (so any abbreviation of `--directory`, `--file`, ...) is refused. */
const MAKE_LONG_OPTS = new Set(["--keep-going", "--no-keep-going", "--jobs", "--silent", "--quiet", "--always-make", "--no-print-directory", "--print-directory", "--dry-run", "--just-print", "--recon", "--ignore-errors", "--warn-undefined-variables"]);
/** A word that names a path by its shape: a `/`, a file suffix, `.` or `..`. Other words are paths only when they name an existing file or directory (the `\x02` marker). */
function pathShaped(w: string): boolean {
  return w.includes("/") || /\.[A-Za-z_]\w*$/.test(w) || w === "." || w === "..";
}
/** An operand word: path-shaped ones are checked as paths, others only when they exist (`\x02`). */
function operandWord(w: string): string {
  return pathShaped(w) ? w : `\x02${w}`;
}
/** Values of `--test-reporter` and `--test-reporter-destination` that name no file. */
const BUILTIN_REPORTERS = new Set(["spec", "tap", "dot", "junit", "lcov", "stdout", "stderr"]);
const RUN_VALUE_OPTS = new Set(["--test-name-pattern", "--test-skip-pattern", "--maxfail", "--tb", "--durations", "--timeout", "--test-concurrency", "--test-timeout", "--color"]);

/**
 * The path operands of a test run: `node --test <p>`, `npm run test:x -- <p>`, `pytest <p>`, `python -m pytest|unittest <p>`, `make test -C <p>`
 * (a dotted unittest module is `\0a.b`; `make` variable assignments count too, they can name a program). Flags are skipped, except the
 * values of the options that load code. A read-only child may run only git-tracked ones inside the round worktree.
 */
function runOperands(verb: string, args: string[]): string[] {
  let rest: string[];
  let kind: "node" | "pytest" | "unittest" | "make" = "node";
  if (verb === "npm") {
    // npm hands every positional (and what follows `--`) to the script
    const first = args.findIndex((a) => !a.startsWith("-"));
    const isRun = args[first] === "run" || args[first] === "run-script";
    const script = isRun ? args.findIndex((a, i) => i > first && !a.startsWith("-")) : first;
    rest = script < 0 ? [] : args.slice(script + 1);
  } else if (verb === "node") {
    if (args[0] !== "--test") return [];
    rest = args.slice(1);
  }
  else if (verb === "pytest") {
    rest = args;
    kind = "pytest";
  } else if (verb === "python" || verb === "python3") {
    if (args[0] !== "-m") return [];
    rest = args.slice(2);
    kind = args[1] === "unittest" ? "unittest" : "pytest";
  } else if (verb === "make") {
    rest = args;
    kind = "make";
  } else return [];
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (kind === "make") {
        // fail closed: only the listed make options pass, so no abbreviation of --directory/--file/--include-dir/--eval can
        if (!MAKE_LONG_OPTS.has(name) || (name === "--jobs" && eq > 0 && !/^\d*$/.test(a.slice(eq + 1)))) out.push(`\x01${a}`);
        continue;
      }
      const reporter = name === "--test-reporter";
      const takesValue = RUN_PATH_OPTS.has(name) || RUN_VALUE_OPTS.has(name);
      const value = eq > 0 ? a.slice(eq + 1) : takesValue && i + 1 < rest.length ? rest[++i] : undefined;
      if (value === undefined || RUN_VALUE_OPTS.has(name)) continue;
      if ((reporter || name === "--test-reporter-destination") && BUILTIN_REPORTERS.has(value)) continue;
      // a reporter may be an npm package (a bare name that is no file); other values are paths, or path-shaped / existing words
      out.push(RUN_PATH_OPTS.has(name) && !(reporter && !value.includes("/")) ? value : operandWord(value));
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // a short option group: the rest after the first value-taking character is its value (a path, or an exempt expression / plugin / number)
      let handled = false;
      for (let j = 1; j < a.length && !handled; j++) {
        const rem = a.slice(j + 1);
        if (RUN_SHORT_PATH_OPTS[kind].includes(a[j])) {
          const v = rem !== "" ? rem : rest[++i];
          if (v !== undefined) out.push(v);
          handled = true;
        } else if (RUN_SHORT_VALUE_OPTS[kind].includes(a[j])) {
          const v = rem !== "" ? rem : a[j] === "j" && /^\d+$/.test(rest[i + 1] ?? "") || a[j] !== "j" ? rest[++i] : undefined;
          if (v !== undefined && a[j] === "p" && kind === "pytest") out.push(operandWord(v));
          handled = true;
        }
      }
      // any other group with a path-shaped remainder (`-xy/z`) is a path operand
      if (!handled) for (let j = 1; j < a.length; j++) if (pathShaped(a.slice(j))) out.push(a.slice(j));
      continue;
    }
    if (kind === "make") {
      // a `K=V` value is exempt unless it has a `/` (it can name a program); a target is a path only when it exists
      const k = a.indexOf("=");
      out.push(k > 0 && a.slice(k + 1).includes("/") ? a.slice(k + 1) : `\x02${k > 0 ? a.slice(k + 1) : a}`);
    } else if (kind === "unittest") {
      if (a === "discover") continue;
      out.push(/^[A-Za-z_][\w.]*$/.test(a) && !a.endsWith(".py") && a.includes(".") ? `\0${a}` : operandWord(a));
    } else out.push(operandWord(kind === "pytest" ? a.replace(/::.*$/, "") : a));
  }
  return out;
}

function repoScriptRun(verb: string, args: string[]): boolean {
  return repoScriptWord(verb, args) !== null;
}

function buildTestRun(verb: string, args: string[]): boolean {
  if (repoScriptRun(verb, args)) return true;
  // `--test-reporter[-destination]` is checked as a module/path operand by runOperands, not refused here
  if (args.some((a) => BUILD_OUT_OPT.test(a) && !/^--(test-reporter(-destination)?(=|$)|(no-)?print-directory$)/.test(a))) return false;
  const [sub, next] = args;
  if (verb === "npm") return sub === "test" || ((sub === "run" || sub === "run-script") && /^(test|lint|typecheck|check)(:|$)/.test(next ?? ""));
  if (verb === "node") return sub === "--test";
  if (verb === "cargo") return sub === "test" || sub === "check" || sub === "clippy";
  if (verb === "go") return sub === "test" || sub === "vet";
  if (verb === "pytest") return true;
  if (verb === "python" || verb === "python3") return sub === "-m" && (next === "pytest" || next === "unittest");
  if (verb === "make") return !!sub && !sub.startsWith("-") && /^test/.test(sub);
  return false;
}

/**
 * What one command (wrappers stripped) may do to the worktree, for a child that may only read it: the path words it writes
 * (a relative one resolves against the cwd; `.` stands for the cwd itself), or `unknown` when it is neither a known reader,
 * a test run nor a known writer. `inner` = a shell whose -c script is collected separately.
 */
function roEffect(core: string[], skip: Set<number>, inner: boolean): { targets: string[]; unknown?: string; deny?: string; run?: boolean; script?: string; operands?: string[] } {
  if (!core.length) return { targets: [] };
  const verb = baseName(core[0]);
  const args = core.slice(1);
  const operands = core.filter((x, i) => i > 0 && x !== "" && !x.startsWith("-") && !skip.has(i));
  const optValues = args.filter((x) => /^--[\w-]+=./.test(x)).map((x) => x.slice(x.indexOf("=") + 1));
  const or = (t: string[]): { targets: string[] } => ({ targets: t.length ? t : ["."] });
  const kind = RO_WRITERS.get(verb);
  if (kind) {
    const intoDir = args.some((a) => /^-[A-Za-z]*t$|^--target-directory/.test(a));
    return or([...optValues, ...(kind === "all" || intoDir ? operands : kind === "last" ? operands.slice(-1) : operands.slice(1))]);
  }
  if (verb === "dd") return { targets: args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)) };
  if (verb === "find") {
    if (!args.some((a) => /^-(delete|fprint0?|fprintf|fls)$/.test(a))) return { targets: [] };
    const lead: string[] = [];
    for (const a of args) {
      if (a.startsWith("-") || a === "(" || a === "!") break;
      lead.push(a);
    }
    return or([...lead, ...args.filter((a, i) => args[i - 1] === "-fprint" || args[i - 1] === "-fprint0" || args[i - 1] === "-fprintf" || args[i - 1] === "-fls")]);
  }
  if (verb === "sed" && !unitReadOnly(core, skip)) {
    const scr = new Set(scriptOperands(core, skip));
    return or(core.filter((x, i) => i > 0 && x !== "" && !x.startsWith("-") && !skip.has(i) && !scr.has(i)));
  }
  if (verb === "git") {
    let k = 1;
    let dir: string | undefined;
    const repoOpts: string[] = [];
    while (k < core.length && core[k].startsWith("-")) {
      if (core[k] === "-C" && k + 1 < core.length) dir = core[k + 1];
      else if (core[k] === "-c") return { targets: [], unknown: "git -c" };
      else if (/^--(git-dir|work-tree)=./.test(core[k])) repoOpts.push(core[k].slice(core[k].indexOf("=") + 1));
      k += /^-[Cc]$/.test(core[k]) || /^--(git-dir|work-tree)$/.test(core[k]) ? 2 : 1;
      if (/^--(git-dir|work-tree)$/.test(core[k - 2] ?? "") && k - 1 < core.length) repoOpts.push(core[k - 1]);
    }
    const sub = core[k];
    if (!sub) return { targets: [] };
    const rest = core.slice(k + 1);
    const outs = rest.filter((a) => /^--output=./.test(a)).map((a) => a.slice(a.indexOf("=") + 1));
    // a config write is denied whatever repository it names: the cwd (the round worktree) is always a target, next to -C, --git-dir and --work-tree
    // (a write also names `--global`/`--system` files, so a read-only child is denied it from any cwd: `deny`)
    if (sub === "config") return gitConfigRead(rest) ? { targets: outs } : { targets: [".", ...(dir ? [dir] : []), ...repoOpts, ...outs], deny: "git config" };
    if (GIT_RO_SUBS.has(sub)) return { targets: outs };
    if (sub === "stash" && (rest[0] === "list" || rest[0] === "show")) return { targets: outs };
    if (sub === "apply" && rest.some((a) => /^--(check|stat|numstat|summary)$/.test(a)) && !rest.includes("--apply")) return { targets: outs };
    return { targets: [dir ?? ".", ...outs] };
  }
  if (RO_READERS.has(verb)) return unitReadOnly(core, skip) ? { targets: [] } : { targets: [], unknown: verb };
  if (SHELLS.has(verb) && inner) return { targets: [] };
  // the target of a redirect (`</dev/null`, `<&-`, `2>&1`) is no operand of the run
  const runArgs = core.filter((_, i) => i > 0 && !skip.has(i));
  if (buildTestRun(verb, runArgs)) return { targets: [], run: true, script: repoScriptWord(verb, runArgs) ?? undefined, operands: runOperands(verb, runArgs) };
  return { targets: [], unknown: verb };
}

function baseName(w: string): string {
  const b = w.split(/[\\/]/).pop() ?? w;
  return b.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

/** The unit as written, then with env assignments / wrapper commands / the path prefix stripped. */
function variants(words: string[]): { texts: string[]; core: string[] } {
  let w = words.slice();
  const texts: string[] = [];
  for (let n = 0; n < 8 && w.length; n++) {
    texts.push(w.join(" "));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const base = baseName(w[0]);
    if (base !== w[0]) {
      w = [base, ...w.slice(1)];
      texts.push(w.join(" "));
    }
    if (!WRAPPERS.has(base)) break;
    w = w.slice(1);
    while (w.length && (w[0].startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(w[0]))) w = w.slice(1);
  }
  return { texts, core: w };
}

/** The script a shell-ish unit carries in an argument (`bash -c '...'`, `eval ...`, `pwsh -c ...`). */
function innerScript(core: string[]): { script: string; shell: "posix" | "powershell" } | null {
  if (!core.length) return null;
  const cmd = baseName(core[0]);
  if (SHELLS.has(cmd)) {
    const i = core.findIndex((x, k) => k > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
    return i > 0 && core[i + 1] !== undefined ? { script: core[i + 1], shell: "posix" } : null;
  }
  if (cmd === "eval") return core.length > 1 ? { script: core.slice(1).join(" "), shell: "posix" } : null;
  if (cmd === "pwsh" || cmd === "powershell") {
    const i = core.findIndex((x, k) => k > 0 && /^-(c|command)$/i.test(x));
    return i > 0 && core[i + 1] !== undefined ? { script: core.slice(i + 1).join(" "), shell: "powershell" } : null;
  }
  if (cmd === "cmd") {
    const i = core.findIndex((x, k) => k > 0 && /^\/[ck]$/i.test(x));
    return i > 0 ? { script: core.slice(i + 1).join(" "), shell: "powershell" } : null;
  }
  return null;
}

interface Collected {
  /** Harness-set variables a same-line `$NAME` may resolve to (shellvars.ts); unset below the top level. */
  vars?: Record<string, string>;
  /** Names the whole line binds (boundNames); with `boundRefs`, the words referencing a bound TRUSTED_VARS name the grammar left unresolved. */
  bound?: ReadonlySet<string>;
  boundRefs?: string[];
  unitTexts: string[];
  pipeTexts: string[];
  words: string[];
  /** Operands of a remove/rename command and inline-code literals (removeAsk). */
  removeWords?: string[];
  /** `words` without the pattern/script operands of read commands (write protection). */
  protWords?: string[];
  /** Words that are the value of a known prose option, by position (`--reason TEXT`, `--note=TEXT`, `-m TEXT` of `git commit`). */
  proseSkip?: string[];
  /** Every unit's command is a read/filter command (PURE_VERBS) that cannot turn text into a path. */
  pure?: boolean;
  /** False once a unit can write: in-place sed, `sort -o`, `find -exec`/`-delete`, `rg --pre` and the like. */
  ro?: boolean;
  /** False once a unit is not a PROTECTED_READERS command: only then may a protected operand be skipped as a read. */
  rdr?: boolean;
  /** Words that are the target of a write redirect (`/dev/null` and fd dups excluded). */
  writeTargets?: Set<string>;
  /** Write targets of redirects and of the writing verbs `TMP_WRITERS` (a child's /tmp deny). */
  tmpTargets?: Set<string>;
  /** The first `git worktree` subcommand found that is neither `list` nor `remove` (children may not run it). */
  worktreeOp?: string;
  /** `git fetch`, `npm ci`, `npm install` found: the foreman's baseline rows allow them, a child still asks. */
  childAsk?: string;
  /** Operands of `git worktree remove`: the permission system asks for it, so the worktree block leaves them to it. */
  worktreeRemoveWords?: Set<string>;
  /** Path words a unit writes, moves or deletes (RO_WRITERS, in-place sed, `dd of=`, writing git, `find -delete`): a read-only child's deny. */
  roTargets?: Set<string>;
  /** The first posix command that is neither a known reader, a test run nor a known writer: it may write the cwd. */
  roUnknown?: string;
  /** The words of that command: a path among them in a read-only root is denied whatever the cwd. */
  roUnknownWords?: string[];
  /** A command a read-only child (no write root) may not run from any cwd (`git config` in a write form). */
  roDeny?: string;
  /** A test run / repo script run was found; its script words (a read-only child may run only git-tracked ones inside the round worktree). */
  roRun?: boolean;
  roScripts?: string[];
  /** Path operands of those test runs (runOperands), same rule as the scripts. */
  roOperands?: string[];
  /** Script files named to node/python/python3/bash/sh/npx (any child role): read and scanned when they lie outside git (probeScripts). */
  probeFiles?: string[];
  /** Inline python that provably only reads (pythonReadOnlyCode): its text and literals are no write-protection operands. */
  readCode?: Set<string>;
  /** A `cd`/`pushd`/`export`/`env` command or an env assignment prefix was found (refused next to a run for a read-only child). */
  roCdEnv?: boolean;
  /** Top level only: the session cwd and file probes, to resolve `..` words after a `cd` that ran first. */
  cdBase?: { cwd: string; realpath: (p: string) => string | null; isDir: (p: string) => boolean };
}

/**
 * Commands that never take a path from their input or from another command's text (no stdin-to-argv,
 * no exec). Only when EVERY unit of a command is one of these are pattern and script operands
 * skipped by the write protection; otherwise a pattern could become a path (`echo .git | xargs rm`).
 */
const PURE_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "gawk", "mawk", "nawk", "find", "echo", "printf", "cat", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "ls", "cd", "pwd", "nl", "column", "diff", "true", "false"]);

/**
 * The only verbs whose protected operands count as a read (write-only protect rules skip them). Programmable or
 * option-rich readers (awk, sort, uniq, less, find, xargs, tee, ...) keep full protection whatever their flags.
 */
const PROTECTED_READERS = new Set(["cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ls", "stat", "file", "diff", "cmp", "md5sum", "sha1sum", "sha256sum", "shasum", "cd", "sed", "echo", "pwd", "true", "false"]);

/** Short options that take a value, and long ones that take the next word, per read command. */
const VALUE_OPTS: Record<string, { short: string; long: string[]; pattern: string; patternLong: string[]; file: string; fileLong: string[]; globLong?: string[]; globShort?: string }> = {
  grep: { short: "ABCDdefm", long: ["--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--devices", "--directories", "--label", "--binary-files", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--color", "--colour"], pattern: "e", patternLong: ["--regexp"], file: "f", fileLong: ["--file"], globLong: ["--include", "--exclude", "--exclude-dir", "--include-dir"] },
  rg: { short: "ABCEMTdefgjmrt", long: ["--regexp", "--file", "--after-context", "--before-context", "--context", "--max-count", "--max-depth", "--max-columns", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--replace", "--pre", "--pre-glob", "--encoding", "--threads", "--sort", "--sortr", "--max-filesize", "--colors", "--color", "--path-separator", "--engine", "--ignore-file", "--context-separator", "--field-match-separator", "--field-context-separator", "--dfa-size-limit", "--regex-size-limit", "--hyperlink-format", "--hostname-bin"], pattern: "e", patternLong: ["--regexp"], file: "f", fileLong: ["--file"], globLong: ["--glob", "--iglob"], globShort: "g" },
  sed: { short: "ef", long: ["--expression", "--file", "--line-length"], pattern: "e", patternLong: ["--expression"], file: "f", fileLong: ["--file"] },
  awk: { short: "Fvfeil", long: ["--field-separator", "--assign", "--file", "--source", "--include", "--load"], pattern: "e", patternLong: ["--source"], file: "f", fileLong: ["--file"] },
};
for (const k of ["egrep", "fgrep"]) VALUE_OPTS[k] = VALUE_OPTS.grep;
for (const k of ["gawk", "mawk", "nawk"]) VALUE_OPTS[k] = VALUE_OPTS.awk;

/** A sed script that writes, reads or runs nothing (`w`/`W`/`r`/`R`/`e` commands, the `s///w|e` flags, `a`/`i`/`c` text). */
function sedReadOnly(script: string): boolean {
  let s = script.replace(/\\\n/g, " ");
  s = s.replace(/s(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1([A-Za-z0-9]*)/gs, (_m, _d, _a, _b, flags: string) => (/[we]/.test(flags) ? " w " : ";"));
  s = s.replace(/y(.)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)\1/gs, ";");
  s = s.replace(/\/(?:\\.|[^/\\])*\//g, " ").replace(/\\(.)(?:\\.|(?!\1).)*\1/gs, " ");
  return !/[wWrReFaic]/.test(s.replace(/[^A-Za-z]/g, ""));
}

/** An awk program without redirection, pipes, getline or system(). */
function awkReadOnly(prog: string): boolean {
  return !/[<>|]|system|getline|close|fflush/.test(prog);
}

/**
 * Indices (into `core`) of the pattern or script operands of a read command: the grep/rg pattern
 * and `-e` values, the sed script, the awk program, find's -name/-iname/-path/-regex values,
 * every echo/printf argument. `skip` = redirect targets. Files named by `-f` stay paths.
 */
function nonPathArgs(core: string[], skip: Set<number>): number[] {
  const verb = core.length ? baseName(core[0]) : "";
  const readOnly = (s: string): boolean => (verb === "sed" ? sedReadOnly(s) : verb.endsWith("awk") ? awkReadOnly(s) : true);
  // a script-file or output flag may mis-sort the operands (`awk -F -- --fil=p.awk f`): then every word stays a path
  if ((verb === "sed" || verb.endsWith("awk")) && !unitReadOnly(core, skip)) return [];
  return scriptOperands(core, skip).filter((i) => readOnly(core[i]));
}

/** nonPathArgs before the read-only filter: every pattern/script operand (and, for grep and rg, the include/exclude/glob values). */
function scriptOperands(core: string[], skip: Set<number>): number[] {
  if (!core.length) return [];
  const verb = baseName(core[0]);
  const out: number[] = [];
  const ok = (i: number): boolean => !skip.has(i);
  if (verb === "echo" || verb === "printf") return core.map((_, i) => i).filter((i) => i > 0 && ok(i));
  if (verb === "find") {
    if (core.some((x) => /^-(exec|execdir|ok|okdir|delete)$/.test(x))) return [];
    core.forEach((x, i) => {
      if (/^-(name|iname|path|ipath|regex|iregex|wholename|iwholename)$/.test(x) && i + 1 < core.length && ok(i + 1)) out.push(i + 1);
    });
    return out;
  }
  if (verb === "git") {
    // `git grep` takes grep's pattern forms after its global options
    let k = 1;
    while (k < core.length && core[k].startsWith("-")) k += /^-[Cc]$/.test(core[k]) ? 2 : 1;
    if (core[k] !== "grep") return [];
    const rest = core.slice(k);
    return scriptOperands(rest, new Set([...skip].filter((i) => i > k).map((i) => i - k))).map((i) => i + k);
  }
  const spec = VALUE_OPTS[verb];
  if (!spec) return [];
  const grepLike = GREP_FAMILY.has(verb);
  const isRg = verb === "rg";
  if (isRg && core.some((x) => x === "--files" || x === "--type-list")) return [];
  const scripts: number[] = [];
  let given = false;
  let positional = -1;
  let ended = false;
  for (let i = 1; i < core.length; i++) {
    if (!ok(i)) continue;
    const x = core[i];
    if (!ended && x === "--") {
      ended = true;
      continue;
    }
    if (!ended && /^--[^=]/.test(x)) {
      const eq = x.indexOf("=");
      const name = eq > 0 ? x.slice(0, eq) : x;
      const isPat = spec.patternLong.includes(name);
      if (isPat || spec.fileLong.includes(name)) given = true;
      if (spec.globLong?.includes(name)) {
        // a file-name pattern (`--exclude-dir=.git`), never a path
        if (eq > 0) scripts.push(i);
        else if (i + 1 < core.length && ok(i + 1)) scripts.push(i + 1);
      }
      if (eq < 0 && spec.long.includes(name)) {
        // the value of any other option (`--encoding re`, `-A 3`) is no path either; file-reading options keep theirs
        if ((isPat || (grepLike && !PATH_VALUED.test(name))) && i + 1 < core.length && ok(i + 1)) scripts.push(i + 1);
        i++;
      } else if (eq > 0 && isPat) scripts.push(i);
      continue;
    }
    if (!ended && /^-[^-]/.test(x) && !(verb.endsWith("awk") && /^-[0-9]/.test(x))) {
      for (let k = 1; k < x.length; k++) {
        const c = x[k];
        if (!spec.short.includes(c)) continue;
        if (c === spec.pattern || c === spec.file) given = true;
        const isGlob = c === spec.globShort;
        if (k + 1 < x.length) {
          if (c === spec.pattern || isGlob) scripts.push(i);
        } else if (i + 1 < core.length) {
          if ((c === spec.pattern || isGlob || (grepLike && c !== spec.file)) && ok(i + 1)) scripts.push(i + 1);
          i++;
        }
        break;
      }
      continue;
    }
    if (positional < 0) positional = i;
    // awk stops at its program; grep, rg and GNU sed take options after operands too (`grep x f -e y`)
    if (verb.endsWith("awk")) break;
  }
  if (!given && positional > 0) scripts.push(positional);
  return scripts;
}

/** Long grep/rg options whose separate value names a file or program: it stays a path word. */
const PATH_VALUED = /^--(file|exclude-from|ignore-file|pre|pre-glob|hostname-bin)$/;

/** Words that can never name a file to change in a redirect. */
const DEV_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|\d+|-)$/;

/**
 * Long options each read command may carry and stay read-only. Anything else (an abbreviation such as
 * `--o=` for `--output`, `--in-pl`, `--pr=sh`, or an unknown option) makes the unit not read-only.
 */
const READ_LONG: Record<string, string[]> = {
  sort: "reverse numeric-sort unique ignore-case key field-separator human-numeric-sort month-sort version-sort general-numeric-sort ignore-leading-blanks dictionary-order ignore-nonprinting stable check merge zero-terminated parallel buffer-size temporary-directory random-sort help version".split(" "),
  uniq: "count repeated unique ignore-case skip-fields skip-chars check-chars all-repeated group zero-terminated help version".split(" "),
  sed: "quiet silent expression regexp-extended separate null-data line-length posix debug sandbox unbuffered binary help version".split(" "),
  awk: "assign field-separator posix traditional re-interval sandbox help version".split(" "),
  grep: "recursive dereference-recursive line-number ignore-case no-ignore-case invert-match count files-with-matches files-without-match include exclude exclude-dir regexp fixed-strings extended-regexp basic-regexp perl-regexp word-regexp line-regexp no-filename with-filename only-matching quiet silent max-count context after-context before-context color colour binary-files null text no-messages byte-offset initial-tab binary directories devices help version".split(" "),
  rg: "glob iglob type type-not files files-with-matches files-without-match count count-matches line-number no-line-number ignore-case smart-case case-sensitive hidden no-ignore fixed-strings word-regexp line-regexp invert-match only-matching max-count max-depth context after-context before-context regexp heading no-heading with-filename no-filename follow multiline color json sort sortr threads type-list column pretty vimgrep null text quiet stats no-messages unrestricted glob-case-insensitive pcre2 engine replace trim help version".split(" "),
  find: ["help", "version"],
  diff: "unified context brief recursive ignore-case ignore-space-change ignore-all-space ignore-blank-lines side-by-side new-file text color report-identical-files minimal show-c-function label exclude help version".split(" "),
};

/** Whether one command (wrappers stripped) can only read: no in-place edit, output file, exec or script file. */
function unitReadOnly(core: string[], skip: Set<number>): boolean {
  const verb = baseName(core[0]);
  const args = core.map((x, i) => (i > 0 && !skip.has(i) ? x : "")).slice(1);
  const has = (re: RegExp): boolean => args.some((x) => re.test(x));
  const longs = READ_LONG[verb.endsWith("awk") ? "awk" : verb];
  if (longs) {
    // never stop at `--`: it can be an option's value (`sort -T -- --o=FILE`)
    for (const x of args) {
      if (/^--./.test(x) && !longs.includes(x.slice(2).split("=")[0])) return false;
    }
  }
  if (verb === "sort") return !has(/^-[A-Za-z]*o|^--(output|compress-program)\b/);
  if (verb === "xxd") {
    // `-r` reverts a dump into a binary and `xxd IN OUT` writes OUT: a read only without -r and with at most one operand (the values of -l -s -c -g -o are no operands)
    if (has(/^-[A-Za-z]*r|^--(revert|r)\b/)) return false;
    return args.filter((x, i) => x && !x.startsWith("-") && !/^-[lscgo]$/.test(args[i - 1] ?? "")).length <= 1;
  }
  if (verb === "find") return !has(/^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/);
  if (verb === "uniq") return !has(/^-[^-]*[^-cdDfisuwz0-9]/) && args.filter((x) => x && (x === "-" || !x.startsWith("-"))).length <= 1;
  if (verb === "rg") return !has(/^--(pre|hostname-bin)\b/);
  if (verb === "sed") {
    // only flag letters and `-e` (BSD `-I`/`-l`, `-i`, `-f` write or take a file); `-l` is no value option, so its script is still checked
    if (args.some((x) => /^-[^-]/.test(x) && !/^-[nErsuze]*$/.test(x))) return false;
    const scripts = scriptOperands(core, skip);
    return scripts.length > 0 && scripts.every((i) => sedReadOnly(core[i]));
  }
  if (verb.endsWith("awk")) {
    if (has(/^-[A-Za-z]*[fEdilop]|^--(f|e|include|load)/)) return false;
    const scripts = scriptOperands(core, skip);
    return scripts.length > 0 && scripts.every((i) => awkReadOnly(core[i]));
  }
  return true;
}

/** Whether one unit (wrappers stripped) may have its protected operands skipped as a read: see PROTECTED_READERS. */
function protectedReader(core: string[], skip: Set<number>): boolean {
  const verb = baseName(core[0]);
  const args = core.map((x, i) => (i > 0 && !skip.has(i) ? x : "")).slice(1);
  const has = (re: RegExp): boolean => args.some((x) => re.test(x));
  // a leading `$HOME/` / `${HOME}/` is expanded by the path checks (expandWord), like `~/` (checkShell denies a line that binds HOME);
  // a bare `$HOME` and any other expansion is unresolved
  const expands = (x: string): boolean => /[$`]/.test(x.replace(/^\$(?:\{HOME\}|HOME)(?=\/)/, ""));
  // an unresolved expansion in any quoting may supply an option or script (`I=-i; sed $I p D`, `P=--pre=x; rg $P p D`)
  if (args.some(expands)) return false;
  if (!PROTECTED_READERS.has(verb)) return false;
  if (verb === "file") return !has(/^-[A-Za-z]*C|^--compile/);
  if (GREP_FAMILY.has(verb)) return !has(/^-[A-Za-z]*f|^--(pre|pre-glob|file|ignore-file|hostname-bin)/) && unitReadOnly(core, skip);
  return unitReadOnly(core, skip);
}

/** Commands that remove or rename their operands (POSIX, Windows, PowerShell names and aliases). */
const REMOVERS = new Set(["rm", "rmdir", "unlink", "trash", "trash-put", "gio", "mv", "rename", "ren", "move", "del", "erase", "rd", "srm", "shred", "remove-item", "ri", "rni", "rename-item", "move-item", "mi"]);

const MAX_DEPTH = 4;

/** An include/exclude filter option with its value attached (`--exclude-dir=.git`): the value is a pattern to leave out, not a path the command opens. */
const FILTER_OPT = /^--(exclude|include|exclude-dir|include-dir)=/;

/** Builtins that assign their words to a variable. */
const ASSIGNERS = new Set(["read", "declare", "typeset", "export", "local", "readonly", "mapfile", "readarray"]);

/** Reserved words that precede a command (`do cat x`, `then grep y`, `! find`). */
const LEAD_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "}"]);
/** Units that only steer control flow: `for f in a b`, `case x in`, a lone `done`/`fi`/`esac`. */
const NEUTRAL_UNITS = new Set(["for", "select", "case"]);
const NEUTRAL_END = new Set(["done", "fi", "esac"]);
const GREP_FAMILY = new Set(["grep", "egrep", "fgrep", "rg"]);
/** `git worktree` subcommands a child may run (`remove` is ask in the permission system). */
const WORKTREE_OK = new Set(["list", "remove"]);

function collect(src: string, shell: "posix" | "powershell", depth: number, out: Collected): void {
  const parsed = parseShell(src, shell);
  // same-line variables (shellvars.ts): the expanded words and texts are checked next to the line as written
  const resolved = depth === 0 && shell === "posix" && out.vars ? resolveVars(parsed.pipelines, parsed.seps, out.vars, (u) => REDIRECTS.has(u), src) : new Map<string[], string[]>();
  for (const pipe of parsed.pipelines) if (pipe.some((u) => resolved.has(u))) out.pipeTexts.push(pipe.map((u) => (resolved.get(u) ?? u).join(" ")).join(" | "));
  for (const inner of parsed.subs) if (depth < MAX_DEPTH) collect(inner, shell, depth + 1, out);
  const visit = (allWords: string[]): void => {
    // `do cat x`, `then grep y`, `if find ...`: the keyword is not the command
    let lead = 0;
    while (lead < allWords.length && LEAD_KEYWORDS.has(allWords[lead])) lead++;
    const unitWords = lead ? allWords.slice(lead) : allWords;
    if (lead) {
      const r = REDIRECTS.get(allWords);
      const w = WRITE_REDIRECTS.get(allWords);
      if (r) REDIRECTS.set(unitWords, new Set([...r].filter((i) => i >= lead).map((i) => i - lead)));
      if (w) WRITE_REDIRECTS.set(unitWords, new Set([...w].filter((i) => i >= lead).map((i) => i - lead)));
      out.unitTexts.push(allWords.join(" "));
    }
    const v = variants(unitWords);
    out.unitTexts.push(...v.texts);
    const redir = REDIRECTS.get(unitWords) ?? new Set<number>();
    const off = unitWords.length - v.core.length;
    const skip = new Set([...redir].filter((i) => i >= off).map((i) => i - off));
    // the pattern of grep/rg and their include/exclude/glob values are no paths, whatever the rest of the command does
    const verb0 = v.core.length ? baseName(v.core[0]) : "";
    const patt = GREP_FAMILY.has(verb0) || verb0 === "git" || verb0 === "sed" || verb0.endsWith("awk") ? new Set(nonPathArgs(v.core, skip).map((i) => i + off)) : new Set<number>();
    out.words.push(...unitWords.filter((_, i) => !patt.has(i)));
    out.proseSkip?.push(...proseIndexes(v.core).filter((i) => !patt.has(i + off)).map((i) => unitWords[i + off]));
    const rw = resolved.get(allWords);
    if (rw) {
      const rest = lead ? rw.slice(lead) : rw;
      const extra = rest.filter((w, i) => w !== unitWords[i] && !patt.has(i));
      out.words.push(...extra);
      out.protWords?.push(...extra);
      out.unitTexts.push(rest.join(" "));
    }
    // ONE resolution for every target set below: the unit's words with the grammar's values (shellvars.ts) substituted
    const rWords = rw ? (lead ? rw.slice(lead) : rw) : unitWords;
    const rcore = rWords.slice(off);
    const trustedBound = new Set([...(out.bound ?? [])].filter((n) => TRUSTED_VARS.has(n)));
    if (trustedBound.size) out.boundRefs?.push(...rWords.filter((w, i) => !patt.has(i) && refsBound(w, trustedBound)));
    if (out.childAsk === undefined) {
      let k = 1;
      if (verb0 === "git") {
        while (k < v.core.length && v.core[k].startsWith("-")) k += /^-[Cc]$/.test(v.core[k]) ? 2 : 1;
        if (v.core[k] === "fetch") out.childAsk = "git fetch";
      } else if (verb0 === "npm" && (v.core[1] === "ci" || v.core[1] === "install" || v.core[1] === "i")) out.childAsk = `npm ${v.core[1]}`;
    }
    if (verb0 === "git" && out.worktreeOp === undefined) {
      let k = 1;
      while (k < v.core.length && v.core[k].startsWith("-")) k += /^-[Cc]$/.test(v.core[k]) ? 2 : 1;
      if (v.core[k] === "worktree" && k + 1 < v.core.length) {
        const op = v.core[k + 1];
        if (!WORKTREE_OK.has(op)) out.worktreeOp = op;
        else if (op === "remove") for (const x of v.core.slice(k + 2)) out.worktreeRemoveWords?.add(x);
      }
    }
    if (out.protWords) {
      // control-flow words (`for f in a b`, `done`) neither read nor write
      const neutral = !unitWords.length || NEUTRAL_UNITS.has(unitWords[0]) || (unitWords.length === 1 && NEUTRAL_END.has(unitWords[0]));
      const raw = unitWords.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      // `printf -v f %s PATH`, `read f`, `declare f=PATH`, `mapfile f`: the words become a variable a later redirect may use
      if (ASSIGNERS.has(verb0) || (verb0 === "printf" && v.core.includes("-v"))) out.pure = false;
      if (!neutral && raw !== undefined) {
        const reader = v.core.length > 0 && protectedReader(v.core, skip);
        if (!reader) out.rdr = false;
        if (!PURE_VERBS.has(baseName(raw)) || !v.core.length || !PURE_VERBS.has(baseName(v.core[0]))) out.pure = false;
        else if (!reader || !unitReadOnly(v.core, skip)) {
          if (!unitReadOnly(v.core, skip)) out.ro = false;
          // an output flag may carry its path attached (`gawk -oFILE`, `sort -k1 -oFILE`, `--output=FILE`, `-W dump-variables=FILE`): scan every tail of an option word
          for (const x of v.core.slice(1)) {
            if (/^-[^-]/.test(x)) for (let k = 2; k < x.length; k++) out.protWords.push(x.slice(k));
            else if (x.indexOf("=") > 0) out.protWords.push(x.slice(x.indexOf("=") + 1));
          }
        }
      }
      const np = new Set(nonPathArgs(v.core, skip).map((i) => i + off));
      out.protWords.push(...unitWords.filter((_, i) => !np.has(i)));
      for (const i of WRITE_REDIRECTS.get(unitWords) ?? []) if (!DEV_TARGET.test(rWords[i])) {
        out.writeTargets?.add(rWords[i]);
        out.tmpTargets?.add(rWords[i]);
        out.roTargets?.add(asPathWord(rWords[i]));
      }
      const writer = v.core.length ? TMP_WRITERS.get(baseName(v.core[0])) : undefined;
      if (writer && out.tmpTargets) {
        const operands = rcore.slice(1).filter((x) => !x.startsWith("-"));
        for (const x of writer === "last" ? operands.slice(-1) : operands) {
          out.tmpTargets.add(x);
          out.roTargets?.add(asPathWord(x));
        }
      }
      if (out.roTargets && !neutral && v.core.length) {
        const e = roEffect(rcore, skip, innerScript(v.core) !== null);
        if (e.run) {
          out.roRun = true;
          if (e.script !== undefined) (out.roScripts ??= []).push(e.script);
          if (e.operands?.length) (out.roOperands ??= []).push(...e.operands);
        }
        if (/^(cd|pushd|export)$/.test(baseName(v.core[0])) || unitWords.slice(0, off).some((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || baseName(w) === "env")) out.roCdEnv = true;
        // a bare name that does not exist yet is not path-shaped to pathCandidates: `./` makes it a path against the cwd
        for (const t of e.targets) out.roTargets.add(asPathWord(t));
        if (e.deny !== undefined) out.roDeny ??= e.deny;
        if (e.unknown !== undefined && shell === "posix" && out.roUnknown === undefined) {
          out.roUnknown = e.unknown;
          out.roUnknownWords = rcore.slice(1);
        }
      }
    }
    if (out.probeFiles && v.core.length) out.probeFiles.push(...probeScripts(verb0, v.core.slice(1)));
    const inner = innerScript(v.core);
    if (inner && depth < MAX_DEPTH) collect(inner.script, inner.shell, depth + 1, out);
    const code = inlineCode(v.core);
    if (code) out.words.push(...codeLiterals(code));
    if (code && out.protWords) out.protWords.push(...codeLiterals(code));
    if (code && out.readCode && /^(python|pypy)/.test(baseName(v.core[0])) && pythonReadOnlyCode(code)) {
      out.readCode.add(code);
      for (const l of codeLiterals(code)) out.readCode.add(l);
    }
    if (out.removeWords) {
      if (code) out.removeWords.push(...codeLiterals(code));
      const verb = v.core.length ? baseName(v.core[0]) : "";
      if (REMOVERS.has(verb) || (verb === "find" && v.core.includes("-delete"))) out.removeWords.push(...v.core.slice(1));
    }
    const exec = v.core.findIndex((x) => x === "-exec" || x === "-execdir" || x === "-ok" || x === "-okdir");
    if (exec >= 0 && depth < MAX_DEPTH) {
      const rest = v.core.slice(exec + 1);
      const end = rest.findIndex((x) => x === ";" || x === "+");
      visit(end >= 0 ? rest.slice(0, end) : rest);
    }
  };
  // `cd <dir> && cat ../x`: a relative word with a `..` after a cd that ran first resolves from the cd'd directory, not from the session cwd
  let dir: string | null = null;
  const cd = depth === 0 && shell === "posix" ? out.cdBase : undefined;
  parsed.pipelines.forEach((pipe, pi) => {
    out.pipeTexts.push(pipe.map((u) => u.join(" ")).join(" | "));
    const w0 = out.words.length;
    const p0 = out.protWords?.length ?? 0;
    const targets = [out.roTargets, out.tmpTargets].map((s) => (s ? new Set(s) : undefined));
    for (const u of pipe) visit(u);
    if (!cd) return;
    const rebase = (w: string): string => (dir !== null && !/\s/.test(w) && !/^[-/~$\\]/.test(w) && /(^|\/)\.\.(\/|$)/.test(w) ? path.resolve(dir, w) : w);
    if (dir !== null) {
      for (let i = w0; i < out.words.length; i++) out.words[i] = rebase(out.words[i]);
      if (out.protWords) for (let i = p0; i < out.protWords.length; i++) out.protWords[i] = rebase(out.protWords[i]);
      [out.roTargets, out.tmpTargets].forEach((set, k) => {
        if (!set) return;
        for (const t of [...set]) if (!targets[k]!.has(t) && rebase(t) !== t) { set.delete(t); set.add(rebase(t)); }
      });
    }
    const sep = parsed.seps[pi];
    const u = pipe.length === 1 ? pipe[0] : undefined;
    if (u && u[0] === "cd" && (sep === "&&" || sep === ";")) {
      const args = u.slice(1).filter((a, i) => !(i === 0 && (a === "-L" || a === "-P" || a === "--")));
      const t = args.length === 1 ? args[0] : undefined;
      if (t && !/[$`*?[\]{}\\]|^[-~]/.test(t)) {
        const real = cd.realpath(path.resolve(dir ?? cd.cwd, t));
        if (real && cd.isDir(real)) dir = real;
      }
    }
  });
}

// ---------------------------------------------------------------------- paths

const GLOB = /[*?[]/;

function defaults(ctx: MatchCtx): Required<Pick<MatchCtx, "exists" | "isDir" | "realpath" | "list">> {
  return {
    exists: ctx.exists ?? ((p) => fs.existsSync(p)),
    isDir: ctx.isDir ?? ((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }),
    realpath: ctx.realpath ?? ((p) => { try { return fs.realpathSync(p); } catch { return null; } }),
    list: ctx.list ?? ((d) => { try { return fs.readdirSync(d).slice(0, 500); } catch { return []; } }),
  };
}

function expandWord(w: string, ctx: MatchCtx): string {
  let s = w.replace(/^file:\/\//, "");
  const bound = ctx.bound ?? new Set<string>();
  // `~` is `$HOME`: trusted only while the line binds HOME nowhere
  if (!bound.has("HOME")) {
    if (s === "~") s = ctx.home;
    else if (s.startsWith("~/") || s.startsWith("~\\")) s = ctx.home + s.slice(1);
  }
  if (!bound.has("HOME")) s = s.replace(/^\$(?:\{HOME\}|HOME)(?=$|[\\/])/, ctx.home);
  const scratch = scratchOf(ctx);
  // `$S` is the child's conventional name for its scratch dir, trusted only while the line binds it nowhere (ctx.bound); a bound
  // one resolves only through the closed grammar (shellvars.ts), whose values feed every target set (collect), else checkShell denies
  if (scratch) s = s.replace(/^\$(\{FOREMAN_SCRATCH\}|FOREMAN_SCRATCH(?![A-Za-z0-9_])|\{S\}|S(?![A-Za-z0-9_]))/, (m, g: string) => (bound.has(g.replace(/[{}]/g, "")) ? m : scratch));
  // Git Bash / MSYS drive paths: /c/dir/x -> c:/dir/x
  if (ctx.platform === "win32") s = s.replace(/^\/([A-Za-z])(?=$|\/)/, "$1:");
  // a `$env:HOME` / `$env:USERPROFILE` the line binds (any case) stays unexpanded: untrusted
  return s.replace(/^\$env:(USERPROFILE|HOME)(?=$|[\\/])/i, (m, n: string) => (bound.has(n.toUpperCase()) ? m : ctx.home));
}

/** Bash glob of one path segment: `*`, `?`, `[...]` / `[!...]`; an unclosed `[` is literal. */
function globRegExp(segment: string): RegExp {
  let body = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === "*") body += ".*";
    else if (c === "?") body += ".";
    else if (c === "[") {
      let j = i + 1;
      if (segment[j] === "!" || segment[j] === "^") j++;
      if (segment[j] === "]") j++;
      while (j < segment.length && segment[j] !== "]") j++;
      if (j >= segment.length) {
        body += "\\[";
        continue;
      }
      let cls = segment.slice(i + 1, j).replace(/\\/g, "\\\\");
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      body += `[${cls}]`;
      i = j;
    } else body += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${body}$`, "s");
  } catch {
    return /^$/;
  }
}

const MAX_GLOB = 200;

/** Every existing path a glob (in any segment, `~/.s*\/id_x`, `.ss[h]/x`) expands to, at most MAX_GLOB. */
function expandGlob(abs: string, p: path.PlatformPath, fsx: ReturnType<typeof defaults>, ctx: MatchCtx): string[] {
  const root = p.parse(abs).root;
  // bash words (write protection): `\` separates only on win32, `*`/`?`/`[` skip dot entries (no dotglob)
  const bash = ctx.bashWords === true;
  const segs = abs.slice(root.length).split(bash && ctx.platform !== "win32" ? /\/+/ : /[\\/]+/).filter(Boolean);
  let cur = [root];
  for (const seg of segs) {
    if (!GLOB.test(seg)) {
      cur = cur.map((d) => p.join(d, seg));
      continue;
    }
    const re = globRegExp(seg);
    const next: string[] = [];
    for (const d of cur) {
      for (const name of fsx.list(d)) {
        const dotOk = bash && !ctx.dotGlob ? !name.startsWith(".") || seg.startsWith(".") : name.startsWith(".") || !seg.startsWith(".");
        if (re.test(name) && dotOk) next.push(p.join(d, name));
      }
      if (next.length >= MAX_GLOB) break;
    }
    cur = next.slice(0, MAX_GLOB);
    if (!cur.length) break;
  }
  return cur;
}

/**
 * Every concrete spelling of one word that a path rule should see. A word with white space is
 * prose or a script (`-m "see .env"`, `python -c "open('.env')"`): its parts are checked.
 */
function pathCandidates(word: string, ctx: MatchCtx): string[] {
  const parts = /\s/.test(word) ? word.split(/[\s'"`(),;<>]+/).filter(Boolean) : [word];
  return parts.flatMap((x) => tokenCandidates(x, ctx, 0));
}

/**
 * realpath of the deepest existing ancestor with the missing tail re-appended (T3): a new file
 * below a symlinked directory (`gd/hooks/pre-commit`, gd -> .git) resolves to its real target.
 */
function realDeep(abs: string, p: path.PlatformPath, fsx: ReturnType<typeof defaults>): string | null {
  const tail: string[] = [];
  let cur = abs;
  for (let n = 0; n < 64; n++) {
    const real = fsx.realpath(cur);
    if (real) return tail.length ? p.join(real, ...tail.reverse()) : real;
    const parent = p.dirname(cur);
    if (parent === cur) return null;
    tail.push(p.basename(cur));
    cur = parent;
  }
  return null;
}

function tokenCandidates(word: string, ctx: MatchCtx, depth: number): string[] {
  const fsx = defaults(ctx);
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const s = expandWord(word, ctx);
  const out: string[] = [];
  const eq = s.indexOf("=");
  if (eq > 0 && depth === 0) out.push(...tokenCandidates(s.slice(eq + 1), ctx, 1));
  // `<rev>:<path>` (`git show HEAD:.env`, T14): the part after the first `:` is a path too
  const colon = s.indexOf(":");
  if (colon >= 0 && depth < 2 && !/^[A-Za-z]:([\\/]|$)/.test(s)) out.push(...tokenCandidates(s.slice(colon + 1), ctx, 2));
  if (!s) return out;
  const abs = p.resolve(ctx.cwd, s);
  const pathShaped = (ctx.bashWords && ctx.platform !== "win32" ? /^[.~]|\// : /^[.~]|[\\/]/).test(s) || (ctx.platform === "win32" && SHORT_NAME.test(s));
  if (!pathShaped && !fsx.exists(abs)) return out;
  const add = (x: string): void => {
    out.push(x);
    if (x.endsWith("/") || x.endsWith("\\")) return;
    if (fsx.isDir(x)) out.push(x + p.sep);
  };
  if (s !== abs) out.push(s);
  add(abs);
  const real = realDeep(abs, p, fsx);
  if (real && real !== abs) add(real);
  if (GLOB.test(s)) {
    for (const x of expandGlob(abs, p, fsx, ctx)) {
      add(x);
      const r = fsx.realpath(x);
      if (r && r !== x) add(r);
    }
  }
  return out;
}

const CATCH_ALL = /^\*+$/;

/** The owned roots (and their subtrees) a `*` path rule never denies a read below: owned.ts roots, the scratch dir, the round roots, `ctx.readable`. */
function ownedReadPatterns(ctx: MatchCtx): string[] {
  const roots = [...(ctx.owned ? [...ctx.owned.readWrite, ...ctx.owned.readOnly] : []), ...[scratchOf(ctx)].filter((x): x is string => !!x), ...(ctx.roundRoots ?? []), ...(ctx.roundReadRoots ?? [])];
  return [...roots.flatMap((r) => [r, `${r}/*`]), ...(ctx.readable ?? [])];
}

/**
 * The path rule that denies `word`. A catch-all rule (`*`) matches path OPERANDS only: not the parts of a word with white space (command prose,
 * an expression; `proseOk` false for a write target, which is always an operand), and not a read (`readOnly`) below an owned root.
 */
function pathDeny(rules: PathRule[], word: string, ctx: MatchCtx, readOnly = false, proseOk = true): PathRule | null {
  const cands = pathCandidates(word, ctx);
  const denyPats = rules.filter((r) => r.action === "deny").map((r) => r.pattern);
  const prose = proseOk && /\s/.test(word);
  const ownedPats = readOnly ? ownedReadPatterns(ctx) : [];
  for (const cand of ctx.platform === "win32" ? [...cands, ...shortNameVariants(cands, denyPats)] : cands) {
    let verdict: PathRule | null = null;
    const ownedHits = ownedPats.filter((pat) => pathMatches(pat, cand, ctx));
    const ownedRead = ownedHits.length > 0;
    // a read below an owned root is no hit for a directory-scope rule (`<main>/*`) that contains that root; `*.env` and the like still fire
    const scoped = (pattern: string): boolean => {
      const m = ctx.platform === "win32" ? null : /^(\/[^*?[\]{}]*)\/\*$/.exec(pattern);
      return !!m && ownedHits.some((pat) => pat.startsWith(`${m[1]}/`));
    };
    for (const r of rules) if (pathMatches(r.pattern, cand, ctx) && !(CATCH_ALL.test(r.pattern) && (prose || ownedRead)) && !(ownedRead && r.action === "deny" && scoped(r.pattern))) verdict = r;
    if (verdict && verdict.action === "deny") return verdict;
  }
  return null;
}

const PROSE_OPTS = new Set(["--reason", "--title", "--body", "--note", "--message"]);

/**
 * The words of one unit (`core`) that are the value of a known prose option (`--reason`, `--title`, `--body`, `--note`, `--message`, and `-m`
 * of a `git commit` unit), by position: the word directly after the option, or the whole `--opt=value` word.
 */
function proseIndexes(core: string[]): number[] {
  let commit = false;
  if (core.length && baseName(core[0]) === "git") {
    let k = 1;
    while (k < core.length && core[k].startsWith("-")) k += /^-[Cc]$/.test(core[k]) ? 2 : 1;
    commit = core[k] === "commit";
  }
  const out: number[] = [];
  core.forEach((x, i) => {
    if (PROSE_OPTS.has(x.split("=")[0]) && x.includes("=")) out.push(i);
    else if ((PROSE_OPTS.has(x) || (commit && x === "-m")) && i + 1 < core.length) out.push(i + 1);
  });
  return out;
}

function pathAskHit(patterns: string[], word: string, ctx: MatchCtx): string | null {
  for (const cand of pathCandidates(word, ctx)) for (const pat of patterns) if (pathMatches(pat, cand, ctx)) return pat;
  return null;
}

// ------------------------------------------------------------------- decisions

const clip = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

// ----------------------------------------------------------- child cd confinement

const CD_VERBS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location"]);
const POP_VERBS = new Set(["popd", "pop-location"]);
const CD_DENY = "pi-foreman: denied by the permission policy (children may cd only inside the workspace). Use a path below the workspace root, or work with relative paths from it.";

// Reserved words and grouping in front of a command word (security review D-B1); `time`, `exec`,
// `command` and `builtin` are also stripped by `variants` as wrappers.
const CD_KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "time", "fi", "done", "esac"]);
const LOOP_START = new Set(["while", "until", "for", "select"]);

/**
 * Child-only: every cd/pushd/popd target, resolved cumulatively over the whole command from the
 * session cwd, must be provably inside the workspace (symlinks resolved). Anything not literal
 * (`$VAR`, `$()`, globs, a leading `~`, `-`, bare cd) denies, so does any mention of CDPATH (D-B2). A cd to a
 * directory that does not exist yet may fail at run time, so the tracked cwd is a set of
 * candidates and every later target must stay inside from each of them (D-B3); after `cd T &&`
 * the old cwd revives only where the and-list ends (`;`, `||`, `&`, newline, grouping). Inside a loop a
 * relative cd, pushd and popd deny (they repeat). Deny-only: it never allows.
 */
const STDIN_WRITE = /open\([^)]*,\s*(['"])[rwax]*[wax+][^'"]*\1|\b(write_text|write_bytes|writeFile\w*|appendFile\w*|createWriteStream|copyFile\w*|os\.(remove|rename|replace|unlink)|shutil\.|fs\.(write|rm|unlink|rename))/;

/**
 * A child never writes files through a heredoc or a stdin script: `cat > f <<'EOF'`, `tee f <<EOF`, `python3 - <<EOF` / `node -e` fed from stdin
 * that open a file for write. The body is invisible to the path checks, so it is refused outright (deny-only, no dialog).
 */
function childStdinWriteDeny(command: string): Decision | null {
  const heredoc = /<<(?!<)/.test(command);
  const stripped = command.replace(/\d*>&\d*-?|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g, "");
  const writer = (heredoc && /\bcat\b[^|;&\n]*>|\btee\b|\bdd\b[^|;&\n]*\bof=/.test(stripped))
    || ((heredoc || /\|\s*(python[\d.]*|node|perl|ruby)\b|\b(python[\d.]*|node|perl|ruby)\s+-(\s|$)|<<<|\bnode\s+-e\b/.test(command)) && /\b(python[\d.]*|node|perl|ruby)\b/.test(command) && STDIN_WRITE.test(command));
  if (!writer) return null;
  return { kind: "deny", reason: "pi-foreman: denied for a child (heredoc or stdin-script file write): never heredoc or stdin-script file writes; use the write or edit tool." };
}

function childCdDeny(command: string, ctx: MatchCtx): Decision | null {
  const win = ctx.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const fsx = defaults(ctx);
  const fold = (x: string): string => (win || ctx.platform === "darwin" ? x.toLowerCase() : x);
  const norm = (x: string): string => (win ? x.replace(/\\/g, "/") : x);
  // the allowed region: the workspace root of the cwd (the worktree root for a worktree; `cd ..` from a subdirectory) and the child's scratch dir
  const scratch = scratchOf(ctx);
  const roots = [ctx.cwd, workspaceOf(ctx.cwd).root, ...(scratch && p.isAbsolute(scratch) ? [scratch] : [])];
  const ws = roots.flatMap((r) => [r, fsx.realpath(r) ?? r]).map((x) => fold(p.resolve(norm(x))));
  const inside = (abs: string): boolean => ws.some((w) => {
    const rel = p.relative(w, fold(abs));
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel));
  });
  const deny = (): Decision => ({ kind: "deny", reason: CD_DENY });
  const cdpath = (x: string): boolean => /cdpath/i.test(x);
  if (cdpath(command)) return deny();
  let cur = new Set([p.resolve(norm(ctx.cwd))]);
  const stack: Array<{ set: Set<string>; sure: boolean }> = [];
  // sep: the operator after the unit (`|` inside a pipeline, "" for a keyword-only unit)
  const units: Array<{ core: string[]; sep: string }> = [];
  let blocked = false;
  const gather = (src: string, shell: "posix" | "powershell", depth: number): void => {
    if (cdpath(src)) blocked = true;
    const parsed = parseShell(src, shell);
    for (const sub of parsed.subs) if (depth < MAX_DEPTH) gather(sub, shell, depth + 1);
    parsed.pipelines.forEach((pipe, pi) => pipe.forEach((u, ui) => {
      const sep = ui < pipe.length - 1 ? "|" : parsed.seps[pi];
      if (u.some(cdpath)) blocked = true;
      // keywords, env assignments and wrappers in any order: `! FOO=1 command cd x`
      let core = u;
      for (let n = 0; n < 8; n++) {
        const lead: string[] = [];
        let k = 0;
        while (k < core.length && CD_KEYWORDS.has(core[k])) lead.push(core[k++]);
        if (lead.length) units.push({ core: lead, sep: "" });
        const next = variants(core.slice(k)).core;
        const done = next.length === core.length;
        core = next;
        if (done) break;
      }
      units.push({ core, sep });
      const inner = innerScript(core);
      if (inner && depth < MAX_DEPTH) gather(inner.script, inner.shell, depth + 1);
    }));
  };
  gather(command, ctx.shell ?? "posix", 0);
  if (blocked) return deny();
  let loop = 0;
  // `cd T && rest`: if the cd fails, the and-list stops, so the old cwd revives only after it ends
  let revive = new Set<string>();
  let prevSep = "";
  for (const { core, sep } of units) {
    if (revive.size && !["&&", "|", ""].includes(prevSep)) {
      cur = new Set([...cur, ...revive]);
      revive = new Set();
    }
    prevSep = sep;
    if (!core.length) continue;
    if (CD_KEYWORDS.has(core[0])) {
      for (const k of core) {
        if (LOOP_START.has(k)) loop++;
        else if (k === "done") loop = Math.max(0, loop - 1);
      }
      continue;
    }
    const verb = baseName(core[0]);
    if (LOOP_START.has(verb)) loop++; // `for x in ...` / `select x in ...`
    if (POP_VERBS.has(verb)) {
      const prev = stack.pop();
      if (prev === undefined || loop) return deny();
      // after a pushd that may have failed, the popped entry may belong to another pushd
      const unsure = !prev.sure || stack.some((e) => !e.sure);
      cur = unsure ? new Set([...prev.set, ...stack.flatMap((e) => [...e.set]), ...cur]) : prev.set;
      continue;
    }
    if (!CD_VERBS.has(verb)) continue;
    const args = core.slice(1);
    let i = 0;
    while (i < args.length && ["-L", "-P", "-e", "-@", "--"].includes(args[i])) i++;
    const raw = args[i];
    // the child's own scratch dir (childscratch.ts) by its env name
    const target = raw !== undefined && scratch ? raw.replace(/^\$(\{FOREMAN_SCRATCH\}|FOREMAN_SCRATCH(?![A-Za-z0-9_]))/, scratch) : raw;
    // `~` expands only at the start of a word; inside one it is literal (Windows short names: RUNNER~1)
    if (target === undefined || target === "" || /^[-+]\d*$/.test(target) || /[$`*?[\]{}]/.test(target) || /^[-~]/.test(target)) return deny();
    let t = norm(target);
    if (win) t = t.replace(/^\/([A-Za-z])(?=$|\/)/, "$1:");
    // drive-relative (`C:x`, `D:`; an unquoted `C:\x` loses its backslashes in bash): cwd unknown
    if (win && /^[A-Za-z]:(?![\\/])/.test(t)) return deny();
    const push = verb === "pushd" || verb === "push-location";
    if (loop && (push || !p.isAbsolute(t))) return deny();
    const next = new Set<string>();
    let sure = true;
    for (const c of cur) {
      const abs = p.resolve(c, t);
      const real = realDeep(abs, p, fsx) ?? abs;
      if (!inside(abs) || !inside(real)) return deny();
      next.add(real);
      // a missing directory (`mkdir -p build && cd build`) may exist by then, or the cd fails
      if (!fsx.isDir(real)) {
        if (sep === "&&") revive.add(c);
        else next.add(c);
        sure = false;
      }
    }
    if (push) stack.push({ set: cur, sure });
    cur = next;
  }
  return null;
}

export function checkShell(rules: OverlayRules, rawCommand: string, ctx0: MatchCtx): Decision | null {
  const shell = ctx0.shell ?? "posix";
  const command = rawCommand;
  const bound = boundNames(command, shell);
  const ctx: MatchCtx = { ...ctx0, ...(ctx0.owned || !rules.owned ? {} : { owned: rules.owned }), bound };
  // a line that binds a harness-trusted variable it also uses (`HOME=-i; sed $HOME ...`, `read HOME; cat ~/x`) fails closed
  for (const n of ["HOME", "FOREMAN_SCRATCH", "USERPROFILE"]) {
    if (bound.has(n) && (new RegExp(`(?:^|[^\\w$-])${n}(?:\\[[^\\]]*\\])?\\+?=|\\$\\{?(?:env:)?\\{?${n}(?![A-Za-z0-9_])`, "i").test(command) || (n === "HOME" && /(?<![\w])~/.test(command)))) {
      return { kind: "deny", reason: `pi-foreman: denied by the permission policy (the line binds ${n} and uses it; a rebound ${n} is never trusted as a path). Use the literal path.` };
    }
  }
  // `~-` ($OLDPWD), `~+` ($PWD), `~user` (a home dir) expand to paths this check never resolves: never read as cwd-relative names
  if (shell === "posix") {
    const tw = parseShell(command, "posix").pipelines.flat(2).find((w) => /(?:^|[=:{,])~[^/\\,}:\s]/.test(w));
    if (tw !== undefined) return { kind: "deny", reason: `pi-foreman: denied by the permission policy ('${clip(tw)}' is a ~-, ~+ or ~user path this check does not resolve). Use the literal path.` };
  }
  if (ctx.role === "child") {
    const cd = childCdDeny(command, ctx);
    if (cd) return cd;
    const sw = childStdinWriteDeny(command);
    if (sw) return sw;
  }
  const scratch0 = scratchOf(ctx);
  const c: Collected = { vars: { ...(scratch0 ? { FOREMAN_SCRATCH: scratch0 } : {}), ...(ctx.cwd ? { PWD: ctx.cwd } : {}) }, bound, boundRefs: [], unitTexts: [], pipeTexts: [command.trim(), command.trim().replace(/\s+/g, " ")], words: [], removeWords: [], protWords: [], proseSkip: [], pure: true, ro: true, rdr: true, writeTargets: new Set(), tmpTargets: new Set(), roTargets: new Set(), worktreeRemoveWords: new Set(), probeFiles: [], readCode: new Set(), ...(ctx.cwd && shell === "posix" && ctx.platform !== "win32" ? { cdBase: { cwd: ctx.cwd, realpath: defaults(ctx).realpath, isDir: defaults(ctx).isDir } } : {}) };
  collect(command, shell, 0, c);
  if (ctx.platform === "win32" && shell === "posix") {
    // native paths in a bash command (`cat C:\Users\x\.ssh\id`): lex again with `\` kept literal
    const raw: Collected = { unitTexts: [], pipeTexts: [], words: [], removeWords: [], protWords: [], proseSkip: [], pure: true, ro: true, rdr: true, writeTargets: new Set() };
    collect(command, "powershell", 0, raw);
    c.words.push(...raw.words);
    c.removeWords!.push(...raw.removeWords!);
    c.protWords!.push(...raw.protWords!);
    c.proseSkip!.push(...raw.proseSkip!);
    c.pure = c.pure && raw.pure;
    c.ro = c.ro && raw.ro;
    c.rdr = c.rdr && raw.rdr;
    raw.writeTargets!.forEach((x) => c.writeTargets!.add(x));
  }
  // `$S` bound on the line and not resolved by the grammar: expandWord no longer trusts it, so it fails closed
  if (scratch0 && c.boundRefs!.length) {
    return { kind: "deny", reason: `pi-foreman: denied by the permission policy ('${clip(c.boundRefs![0])}' uses a variable this line rebinds; only an unbound $S / $FOREMAN_SCRATCH names your scratch dir). Use the literal path or S=$FOREMAN_SCRATCH alone.` };
  }
  // a child's write target through any variable the line binds but the grammar left unresolved (`S=/x; echo y | tee $S/f`) fails closed
  if (ctx.role === "child") {
    const t = [...c.writeTargets!, ...c.tmpTargets!, ...c.roTargets!].find((w) => refsBound(w, bound));
    if (t !== undefined) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (write target '${clip(t)}' uses a variable this line binds, and the line is outside the resolvable grammar). Use the literal path.` };
  }
  if (ctx.role === "child" && c.worktreeOp !== undefined) {
    return { kind: "deny", reason: `pi-foreman: denied by the permission policy (git worktree ${clip(c.worktreeOp)} is the foreman's; children may only list worktrees). Ask the foreman.` };
  }
  if (ctx.role === "child" && c.childAsk !== undefined) {
    return { kind: "ask", reason: `pi-foreman: ${c.childAsk} needs approval for a child (it writes the project or the network; the foreman may run it).` };
  }
  const words = [...new Set(c.words.flatMap((w) => [w, ...expandBraces(w)]))];
  // Write protection sees path arguments only: pattern/script operands drop out when no unit can turn
  // text into a path (no substitution, process substitution or non-pure command), and bash words
  // follow bash globbing (item 4: `grep "x\|register\b" *.go` named /app/.git/... before).
  const pure = c.pure === true && !/\$\(|`|[<>]\(/.test(command);
  // Only read-only verbs, no write redirect anywhere (any target: a literal, `$f`, a quoted loop variable), no PowerShell: write-only protect rules do not fire.
  // A protected path in an assignment (`f=...`) or a `for`/`select`/`case` word list stays scanned; without a write redirect nothing writes to it.
  const strictRead = pure && c.ro === true && c.rdr === true && shell === "posix" && c.writeTargets!.size === 0;
  // Reads below an owned root (a `*` rule, ctx.readable) need no pure viewer pipeline: every unit is a known reader or a read-only git/test run,
  // nothing writes (no redirect target, no write verb, no unknown command, nothing removed) and nothing builds a path at run time.
  const ownedReadOk = !strictRead && !/\$\(|`|[<>]\(/.test(command) && shell === "posix" && c.ro === true && c.roRun !== true && c.roUnknown === undefined && c.roDeny === undefined && c.roTargets!.size === 0 && c.tmpTargets!.size === 0 && c.writeTargets!.size === 0 && c.removeWords!.length === 0 && c.worktreeOp === undefined;
  const readOnly = strictRead;
  // `--exclude-dir=.git` names a path to leave out, never one to write: only a redirect target keeps such a word
  // the read-only python exemption holds only when the whole command is that one invocation: nothing else on the line may use the words
  const soloPython = /^\s*(?:[\w./-]*python[\w.]*)(?:\s+-[A-Za-z]+)*\s*$/.test(command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ""));
  const notFilter = (w: string): boolean => (!FILTER_OPT.test(w) && !(ctx.role === "child" && soloPython && c.readCode!.has(w))) || c.writeTargets!.has(w) || !!c.tmpTargets?.has(w);
  const pwords = (pure ? [...new Set(c.protWords!.flatMap((w) => [w, ...expandBraces(w)]))] : words).filter(notFilter);
  const pctx: MatchCtx = shell === "posix" ? { ...ctx, bashWords: true, dotGlob: /dotglob|globignore|glob_?dots/i.test(command) } : ctx;
  const removed = new Set(c.removeWords!.flatMap((w) => [w, ...expandBraces(w)]));
  const texts = [...c.unitTexts, ...c.pipeTexts];
  for (const pat of rules.bashDeny) {
    if (texts.some((t) => bashMatches(pat, t, ctx))) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (command rule '${pat}'). This cannot be approved; use another way.` };
  }
  const targets = new Set([...c.writeTargets!, ...(c.tmpTargets ?? []), ...(c.roTargets ?? [])].flatMap((t) => [t, ...expandBraces(t)]));
  // Fail closed: a word with white space is prose only as the value of a known prose option, decided by word position;
  // never for a path tool or a pure read (its words are operands).
  // by position: a string that also occurs outside a prose-option position (`-m "/a b/f" -F "/a b/f"`) is no prose
  const operands = new Map<string, number>();
  for (const w of c.words) operands.set(w, (operands.get(w) ?? 0) + 1);
  for (const w of c.proseSkip!) operands.set(w, (operands.get(w) ?? 0) - 1);
  const proseVals = new Set([...operands].filter(([, n]) => n <= 0).flatMap(([w]) => [w, ...expandBraces(w)]));
  for (const w of words) {
    const hit = pathDeny(rules.pathRules, w, ctx, readOnly || ownedReadOk, !targets.has(w) && proseVals.has(w));
    if (hit) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (path rule '${hit.pattern}' matched '${clip(w)}'). Secret and policy paths are off limits to the agent, also through shell commands.` };
  }
  if (ctx.role === "child") {
    for (const w of pwords) {
      if (c.worktreeRemoveWords!.has(w)) continue;
      const hit = childBlockHit(rules, w, pctx, readOnly || ownedReadOk);
      if (hit) return childBlockDecision(hit, w);
    }
  }
  if (ctx.role === "child") {
    for (const w of c.tmpTargets!) {
      const hit = childReadOnlyWriteDeny(w, pctx) ?? childTmpWriteDeny(w, pctx);
      if (hit) return hit;
    }
  }
  if (ctx.role === "child" && c.probeFiles?.length) {
    const hit = probeFileDeny(c.probeFiles, pctx);
    if (hit) return hit;
  }
  if (ctx.role === "child" && ctx.roundReadRoots?.length) {
    for (const w of c.roTargets!) {
      const hit = childReadOnlyWriteDeny(w, pctx);
      if (hit) return hit;
    }
    if (c.roUnknown !== undefined && !childCwdReadOnly(pctx)) {
      for (const w of c.roUnknownWords ?? []) {
        const hit = childReadOnlyWriteDeny(w, pctx);
        if (hit) return hit;
      }
    }
    if (c.roDeny !== undefined && !pctx.roundRoots?.length) {
      return { kind: "deny", reason: `pi-foreman: '${clip(c.roDeny)}' in a write form is denied for a read-only child (also with --global, --system or --file, from any directory). Read forms (--get, --list, <key>) are allowed.` };
    }
    if (c.roRun && childCwdReadOnly(pctx)) {
      const bad = roRunRefusal(c, command, pctx);
      if (bad) return { kind: "deny", reason: `pi-foreman: this run is denied for a child: ${bad}. The round worktree is read-only except for its builder; a test run or repo script there must not change directory or environment (cd, pushd, env, VAR=...) and a script must be git-tracked inside the round worktree.` };
    }
    if (c.roUnknown !== undefined && childCwdReadOnly(pctx)) {
      return { kind: "deny", reason: `pi-foreman: '${clip(c.roUnknown)}' denied for a child: the round worktree is read-only except for its builder, and this command is neither a known reader nor a test run, so it may write there. Use a read command or ask the foreman.` };
    }
  }
  const prot = pwords.map((w) => ({ w, hit: protectHit(rules.protect, w, pctx, true, removed.has(w), readOnly) })).filter((x) => x.hit);
  const pd = prot.find((x) => x.hit!.kind === "deny");
  if (pd) return protectDecision(pd.hit!, pd.w, "shell command");
  for (const pat of rules.bashAsk) {
    if (texts.some((t) => bashMatches(pat, t, ctx))) return { kind: "ask", reason: `pi-foreman: this command needs approval (project/session rule '${pat}').` };
  }
  for (const w of words) {
    const pat = pathAskHit(rules.pathAsk, w, ctx);
    if (pat) return { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(w)}').` };
  }
  if (prot.length) return protectDecision(prot[0].hit!, prot[0].w, "shell command");
  return null;
}

/** The strictest write-protection decision for one path word (deny before ask), or null. */
function protectHit(rules: ProtectRule[], word: string, ctx: MatchCtx, shell: boolean, remove = false, readOnly = false): ProtectHit | null {
  const child = ctx.role === "child";
  let ask: ProtectHit | null = null;
  const cands = pathCandidates(word, ctx);
  const guessed = ctx.platform === "win32" ? shortNameVariants(cands, rules.map((r) => r.pattern)) : [];
  // the foreman's own roots (owned.ts): its writeAsk rules (the package root) do not ask below them, except the handoff files `parent`/`child`
  const owned = !child && ctx.owned?.readWrite.length ? ctx.owned.readWrite : [];
  const inOwned = (x: string): boolean => owned.some((o) => insideDir(o, x, ctx));
  for (const r of rules) {
    if (r.removeOnly && !remove) continue;
    if (readOnly && r.readOk === (child ? "child" : "main")) continue;
    if (r.fromWriteAsk && owned.length && !r.pattern.includes("/handoffs/") && cands.length && cands.every(inOwned)) continue;
    if (shell && !r.shell && !(child && r.childShell)) continue;
    const kind = child ? r.child : r.main;
    if (!kind || (kind === "ask" && ask && !ask.shortName)) continue;
    const exact = cands.some((x) => pathMatches(r.pattern, x, ctx));
    if (!exact && !guessed.some((x) => pathMatches(r.pattern, x, ctx))) continue;
    if (kind === "deny") return { kind, rule: r, shortName: !exact };
    if (!ask || (ask.shortName && exact)) ask = { kind, rule: r, shortName: !exact };
  }
  return ask;
}

/** True when `p` is `dir` or below it (lexical, case folded where the file system is). */
function insideDir(dir: string, p: string, ctx: MatchCtx): boolean {
  const win = ctx.platform === "win32";
  const pp = win ? path.win32 : path.posix;
  const fold = (x: string): string => (foldsCase(ctx.platform) ? x.toLowerCase() : x);
  const rel = pp.relative(fold(pp.resolve(dir)), fold(pp.resolve(p)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + pp.sep) && !pp.isAbsolute(rel));
}

/** The temp roots a child may not write below: realpath(os.tmpdir()) and /tmp (not on win32). */
function tmpRoots(ctx: MatchCtx): string[] {
  const fsx = defaults(ctx);
  const raw = [os.tmpdir(), ...(ctx.platform === "win32" ? [] : ["/tmp"])];
  return [...new Set(raw.flatMap((r) => [r, fsx.realpath(r)]).filter((x): x is string => !!x))];
}

/**
 * Child with a bound scratch dir: a write below the temp dir or /tmp outside that scratch and the child's own
 * workspace is denied (not asked), naming FOREMAN_SCRATCH. The foreman's own /tmp rules are unchanged.
 */
function childTmpWriteDeny(word: string, ctx: MatchCtx): Decision | null {
  const scratch = scratchOf(ctx);
  if (ctx.role !== "child" || !scratch) return null;
  const roots = tmpRoots(ctx);
  const own = [scratch, ctx.cwd, workspaceOf(ctx.cwd).root, ...(ctx.roundRoots ?? [])];
  for (const cand of pathCandidates(word, ctx)) {
    if (!roots.some((r) => insideDir(r, cand, ctx))) continue;
    if (own.some((o) => insideDir(o, cand, ctx))) continue;
    return { kind: "deny", reason: `pi-foreman: write to ${clip(word)} denied for a child: use FOREMAN_SCRATCH (${scratch}), not /tmp.` };
  }
  return null;
}

/** A child writing below a round worktree it may only read (reviewer, explorer, ... in the round worktree; any child in an isolation worktree). */
function childReadOnlyWriteDeny(word: string, ctx: MatchCtx): Decision | null {
  if (ctx.role !== "child" || !ctx.roundReadRoots?.length) return null;
  const scratch = scratchOf(ctx);
  for (const cand of pathCandidates(word, ctx)) {
    if (scratch && insideDir(scratch, cand, ctx)) continue;
    if ((ctx.roundRoots ?? []).some((o) => insideDir(o, cand, ctx))) continue;
    if (ctx.roundReadRoots.some((o) => insideDir(o, cand, ctx))) return { kind: "deny", reason: `pi-foreman: write to ${clip(word)} denied for a child: the round worktree is read-only except for its builder.` };
  }
  return null;
}

/** Why a test/script run by a read-only child is refused: cd/env in the line, or a script that is not a git-tracked file whose realpath lies in the round worktree. */
function roRunRefusal(c: Collected, command: string, ctx: MatchCtx): string | null {
  if (c.roCdEnv || /(^|[;&|(){\n`]|\$\()\s*(builtin\s+|command\s+)?(cd|pushd|env|export)(\s|$)|(^|[;&|(){\n`]|\$\()\s*[A-Za-z_][A-Za-z0-9_]*=|\benv\s/.test(command)) return "cd, pushd, env or an environment assignment in the line";
  if (command.includes("`")) return "a backtick command substitution in the line (its output cannot be checked)";
  const scripts = [...(c.roScripts ?? []), ...(c.roOperands ?? [])];
  if (!scripts.length) return null;
  const fsx = defaults(ctx);
  const cwd = ctx.cwd ? fsx.realpath(ctx.cwd) : undefined;
  const root = cwd ? (ctx.roundReadRoots ?? []).map((o) => fsx.realpath(o)).find((o): o is string => !!o && insideDir(o, cwd, ctx)) : undefined;
  if (!cwd || !root) return "the script's worktree cannot be resolved";
  const tracked = new Map<string, boolean>();
  const trackedIn = (rel: string): boolean => {
    let ok = tracked.get(rel);
    if (ok === undefined) {
      ok = rel === "" || gitTracked(root, rel);
      tracked.set(rel, ok);
    }
    return ok;
  };
  for (let s0 of scripts) {
    // a dotted unittest module (`\0a.b.C`) is its longest prefix that is a tracked .py file
    if (s0.startsWith("\x01")) return `option '${clip(s0.slice(1))}' is not an allowed make option`;
    // a word with `$`, a backtick or a leading `~` is expanded (known variables, `~`) and checked as a path; one that cannot be expanded is refused
    const raw0 = s0.startsWith("\x02") ? s0.slice(1) : s0;
    if (!s0.startsWith("\0") && /[$`]|^~/.test(raw0)) {
      const ex = expandWord(raw0, ctx);
      if (/[$`]|^~/.test(ex)) return `operand '${clip(raw0)}' cannot be expanded; a read-only child may run only git-tracked paths inside the round worktree`;
      s0 = ex;
    }
    // `\x02`: a bare word, a path only when it names an existing file or directory
    const optional = s0.startsWith("\x02");
    if (optional && !fsx.realpath(path.resolve(cwd, s0.slice(1)))) continue;
    // a glob the runner expands: every file it matches must be tracked inside the worktree (`**` is not followed)
    const globbed = s0.slice(optional ? 1 : 0);
    if (!optional && GLOB.test(globbed) && !/[$`\\{]|^[/~]|(^|\/)\.\.(\/|$)|\*\*/.test(globbed)) {
      const hits = expandGlob(path.resolve(cwd, globbed), path.posix, fsx, { ...ctx, bashWords: true });
      for (const h of hits) {
        const real = fsx.realpath(h);
        if (!real || !insideDir(root, real, ctx)) return `script or operand '${clip(globbed)}' matches '${clip(h)}', which does not resolve inside the round worktree`;
        if (fsx.isDir(real)) continue;
        if (!trackedIn(path.relative(root, real))) return `script or operand '${clip(globbed)}' matches '${clip(path.relative(root, real))}', which is not tracked by git`;
      }
      continue;
    }
    const dotted = s0.startsWith("\0");
    const s = dotted ? s0.slice(1) : optional ? s0.slice(1) : s0;
    const parts = s.split(".");
    const cands = dotted ? parts.map((_, k) => `${parts.slice(0, k + 1).join("/")}.py`).reverse() : [s];
    let why: string | null = null;
    for (const cand of cands) {
      const real = fsx.realpath(path.resolve(cwd, cand));
      if (!real || !insideDir(root, real, ctx)) why = `'${clip(s)}' does not resolve inside the round worktree`;
      else if (!trackedIn(path.relative(root, real))) why = `'${clip(s)}' is not tracked by git`;
      else {
        why = null;
        break;
      }
    }
    if (why) return `script or operand ${why}`;
  }
  return null;
}

const PROBE_RUNNERS = new Set(["node", "python", "python3", "bash", "sh", "npx", "tsx", "ts-node"]);

/**
 * Every word of a node/python/bash/sh/npx command that can name a file it runs or loads: each argument, the value after `=` of an option and
 * the rest of a short-option group. No option table is consulted (an unlisted value-taking flag cannot hide the script); probeFileDeny reads
 * the words that resolve to an existing file outside git, and ignores the rest.
 */
function probeScripts(verb: string, args: string[]): string[] {
  if (!PROBE_RUNNERS.has(verb)) return [];
  const inline = verb === "node" || verb === "tsx" || verb === "ts-node" ? /^(-e|-p|--eval|--print)$/ : verb === "python" || verb === "python3" ? /^(-c|-m)$/ : /^(-c|--call)$/;
  const out: string[] = [];
  for (const a of args) {
    if (inline.test(a) && verb !== "npx") {
      // `python -m pkg` runs pkg/__main__.py: the package (or dotted path) is a candidate directory / file
      const mod = a === "-m" ? args[args.indexOf(a) + 1] : undefined;
      if (mod && /^[A-Za-z_][\w.]*$/.test(mod)) out.push(mod.replace(/\./g, "/"), `${mod.replace(/\./g, "/")}.py`);
      return out;
    }
    if (a === "") continue;
    out.push(a);
    if (a.startsWith("-")) {
      if (a.includes("=")) out.push(a.slice(a.indexOf("=") + 1));
      if (a[1] !== "-" && a.length > 2) out.push(a.slice(2));
    }
  }
  return out;
}

/** A script outside git (scratch, tmp, an untracked file) that spells a guarded token from pieces is not run, in any child role. Files of a round worktree that are tracked and unmodified against HEAD are not read. */
function probeFileDeny(files: string[], ctx: MatchCtx): Decision | null {
  const fsx = defaults(ctx);
  const roots = [...(ctx.roundRoots ?? []), ...(ctx.roundReadRoots ?? [])].map((r) => fsx.realpath(r)).filter((x): x is string => !!x);
  for (const w of files) {
    const word = expandWord(w, ctx);
    if (/[$`*?[\]{}]/.test(word)) continue;
    const real = fsx.realpath(path.resolve(ctx.cwd ?? ".", word));
    if (!real) continue;
    const root = roots.find((o) => insideDir(o, real, ctx));
    if (root && real === root && fsx.isDir(real)) continue; // a bare `node --test` / `node --test .` runs unscanned (CHANGELOG, Known gaps)
    if (root && !fsx.isDir(real) && gitCleanTracked(root, path.relative(root, real))) continue;
    if (fsx.isDir(real)) {
      // inside a round root: each modified or untracked file below the directory is scanned like a single file; elsewhere a directory runs its index.js / package.json main / __main__.py unscanned
      if (!root) return { kind: "deny", reason: `pi-foreman: '${clip(w)}' denied for a child: it runs an untracked directory (outside the round worktree or not tracked by git); run a git-tracked file instead.` };
      for (const rel of changedFiles(root, path.relative(root, real))) {
        const hit = probeFileScan(path.join(root, rel), w);
        if (hit) return hit;
      }
      continue;
    }
    const hit = probeFileScan(real, w);
    if (hit) return hit;
  }
  return null;
}

/** The deny for one script file that reassembles a guarded token, or null (unreadable, too large and non-files pass). */
function probeFileScan(real: string, shown: string): Decision | null {
  let text: string;
  try {
    if (!fs.statSync(real).isFile() || fs.statSync(real).size > 2_000_000) return null;
    text = fs.readFileSync(real, "utf8");
  } catch {
    return null;
  }
  return probeFileHit(text) ? { kind: "deny", reason: `pi-foreman: '${clip(shown)}' denied for a child: the script spells a guarded token from pieces (split literal reassembles a guarded token). No split, concatenated or encoded guarded tokens; a probe that needs one runs through the test suite's fixtures.` } : null;
}

/** Files below `rel` of worktree `root` that are modified (worktree or index, against HEAD) or untracked and not ignored. */
function changedFiles(root: string, rel: string): string[] {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  const list = (args: string[]): string[] => {
    const r = spawnSync("git", ["-C", root, ...args, "--", rel === "" ? "." : rel], { env, timeout: 10000, encoding: "utf8", maxBuffer: 8_000_000 });
    return r.status === 0 ? r.stdout.split("\0").filter(Boolean) : [];
  };
  return [...new Set([...list(["ls-files", "-z", "-m", "-o", "--exclude-standard"]), ...list(["diff", "-z", "--name-only", "HEAD"])])].slice(0, 500);
}

/** Tracked in HEAD and equal to HEAD in the index and the worktree (a staged or modified file is not). */
function gitCleanTracked(root: string, rel: string): boolean {
  if (!gitTracked(root, rel)) return false;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return spawnSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", rel], { stdio: "ignore", env, timeout: 10000 }).status === 0;
}

/** `git ls-files --error-unmatch` of one path from the worktree root (false on any failure). */
function gitTracked(root: string, rel: string): boolean {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel], { stdio: "ignore", env, timeout: 10000 }).status === 0;
}

/** The child's cwd lies in a worktree it may only read (and in none it may write, nor in its scratch dir). */
function childCwdReadOnly(ctx: MatchCtx): boolean {
  const scratch = scratchOf(ctx);
  if (!ctx.cwd || (scratch && insideDir(scratch, ctx.cwd, ctx))) return false;
  if ((ctx.roundRoots ?? []).some((o) => insideDir(o, ctx.cwd, ctx))) return false;
  return (ctx.roundReadRoots ?? []).some((o) => insideDir(o, ctx.cwd, ctx));
}

/** A child touching a foreman-owned path (handoffs, artifacts, foreman.json); its own scratch dir is never one. */
function childBlockHit(rules: OverlayRules, word: string, ctx: MatchCtx, readOnly = false): string | null {
  const patterns = rules.childBlock;
  if (!patterns?.length || ctx.role !== "child") return null;
  const scratch = scratchOf(ctx);
  const pp = ctx.platform === "win32" ? path.win32 : path.posix;
  for (const cand of pathCandidates(word, ctx)) {
    // the spelling as written (`../<repo>.worktrees/<round>/x`) is relative: the exemptions look at where it points
    const abs = pp.isAbsolute(cand) ? cand : pp.resolve(ctx.cwd, cand);
    if (scratch && insideDir(scratch, abs, ctx)) continue;
    if (readOnly && ctx.readable?.some((pat) => pathMatches(pat, abs, ctx))) continue;
    if (rules.childBlockExcept?.some((pat) => pathMatches(pat, cand, ctx))) continue;
    for (const pat of patterns) {
      if (!pathMatches(pat, cand, ctx)) continue;
      if (rules.childBlockInWorkspace?.includes(pat) && [ctx.cwd, workspaceOf(ctx.cwd).root, ...(ctx.roundRoots ?? []), ...(ctx.roundReadRoots ?? [])].some((root) => insideDir(root, abs, ctx))) continue;
      return pat;
    }
  }
  return null;
}

function childBlockDecision(pattern: string, word: string): Decision {
  return { kind: "deny", reason: `pi-foreman: denied by the permission policy (path rule '${pattern}' matched '${clip(word)}'). The foreman's handoff, artifact and configuration paths are not for subagents; ask the foreman.` };
}

/** Whether a path falls under any write-protection rule (either session kind); foreman_wait's file bound (A4). */
export function isProtectedPath(rules: OverlayRules, p: string, ctx: MatchCtx): boolean {
  return protectHit(rules.protect, p, { ...ctx, role: "child" }, false) !== null;
}

interface ProtectHit {
  kind: "deny" | "ask";
  rule: ProtectRule;
  /** Matched only when an 8.3 short-name segment is read as the protected name (win32). */
  shortName: boolean;
}

function protectDecision(hit: ProtectHit, word: string, what: string): Decision {
  const how = hit.shortName ? `matched '${clip(word)}' read as a Windows 8.3 short name, which may be the protected path,` : `matched '${clip(word)}'`;
  return hit.kind === "deny"
    ? { kind: "deny", reason: `pi-foreman: denied by the write protection (rule '${hit.rule.pattern}' ${how} in a ${what}). Git internals, agent and harness configuration are off limits${hit.rule.main === "ask" ? " to subagents; ask the foreman" : ""}.` }
    : { kind: "ask", reason: `pi-foreman: this changes protected configuration (rule '${hit.rule.pattern}' ${how} in a ${what}) and needs approval.` };
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "foreman_move", "foreman_copy", "git_log", "git_diff_stat"]);

export function isOverlayTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "powershell" || toolName === "foreman_bg" || toolName === "bg_run" || PATH_TOOLS.has(toolName);
}

/** The paths one file-tool call touches; `write` = it creates, changes or removes that path; `remove` = it removes or renames it. */
function toolPaths(toolName: string, input: Record<string, unknown>): { value: string; write: boolean; remove?: boolean }[] {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const out: { value: string; write: boolean; remove?: boolean }[] = [];
  const push = (v: unknown, write: boolean, remove = false): void => {
    const s = str(v);
    if (s !== undefined) out.push({ value: s, write, remove });
  };
  if (toolName === "foreman_move" || toolName === "foreman_copy") {
    push(input.src, toolName === "foreman_move", toolName === "foreman_move");
    push(input.dst, true);
    return out;
  }
  const write = toolName === "write" || toolName === "edit";
  for (const v of [input.path, input.file_path, input.filePath]) push(v, write);
  // grep's glob and find's pattern select files below `path`: check them joined to it
  const glob = toolName === "grep" ? str(input.glob) : toolName === "find" ? str(input.pattern) : undefined;
  if (glob !== undefined) push(/^([\\/~$]|[A-Za-z]:)/.test(glob) ? glob : `${(str(input.path) ?? ".").replace(/[\\/]+$/, "")}/${glob}`, false);
  return out;
}

export function checkPathTool(rules: OverlayRules, toolName: string, input: Record<string, unknown>, ctx0: MatchCtx): Decision | null {
  if (!PATH_TOOLS.has(toolName)) return null;
  const ctx: MatchCtx = ctx0.owned || !rules.owned ? ctx0 : { ...ctx0, owned: rules.owned };
  const paths = toolPaths(toolName, input);
  for (const { value, write } of paths) {
    const hit = pathDeny(rules.pathRules, value, ctx, !write, false);
    if (hit) return { kind: "deny", reason: `pi-foreman: denied by the permission policy (path rule '${hit.pattern}' matched '${clip(value)}' for ${toolName}).` };
    const blocked = childBlockHit(rules, value, ctx, !write);
    if (blocked) return childBlockDecision(blocked, value);
  }
  for (const { value } of paths.filter((x) => x.write)) {
    const hit = childReadOnlyWriteDeny(value, ctx) ?? childTmpWriteDeny(value, ctx);
    if (hit) return hit;
  }
  const prot = paths.filter((x) => x.write).map((x) => ({ w: x.value, hit: protectHit(rules.protect, x.value, ctx, false, x.remove === true) })).filter((x) => x.hit);
  const pd = prot.find((x) => x.hit!.kind === "deny");
  if (pd) return protectDecision(pd.hit!, pd.w, `${toolName} call`);
  for (const { value } of paths) {
    const pat = pathAskHit(rules.pathAsk, value, ctx);
    if (pat) return { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(value)}').` };
  }
  return prot.length ? protectDecision(prot[0].hit!, prot[0].w, `${toolName} call`) : null;
}

export function checkToolCall(rules: OverlayRules, toolName: string, input: Record<string, unknown>, ctx: MatchCtx): Decision | null {
  if (toolName === "bash" || toolName === "powershell" || toolName === "foreman_bg" || toolName === "bg_run") {
    const command = typeof input.command === "string" ? input.command : "";
    return command ? checkShell(rules, command, { ...ctx, shell: toolName === "powershell" ? "powershell" : "posix" }) : null;
  }
  return checkPathTool(rules, toolName, input, ctx);
}

export interface AskEnv {
  isChild: boolean;
  mode: string;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}

/** deny -> block; ask -> confirm in TUI/RPC, block in print/json mode and in children. */
export async function resolveDecision(d: Decision | null, ask: AskEnv): Promise<{ block: true; reason: string } | undefined> {
  if (!d) return undefined;
  if (d.kind === "deny") return { block: true, reason: d.reason };
  if (ask.isChild) return { block: true, reason: `${d.reason} Needs approval: ask the foreman (project/session asks are not forwarded from children).` };
  if ((ask.mode === "tui" || ask.mode === "rpc") && ask.hasUI && ask.confirm) {
    let ok = false;
    try {
      ok = await ask.confirm("pi-foreman: approval needed", d.reason);
    } catch {
      ok = false;
    }
    return ok ? undefined : { block: true, reason: `Denied by the user. ${d.reason}` };
  }
  return { block: true, reason: `${d.reason} Needs approval, no UI (mode: ${ask.mode}).` };
}

/** Message for a session that could not load the baseline: shell and file tools are blocked. */
export const OVERLAY_UNAVAILABLE = "pi-foreman: the permission baseline (config/permissions.baseline.json) could not be read, so shell and file tools are blocked. Reinstall pi-foreman and run /foreman doctor.";
