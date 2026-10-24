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
import { gitProtectedRead } from "./effects.ts";
import { netReadCommand } from "./netread.ts";

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
  /** Comes from protect.childDeny (MatchCtx.skillDirs lifts the `.agents` ones for a read of a named skill). */
  fromChildDeny?: boolean;
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
  /**
   * Toolchain probe dirs (baseline `externalDirectory.probe`, each dir and its subtree): the permission system read-allows them for every role, the
   * overlay narrows that to pure ls/stat/which shell lines and the ls tool; anything else naming them asks (R10 item 3).
   */
  probeDirs?: string[];
}

export interface Baseline {
  bash: { deny: string[]; ask: string[]; allow?: string[] };
  paths: { deny: string[]; except: string[] };
  protect: { deny: string[]; ask: string[]; childDeny: string[]; writeAsk: string[]; writeAskSelfHost?: string[]; removeAsk?: string[] };
  externalDirectory?: { probe?: string[] };
}

/**
 * `rule` / `path`: what made an ask (the rule pattern, the matched word), for the auto reviewer and its trace (R16 item 1).
 * `selfMod`: a protect rule of kind ask (any protect list or the reviewer rules file) hit a shell write/remove target or a path tool's
 * write path: never auto-reviewed. A protected path that a shell line only reads or mentions is a plain ask (R16 ruling 2).
 * A write into the session's own `{cwd}/.pi/scratch/` is not selfMod (R17): it stays an ordinary ask for the auto reviewer.
 */
export type Decision = { kind: "deny" | "ask"; reason: string; rule?: string; path?: string; selfMod?: true };

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
  /** Child only: the foreman's own checkout (workspace root); `npm install|ci` into its `bench/pi-lock` is pre-allowed (R11 item 10). */
  foremanRoot?: string;
  /** Child only: round worktrees the child may read but not write (roundsurface.ts childSurface); a write below one outside `roundRoots` and the scratch dir is denied. */
  roundReadRoots?: string[];
  exists?: (p: string) => boolean;
  isDir?: (p: string) => boolean;
  realpath?: (p: string) => string | null;
  /** win32 only: realpath that expands 8.3 short names (`RUNNER~1` -> `runneradmin`; default fs.realpathSync.native). Injectable for tests. */
  realpathNative?: (p: string) => string | null;
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
  /** Patterns of the session's own bg_run task dirs (roundsurface.ts ownTaskReadable) and its cwd's `.pi/scratch` (piScratchReadable): a strictly read-only shell command may name them although a protect rule (`{cwd}/.pi/*`) covers `.pi`; a write there stays protected. */
  ownTasks?: string[];
  /**
   * Foreman only: patterns of its own state records, state/usage, its own live and trace file (roundsurface.ts ownUsageReadable). A shell command
   * that is an ownStateRead line (ls/cat/head/tail/wc/stat reads, the python/node read forms, bindings, `cd <worktree> &&`, a
   * `.workflow/scratch/` script) and writes nothing may name them although the protect
   * rule `{agentDir}/pi-foreman/state/*` covers state/; a write there stays protected.
   */
  ownReads?: string[];
  /** Child only: realpaths of the skill dirs (or flat skill files) its role names; a strictly read-only shell word inside them skips the childDeny `.agents` rules only. */
  skillDirs?: string[];
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
    // PowerShell takes an en dash, em dash or horizontal bar (U+2013..U+2015) as a parameter dash (`Get-Process \u2013ov $n`): the line
    // with every one of them read as `-` binds too
    const dashed = command.replace(/[\u2013\u2014\u2015]/g, "-");
    if (dashed !== command) boundNames(dashed, shell).forEach((n) => out.add(n));
    const add = (n: string): void => void out.add(n).add(n.toUpperCase());
    // backtick escapes (`${env:HO`ME}`, `Set-Item env:HO`ME`) vanish before PowerShell reads the name
    const plain = command.replace(/`([^\r\n])/g, "$1");
    // the colon form `-Path:env:HOME` / `-Name: HOME` is also read as `-Path env:HOME` (an extra text: the name regexes only add)
    const colon = (s: string): string => s.replace(/(^|[\s;|({}=])(-[A-Za-z]+):[ \t]*(?=\S)/g, "$1$2 ");
    // a module-qualified cmdlet (`Microsoft.PowerShell.Management\Set-Item`, `Foo\iex`) is also read without its module (an extra text)
    const demod = (s: string): string => s.replace(/(?<![\w$.\\/:-])[A-Za-z][\w.]*\\(?=[A-Za-z])/g, "");
    const texts = [command, plain, colon(command), colon(plain)];
    for (const text of new Set([...texts, ...texts.map(demod)])) {
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
      // (psItemUnsafe: positionals, destinations, pipeline input, abbreviated parameters)
      // every PS_ITEM cmdlet name and short alias anywhere; an English-word alias (`rm`, `copy`, `set`) only in a command position
      // (`$null = rm $p`, `(del $p)`, `; mv a $d`)
      for (const m of text.matchAll(/(?<![\w$.\\/:-])([A-Za-z][\w-]*)(?![\w-])(?=([^;|\n]*))/g)) {
        const word = m[1].toLowerCase();
        if (!PS_ITEM.has(word)) continue;
        if (PS_ITEM_WORDS.has(word) && !/(?:^|[=(;|{}&!\]\n]|\b(?:return|throw|else|do|try|finally)\s)\s*$/i.test(text.slice(0, m.index))) continue;
        const args = m[2].match(/'[^']*'|"[^"]*"|\([^)]*\)?|[^\s(]+/g) ?? [];
        const piped = /(?:^|[^|])\|\s*$/.test(text.slice(0, m.index));
        const literal = (t: string): boolean =>
          !/,\s*$/.test(t) && (/^'[^']*'$/.test(t) || /^"[^"$`]*"$/.test(t) || /^[^$()`+{}'"]+$/.test(t) || /^(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|~)[\\/][^$()`+{}'"]*$/i.test(t));
        if (psItemUnsafe(word, args, piped, literal)) all();
      }
      // common parameters that set a variable (`-OutVariable`, `-ov`, `-ErrorVariable`, .., any unambiguous prefix) on any cmdlet, and
      // `Tee-Object -Variable`: a literal name (`HOME`, `+HOME` appends) binds that name, anything else may name any variable
      const tee = /(?<![\w$.\\/:-])(?:tee-object|tee)(?![\w-])/i.test(text);
      for (const m of text.matchAll(/(?<![\w$-])-([A-Za-z]+)(?![\w-])(?:\s+('[^']*'|"[^"]*"|\([^)]*\)?|[^\s;|)]+))?/g)) {
        const p = m[1].toLowerCase();
        if (!PS_VAR_PARAMS.some(([full, min]) => p.length >= min && full.startsWith(p)) && !(tee && p.length >= 2 && "variable".startsWith(p))) continue;
        const v = (m[2] ?? "").replace(/^'([^']*)'$/, "$1").replace(/^"([^"$`]*)"$/, "$1").replace(/^\+/, "");
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) add(v);
        else all();
      }
      // a property write (`(Get-Variable $n).Value = 1`, `$v = gv $n; $v.Value = 1`, `$_.Value = 1`, `.set_Value(1)`, `% set_Value 1`,
      // `.$m(1)`, `ForEach-Object -MemberName $m`) on what a variable / item getter returns writes the variable / item back: a getter is
      // literal-named only with one literal positional name or one literal -Name / -Path / -LiteralPath value, no wildcard and no other
      // parameter (that name binds through the name-token rule); any other getter (`gv -Scope 0`, `gv -Exclude foo`, `gv`) may reach any variable
      if (psMemberWrite(text)) {
        for (const m of text.matchAll(/(?<![\w$.\\/:-])([A-Za-z][\w-]*)(?![\w-])(?=([^;|)}\n]*))/g)) {
          if (!PS_GETTERS.has(m[1].toLowerCase())) continue;
          if (!psGetterLiteral(m[2].match(/'[^']*'|"[^"]*"|\([^)]*\)?|[^\s(]+/g) ?? [])) all();
        }
      }
      // an alias (`Set-Alias x $c; x $p 1`, `sal`, `New-Alias`, `nal`, `Import-Alias`, `ipal`) or anything on the alias: drive
      // (`New-Item alias:x -Value Set-Item`, `$alias:x = ..`, `Alias::x`) may turn any later word into an item cmdlet
      if (/(?<![\w$.\\/:-])(?:set-alias|sal|new-alias|nal|import-alias|ipal)(?![\w-])/i.test(text) || /(?<![\w-])alias:/i.test(text)) all();
      // anything on the function: drive (`Set-Item function:x $c; x`, `si`, `ni function:x -Value {..}`, `New-Item -Path function: -Name x`,
      // `$function:x = ..`, `${function:x} = ..`, `Function::x`) defines code a later word runs, and `using module ./m.psm1` loads it:
      // like `iex $c` / `Import-Module`, every trusted name may be rebound
      if (/(?<![\w-])function:/i.test(text) || /(?<![\w$.\\/:-])using\s+module(?![\w-])/i.test(text)) all();
      // `Import-LocalizedData -BindingVariable $n` (`-b..`, the `-Variable` alias, `-v..`, or the first positional) sets the variable it
      // names: any non-literal word in the call may name any variable
      for (const m of text.matchAll(/(?<![\w$.\\/:-])import-localizeddata(?![\w-])(?=([^;|\n]*))/gi)) {
        const args = m[1].match(/'[^']*'|"[^"]*"|\([^)]*\)?|[^\s(]+/g) ?? [];
        if (args.some((a) => /[$()`+{}@]/.test(a))) all();
      }
      // a splat on any cmdlet (`Get-Process @p`) may carry one of those parameters
      if (/(?:^|[\s(,;|{=])@[A-Za-z_]\w*/.test(text)) all();
    }
    for (const pipe of parseShell(command, "powershell").pipelines) {
      for (const [u, unit] of pipe.entries()) {
        // `Microsoft.PowerShell.Management\Set-Item` is Set-Item
        const verb = (unit[0] ?? "").toLowerCase().replace(/^[a-z][\w.]*\\(?=[a-z])/, "");
        // `& $sb`, `$cmd args` (not `$x = ..`, not a lone `$_.Value` / `$PSItem.Value` read in a script block)
        const call = /^\$[^=]*$/.test(verb) && !(unit[1] ?? "").startsWith("=") && !(unit.length === 1 && /^\$(?:_|psitem)(?:\.[a-z_]\w*)+$/.test(verb));
        if (PS_EVAL.has(verb) || /\.ps[md]?1$/i.test(verb) || call) all();
        if (PS_ITEM.has(verb)) {
          const args = unit.slice(1);
          if (args.some((a) => /^@[\w{(]/.test(a))) all();
          // a path built at run time may name an env: / variable: item; a file path below `$env:N` / `$HOME` / `~` stays a file path
          const literal = (t: string): boolean =>
            !/,\s*$/.test(t) && (!/[$()`+{}]/.test(t) || /^(?:\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*|\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|~)[\\/][^$()`+{}]*$/i.test(t));
          if (psItemUnsafe(verb, args, u > 0, literal)) all();
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
  // compound-array subscripts (`a=([$y]=1)`, `a=(x [$y]=1)`, `declare -a a=([$y]=1)`)
  for (const m of command.matchAll(/(?:^|[\s(])\[([^\]]*)\]\+?=/g)) bodies.push(m[1]);
  for (const body of dblBrackets(command)) if (/\s-(?:eq|ne|lt|le|gt|ge)\s/.test(body)) bodies.push(body);
  // `${a:off}` / `${a:off:len}` (not `${a:-x}` / `${a:=x}` / `${a:+x}` / `${a:?x}`; `${a: -1}` is one) evaluate off and len as arithmetic,
  // and so does every `x=RHS` / `x+=RHS` once x has the integer attribute: only a plain numeric expression stays benign there
  if (shell === "posix") {
    const strict: string[] = [];
    // special parameters too (`${$:off}`, `${?:off}`, `${-:off}`, `${#:off}`, `${!:off}`); `${#x}` / `${!x}` hold no `:` there
    for (const m of command.matchAll(/\$\{!?(?:[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|[@*$?#!-]|\d+):(?![-=+?])([^}]*)/g)) strict.push(m[1]);
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
 * Whether a PowerShell item cmdlet call (`verb`, an alias or a cmdlet name, and its argument words) may name an item the check cannot
 * see, so that every trusted name may be rebound. Parameters are read in the space and the colon form (`-Path:env:HOME`, `-Path: $p`),
 * comma arrays are one value (psArray), positionals fill the cmdlet's positional slots not bound by name (`Set-Item -Value /x $p`: `$p`
 * is the path). Unsafe when: a splat; no path / name at all; a path, name, `-NewName` / `-Destination` or positional destination that
 * is not `literal`; a parameter name that is not a known full name (`-Pa`, `-Lit`, `-N`: PowerShell takes any unambiguous prefix) while
 * any word is non-literal or input is piped; piped input (`piped`) into Rename-Item / Copy-Item / Move-Item without a destination.
 */
function psItemUnsafe(verb: string, args: string[], piped: boolean, literal: (t: string) => boolean): boolean {
  if (args.some((a) => /^@[\w{(]/.test(a))) return true;
  const slots = PS_SLOTS[PS_ITEM_CMDLET[verb] ?? ""] ?? ["path"];
  const bound = new Set<string>();
  const targets: string[] = [];
  const dests: string[] = [];
  const positional: string[] = [];
  let unknown = false;
  // `--` ends the parameters: it is no value, and every later word is positional (`Set-Item -- $p /x`: `$p` is the path)
  let ended = false;
  for (let k = 0; k < args.length; k++) {
    if (!ended && args[k] === "--") {
      ended = true;
      continue;
    }
    const o = ended ? null : /^-([A-Za-z]\w*)(:)?([\s\S]*)$/.exec(args[k]);
    if (!o) {
      const [v, end] = psArray(args, k, args[k]);
      positional.push(v);
      k = end;
      continue;
    }
    const p = o[1].toLowerCase();
    const value = (): string | undefined => {
      if (o[2] !== undefined && o[3] !== "") {
        const [v, end] = psArray(args, k, o[3]);
        k = end;
        return v;
      }
      if (k + 1 >= args.length) return undefined;
      const [v, end] = psArray(args, k + 1, args[k + 1]);
      k = end;
      return v;
    };
    if (PS_PATH_PARAMS.has(p)) {
      const v = value();
      if (v === undefined) return true;
      const slot = p === "literalpath" || p === "pspath" ? "path" : p;
      bound.add(slot);
      // `-Path env:HOM?` names every matching item; `-LiteralPath` / `-PSPath` expand no wildcard
      if (p !== "literalpath" && p !== "pspath" && PS_WILD.test(v)) return true;
      (slot === "newname" || slot === "destination" ? dests : targets).push(v);
    } else if (PS_VALUE_PARAMS.has(p)) {
      value();
      bound.add(p);
    } else if (PS_SWITCH_PARAMS.has(p)) {
      if (o[2] !== undefined) value();
    } else unknown = true;
  }
  if (unknown) return piped || args.some((a) => !literal(a) || PS_WILD.test(a));
  const open = slots.filter((s) => !bound.has(s));
  let wild = false;
  positional.forEach((v, i) => {
    const slot = open[i] ?? "path";
    if (slot === "value") return;
    bound.add(slot);
    if (PS_WILD.test(v)) wild = true;
    (slot === "newname" || slot === "destination" ? dests : targets).push(v);
  });
  if (wild || targets.length === 0 || ![...targets, ...dests].every(literal)) return true;
  // pipeline input binds every parameter that takes it by property name and is not bound here (`gc f | New-Item -Path env:FOO`: Name)
  if (piped && (PS_PIPE[PS_ITEM_CMDLET[verb] ?? ""] ?? ["path", "name"]).some((s) => !bound.has(s))) return true;
  // pipeline input may bind -NewName / -Destination by property name
  return piped && dests.length === 0 && (PS_SLOTS[PS_ITEM_CMDLET[verb] ?? ""] ?? []).some((s) => s === "newname" || s === "destination");
}

/**
 * A PowerShell line with an en dash, em dash or horizontal bar (U+2013..U+2015) at the start of a word read as the `-` PowerShell takes
 * it for (`Remove-Item \u2013Recurse`, `Set-Item \u2013Path $p`), so parameter, rule and path checks see the parameter.
 */
function psDashes(s: string): string {
  return s.replace(/(?<=(?:^|[\s;|({}=,&!])[-\u2013\u2014\u2015]*)[\u2013\u2014\u2015]/g, "-");
}

/**
 * Whether a PowerShell line writes a property or calls a member on some object: `.X = ..`, `.X[0] += ..`, `.'X' = ..`, `.$m = ..`,
 * `.($m) = ..`, a dynamic member call (`.$m(..)`, `.'set_Value'(..)`), any `set_<Name>` token (`.set_Value(1)`, `% set_Value 1`), and
 * ForEach-Object (`%`, `foreach`) in its member form: a `-MemberName` (any prefix) or positional member that is not one literal name, or
 * a member with any further argument (`% Value 1` sets the property).
 */
function psMemberWrite(text: string): boolean {
  if (/\.\s*(?:[A-Za-z_]\w*|'[^']*'|"[^"]*"|\$\{?\w+\}?|\([^)]*\))\s*(?:\[[^\]]*\]\s*)*[-+*/%]?\?{0,2}=(?!=)/.test(text)) return true;
  if (/\.\s*(?:'[^']*'|"[^"]*"|\$\{?\w+\}?|\([^)]*\))\s*\(/.test(text)) return true;
  if (/(?<![\w$-])set_\w/i.test(text)) return true;
  for (const m of text.matchAll(/(?<![\w$.\\/:-])(?:%|foreach|foreach-object)(?![\w-])(?=([^;|\n]*))/gi)) {
    const args = (m[1].match(/'[^']*'|"[^"]*"|\([^)]*\)?|[^\s(]+/g) ?? []).filter((a) => !/^[)}]+$/.test(a));
    if (args.length === 0 || args[0].startsWith("{")) continue;
    const lit = (t: string | undefined): boolean => t !== undefined && /^\w+$/.test(t.replace(/^'(\w+)'$|^"(\w+)"$/, "$1$2"));
    const o = /^-([A-Za-z]+)(?::([\s\S]*))?$/.exec(args[0]);
    if (!o) {
      if (!lit(args[0]) || args.length > 1) return true;
      continue;
    }
    // `-MemberName` by any prefix (`-m`, `-mem`), its value in the space or the colon form
    const k = args.findIndex((a) => /^-m[a-z]*(?::|$)/i.test(a) && "membername".startsWith(a.slice(1).split(":")[0].toLowerCase()));
    if (k < 0) continue;
    const colon = /^-[A-Za-z]+:([\s\S]+)$/.exec(args[k]);
    const v = colon ? colon[1] : args[k + 1];
    if (!lit(v) || args.length > (colon ? 1 : 2)) return true;
  }
  return false;
}

/**
 * Whether the argument words of a variable / item getter name one literal item: one literal positional name, or one literal `-Name` /
 * `-Path` / `-LiteralPath` value (space or colon form), with no wildcard, no expression and no other parameter.
 */
function psGetterLiteral(args: string[]): boolean {
  const lit = (t: string | undefined): boolean => t !== undefined && /^[^$()`+{}@,'"\s]+$/.test(t.replace(/^'([^']*)'$|^"([^"$`]*)"$/, "$1$2")) && !PS_WILD.test(t);
  if (args.length === 1) {
    const colon = /^-(?:name|path|literalpath):([\s\S]+)$/i.exec(args[0]);
    return colon ? lit(colon[1]) : !args[0].startsWith("-") && lit(args[0]);
  }
  return args.length === 2 && /^-(?:name|path|literalpath)$/i.test(args[0]) && !args[1].startsWith("-") && lit(args[1]);
}

/**
 * A comma array argument (`env:FOO, $p`, `env:FOO ,$p`, `env:FOO , (gc f)`): `first` (the word at `args[k]`) joined with every following
 * word while a comma links them, and the index of the last word taken. A value that still ends in a comma continues on a line this
 * check does not see (the `literal` predicates reject it).
 */
function psArray(args: string[], k: number, first: string): [string, number] {
  let v = first;
  while (k + 1 < args.length && (/,\s*$/.test(v) || args[k + 1].startsWith(","))) v += ` ${args[++k]}`;
  return [v, k];
}

/** The cmdlet behind each PS_ITEM word. */
const PS_ITEM_CMDLET: Record<string, string> = {
  "set-item": "set-item", si: "set-item", "new-item": "new-item", ni: "new-item", "rename-item": "rename-item", rni: "rename-item", ren: "rename-item",
  "copy-item": "copy-item", cpi: "copy-item", copy: "copy-item", cp: "copy-item", "move-item": "move-item", mi: "move-item", move: "move-item", mv: "move-item",
  "clear-item": "clear-item", cli: "clear-item", "remove-item": "remove-item", ri: "remove-item", del: "remove-item", rm: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item",
  "set-variable": "set-variable", sv: "set-variable", set: "set-variable", "new-variable": "new-variable", nv: "new-variable", "clear-variable": "clear-variable", clv: "clear-variable",
  "remove-variable": "remove-variable", rv: "remove-variable", "set-content": "set-content", sc: "set-content", "add-content": "add-content", ac: "add-content",
  "set-itemproperty": "set-itemproperty", sp: "set-itemproperty", "new-itemproperty": "new-itemproperty", "clear-content": "clear-content", clc: "clear-content",
};
/** Positional parameters of each item cmdlet, in position order (`value` is free, `newname` / `destination` a destination, the rest a target). */
const PS_SLOTS: Record<string, string[]> = {
  "set-item": ["path", "value"], "new-item": ["path"], "rename-item": ["path", "newname"], "copy-item": ["path", "destination"], "move-item": ["path", "destination"],
  "clear-item": ["path"], "remove-item": ["path"], "set-variable": ["name", "value"], "new-variable": ["name", "value"], "clear-variable": ["name"], "remove-variable": ["name"],
  "set-content": ["path", "value"], "add-content": ["path", "value"], "set-itemproperty": ["path", "name", "value"], "new-itemproperty": ["path", "name"],
  "clear-content": ["path"],
};
/** The parameters of each item cmdlet that take pipeline input by property name and decide the target (fail closed: a guess counts). */
const PS_PIPE: Record<string, string[]> = {
  "set-item": ["path"], "new-item": ["path", "name"], "rename-item": ["path", "newname"], "copy-item": ["path", "destination"], "move-item": ["path", "destination"],
  "clear-item": ["path"], "remove-item": ["path"], "set-variable": ["name"], "new-variable": ["name"], "clear-variable": ["name"], "remove-variable": ["name"],
  "set-content": ["path"], "add-content": ["path"], "set-itemproperty": ["path", "name"], "new-itemproperty": ["path", "name"], "clear-content": ["path"],
};
/** PowerShell wildcard characters in an item path or name. */
const PS_WILD = /[*?[]/;
/** Full parameter names that name the item or its destination. */
const PS_PATH_PARAMS = new Set(["path", "literalpath", "pspath", "name", "newname", "destination"]);
/** Full names of parameters that take a value which names no item. */
const PS_VALUE_PARAMS = new Set(["value", "itemtype", "type", "encoding", "description", "option", "scope", "visibility", "erroraction", "warningaction", "informationaction"]);
/** Full names of switch parameters (a value only in the colon form, `-Force:$true`). */
const PS_SWITCH_PARAMS = new Set(["force", "passthru", "whatif", "confirm", "recurse", "nonewline", "asbytestream", "container", "verbose", "debug"]);

/** PS_ITEM aliases that are English words (`rm`, `copy`, `set`): counted outside the command word only in a command position. */
const PS_ITEM_WORDS = new Set(["copy", "cp", "move", "mv", "del", "rm", "erase", "rd", "rmdir", "ren", "set"]);
/**
 * Parameters that set a variable, with the length of their shortest prefix PowerShell accepts given only the common parameters (the
 * grammar cannot know a cmdlet's own): `-o` is OutVariable / OutBuffer, `-e` ErrorAction / ErrorVariable, `-w` WarningAction /
 * WarningVariable / WhatIf, `-i` InformationAction / InformationVariable; `-p` alone is PipelineVariable in Windows PowerShell 5.1 on a
 * cmdlet without a P parameter. `-SessionVariable` (Invoke-WebRequest / Invoke-RestMethod) counts on any cmdlet from `-s`.
 * `ov` .. `pv` and `sv` are aliases.
 */
const PS_VAR_PARAMS: [string, number][] = [
  ["outvariable", 4], ["errorvariable", 6], ["warningvariable", 8], ["informationvariable", 12], ["pipelinevariable", 1], ["sessionvariable", 1],
  ["ov", 2], ["ev", 2], ["wv", 2], ["iv", 2], ["pv", 2], ["sv", 2],
];
/** Cmdlets (and aliases) that return PSVariable objects or provider items, whose properties (`.Value`) write the variable / item back. */
const PS_GETTERS = new Set(["get-variable", "gv", "get-item", "gi", "get-childitem", "gci", "ls", "dir"]);

/** PowerShell command words that run code this check never sees. */
const PS_EVAL = new Set(["iex", "invoke-expression", ".", "&", "import-module", "ipmo", "invoke-command", "icm", "start-job", "sajb", "invoke-item", "ii", "powershell", "pwsh", "powershell.exe", "pwsh.exe"]);
/** PowerShell item cmdlets whose path may be an env: / variable: drive item. */
const PS_ITEM = new Set(["set-item", "si", "new-item", "ni", "rename-item", "rni", "copy-item", "cpi", "copy", "cp", "move-item", "mi", "move", "mv", "clear-item", "cli", "remove-item", "ri", "del", "rm", "erase", "set-variable", "sv", "set", "new-variable", "nv", "clear-variable", "clv", "remove-variable", "rv", "set-content", "sc", "add-content", "ac", "set-itemproperty", "sp", "new-itemproperty", "ren", "rd", "rmdir", "clear-content", "clc"]);
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
  for (const n of [...names, ...SH_INT_SPECIALS]) {
    // `${x:=w}` / `${x=w}` assign w; `${x:+w}` / `${x-w}` / `${x:?w}` count too (fail closed): w must be a plain numeric literal
    for (const m of text.matchAll(new RegExp(`\\$\\{${n}(?:\\[[^\\]]*\\])?:?[-=+?]([^}]*)`, "g"))) out.push(m[1]);
    // the whole assignment word with its quoting (`x=" $y"`, `x=1" $y"`, an unterminated quote runs to the end); a quoted part may
    // hold any text, so a body with a quote counts only when it is a plain numeric literal once the quotes are gone
    const assign = new RegExp(`(?<![\\w$-])${n}(?:\\[[^\\]]*\\])?\\+?=((?:"[^"]*"?|'[^']*'?|[^\\s;&|)"'])*)`, "g");
    for (const m of text.matchAll(assign)) out.push(m[1]);
    const rest = text.replace(stmt, " ").replace(assign, " ");
    // a special read inside arithmetic (`shift $((OPTIND-1))`) assigns nothing; any other bare mention (`read OPTIND`) may
    if (!names.has(n)) {
      if (new RegExp(`(?<![\\w$])(?<!\\$\\{)${n}(?![A-Za-z0-9_])`).test(rest.replace(/\(\([\s\S]*?\)\)|\$\[[^\]]*\]/g, " "))) all();
      continue;
    }
    if (new RegExp(`(?<![\\w$])(?<!\\$\\{)${n}(?![A-Za-z0-9_])`).test(rest)) all();
  }
  return out;
}

/**
 * The bodies of every `[[ .. ]]` in `command`: a single bracket pair inside (`a[0]`, `a[b[0]]`) is part of the body, so the body runs
 * to the `]]` that closes the `[[` (to the end of the line when none does).
 */
function dblBrackets(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\[\[/g)) {
    let depth = 0;
    let end = command.length;
    for (let i = m.index + 2; i < command.length; i++) {
      if (command[i] === "[") depth++;
      else if (command[i] === "]") {
        if (depth > 0) depth--;
        else if (command[i + 1] === "]") {
          end = i;
          break;
        }
      }
    }
    out.push(command.slice(m.index + 2, end));
  }
  return out;
}

/**
 * Bash variables some bash builds treat as integers without a declaration (fail closed: assigning them a non-literal counts as
 * arithmetic, like an `-i` name).
 */
const SH_INT_SPECIALS = ["OPTIND", "OPTERR", "LINENO", "RANDOM", "SRANDOM", "SECONDS", "EPOCHSECONDS", "HISTCMD", "COLUMNS", "LINES", "HISTSIZE", "HISTFILESIZE"];

/** Whether `word` holds a `$N` / `${N}` reference to a name in `names`. */
function refsBound(word: string, names: ReadonlySet<string>): boolean {
  for (const m of word.matchAll(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/g)) if (names.has((m[1] ?? m[2])!)) return true;
  return false;
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/**
 * R16 item 2: the reviewer rules file of the overlay's asks. `safety.permissions.autoReview.rulesFile` of `base` (the layers before the
 * project and session layers: a project cannot set it) replaces the shipped `config/permissions.rules.md`; absolute, `~/...` or relative
 * to the agent dir. Null without either.
 */
export function rulesFilePath(base: unknown, agentDir: string, pkgRoot: string | undefined, home: string = os.homedir()): string | null {
  const f = obj(obj(base).autoReview).rulesFile;
  if (typeof f === "string" && f.trim()) {
    const t = f.trim();
    return t === "~" || t.startsWith("~/") || t.startsWith("~\\") ? path.join(home, t.slice(1)) : path.resolve(agentDir, t);
  }
  return pkgRoot ? path.join(pkgRoot, "config", "permissions.rules.md") : null;
}

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
      externalDirectory: { probe: strs(obj(raw.externalDirectory).probe) },
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
  // R16: a user rules file of the auto reviewer is protected like protect.ask (the shipped one is under writeAskSelfHost / writeAsk)
  const userRules = typeof obj(b.autoReview).rulesFile === "string" ? rulesFilePath(b, agentDir, undefined) : null;
  return {
    bashDeny: [...baseline.bash.deny, ...strs(m.deny)],
    bashAsk: hasBase ? without(strs(m.ask), strs(b.ask)) : [],
    pathRules: [
      ...baseline.paths.deny.map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
      ...baseline.paths.except.map((pattern): PathRule => ({ pattern: sub(pattern), action: "allow" })),
      ...strs(mp.deny).map((pattern): PathRule => ({ pattern: sub(pattern), action: "deny" })),
    ],
    pathAsk: hasBase ? without(strs(mp.ask), strs(bp.ask)) : [],
    protect: [...prot(pb?.deny, "deny", true), ...prot(pb?.ask, "ask", true, { readOk: "main" }), ...prot(pb?.childDeny, null, true, { fromChildDeny: true }), ...prot(selfHost ? [...(pb?.writeAsk ?? []).filter((p) => p !== "{pkgRoot}" && p !== "{pkgRoot}/*"), ...(pb?.writeAskSelfHost ?? [])] : pb?.writeAsk, "ask", false, { readOk: "child", fromWriteAsk: true }), ...prot(pb?.removeAsk, "ask", true).map((r) => ({ ...r, removeOnly: true })), ...(userRules ? prot([slash(userRules)], "ask", true, { readOk: "main" }) : [])],
    childBlock: [...CHILD_BLOCK.map(sub), ...CHILD_BLOCK_WORKTREES, ...(owned?.childScratchRoot ? [slash(owned.childScratchRoot), `${slash(owned.childScratchRoot)}/*`] : [])],
    childBlockExcept: CHILD_BLOCK_EXCEPT.map(sub),
    childBlockInWorkspace: CHILD_BLOCK_WORKTREES,
    ...(owned ? { owned } : {}),
    probeDirs: probeDirPatterns(baseline.externalDirectory?.probe ?? []),
  };
}

/** The probe dir list as overlay patterns: `%APPDATA%` only on win32 with APPDATA set (else the entry is dropped), `~` left to the matcher; dir + `dir/*`. */
function probeDirPatterns(list: string[], platform: string = process.platform, appData: string | undefined = process.env.APPDATA): string[] {
  const out: string[] = [];
  for (const p0 of list) {
    let p = p0;
    if (p.includes("%APPDATA%")) {
      if (platform !== "win32" || !appData || !path.win32.isAbsolute(appData)) continue;
      p = p.replace(/%APPDATA%/g, appData.split("\\").join("/").replace(/\/+$/, ""));
    }
    p = p.replace(/\/+$/, "");
    if (p) out.push(p, `${p}/*`);
  }
  return out;
}

/** The toolchain probe pattern a path word lies in (any spelling, as written or resolved), or null (R10 item 3). */
function probeHit(rules: OverlayRules, word: string, ctx: MatchCtx): string | null {
  if (!rules.probeDirs?.length) return null;
  for (const x of pathCandidates(word, ctx)) {
    const pat = rules.probeDirs.find((p) => pathMatches(p, x, ctx));
    if (pat) return pat;
  }
  return null;
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
/** Word indices of a parsed unit with a `$` or backtick outside single quotes (the shell may expand it, `${N:=v}` binds N). */
const LIVE_WORDS = new WeakMap<string[], Set<number>>();
/** Source offsets [start, end) of each word of a parsed unit, in the string given to parseShell. */
const WORD_SPANS = new WeakMap<string[], Array<[number, number]>>();

/** True when a unit parsed by `parseShell` has a redirect (the operators are dropped from its words). */
export function unitHasRedirect(unit: string[]): boolean {
  return REDIRECTS.has(unit);
}

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
  let pos = 0;
  let wordStart = 0;
  let wordLive = false;
  let spans: Array<[number, number]> = [];
  let live = new Set<number>();
  const flush = (): void => {
    if (cur !== null) {
      if (redirNext) {
        redir.add(words.length);
        if (writeNext) wredir.add(words.length);
      }
      redirNext = false;
      writeNext = false;
      spans.push([wordStart, pos]);
      if (wordLive) live.add(words.length);
      words.push(cur);
    }
    cur = null;
    wordLive = false;
  };
  const endUnit = (): void => {
    flush();
    if (words.length) {
      units.push(words);
      if (redir.size) REDIRECTS.set(words, redir);
      if (wredir.size) WRITE_REDIRECTS.set(words, wredir);
      LIVE_WORDS.set(words, live);
      WORD_SPANS.set(words, spans);
    }
    words = [];
    spans = [];
    live = new Set();
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
    pos = i;
    if (cur === null) wordStart = i;
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
        else if (src[j] === "$" || (posix && src[j] === "`")) wordLive = true;
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
    } else {
      if (c === "$") wordLive = true;
      add(c);
    }
  }
  pos = src.length;
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
    // `git grep -O<cmd>` / `--open-files-in-pager` (any `--op` prefix) runs a program on the matched files
    if (sub === "grep" && rest.some((a) => GIT_GREP_PAGER.test(a))) return { targets: [], unknown: "git grep -O" };
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

/** The unit as written, then with env assignments / wrapper commands / the path prefix stripped; `env` lists the stripped assignments. */
function variants(words: string[]): { texts: string[]; core: string[]; env: string[] } {
  let w = words.slice();
  const texts: string[] = [];
  const env: string[] = [];
  for (let n = 0; n < 8 && w.length; n++) {
    texts.push(w.join(" "));
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      env.push(w[0]);
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
  return { texts, core: w, env };
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
  /** The verb of every non-neutral unit (`""` for a unit with an env assignment or wrapper prefix): the probe-dir check (PROBE_VERBS). */
  verbs?: string[];
  /** The command word of every unit as written (a toolchain probe dir named only as the program to run is left to the permission system's bash rules). */
  cmdWords?: string[];
  /** Some unit has a redirect (any target, `/dev/null` included). */
  redirected?: boolean;
  /** Harness-set variables a same-line `$NAME` may resolve to (shellvars.ts); unset below the top level. */
  vars?: Record<string, string>;
  /** The host platform for the same-line variables (win32 forms in shellvars.ts); default process.platform. */
  platform?: string;
  /** The words as written that the grammar resolved (their values are in the target sets): the win32 raw pass adds no second, unresolved copy. */
  resolvedWords?: Set<string>;
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
  /** R14 item 2: the message-file operands of `git commit` (`-F f`, `--file f`, `--file=f`), by position: git reads them, never writes. */
  msgFiles?: string[];
  /** R14 ruling 5: the message-file operands of `git tag`: no exemption, a child's protected one is denied with its own reason. */
  tagMsgFiles?: string[];
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
  /** A childAsk unit other than a bare `npm ci` / `npm install` (safe flags, no package names, no `-g`): the owned-root pre-allow never applies. */
  askUnsafe?: boolean;
  /** The `--prefix` values of each npm install/ci unit (`[]` without one); the owned-root pre-allow resolves them against every dir the cd chain may leave. */
  npmUnits?: string[][];
  /** The literal target of each top-level `cd <dir>` in order (R10 item 6: the dirs a later npm unit may run in). */
  npmCds?: string[];
  /** A cd/pushd/Set-Location the pre-allow does not resolve: not `cd <one literal dir>` at the top level, or more than NPM_MAX_CDS of them. */
  npmCdUnsafe?: boolean;
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
  /** Interpreter names the line redefines as a shell function or alias (shadowedInterpreters): their -c/-e body is collected as shell. */
  shadowed?: Set<string>;
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

/** A `git grep` option cluster with `O` (digits included: `-1Oecho`) or `--open-files-in-pager` by any `--op` prefix. */
const GIT_GREP_PAGER = /^-[^-]*O|^--op/;

/** Options of `git commit` / `git tag` whose value is the next word (so a `-F` there is that value, not the message-file option). */
const GIT_MSG_VALUE_OPTS = new Set(["-m", "-c", "-C", "-t", "-u", "--message", "--author", "--date", "--template", "--cleanup", "--fixup", "--squash", "--trailer", "--reuse-message", "--reedit-message", "--local-user", "--pathspec-from-file"]);

/**
 * R14 item 2: indexes into `core` of the message-file operand of `git commit` / `git tag`: the word after an exact `-F` or `--file`, or an
 * exact `--file=<f>` word, before any `--`. Git reads that file; attached or combined short forms (`-Ff`, `-sF f`) are not taken.
 */
function gitMessageFiles(core: string[], skip: Set<number>): { tag: boolean; at: number[] } {
  let k = 1;
  while (k < core.length && core[k].startsWith("-")) k += /^-[Cc]$/.test(core[k]) ? 2 : 1;
  const tag = core[k] === "tag";
  if (core[k] !== "commit" && !tag) return { tag, at: [] };
  const out: number[] = [];
  for (let i = k + 1; i < core.length; i++) {
    const x = core[i];
    if (skip.has(i) || x === "--") break;
    if ((x === "-F" || x === "--file") && i + 1 < core.length && !skip.has(i + 1)) out.push(++i);
    else if (x.startsWith("--file=") && x.length > 7) out.push(i);
    else if (GIT_MSG_VALUE_OPTS.has(x)) i++;
  }
  return { tag, at: out };
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
    if (core[k] === "log") return gitLogPatterns(core, k, skip);
    if (core[k] !== "grep") return [];
    // `-O<cmd>` runs a program on the matched files and mis-sorts the operands (`-Orm x -- F` reads `x` as -m's value, F as the pattern): every word stays a path
    if (core.slice(k).some((a) => GIT_GREP_PAGER.test(a))) return [];
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

/**
 * R10 item 4: the pickaxe/grep values of `git log` (`-S <string>`, `-G <regex>`, `--grep <pattern>`, their attached forms `-S<s>`, `--grep=<p>`),
 * up to `--`. `-L <range>:<file>` is left out: its <file> part stays a path word.
 */
function gitLogPatterns(core: string[], k: number, skip: Set<number>): number[] {
  const out: number[] = [];
  for (let i = k + 1; i < core.length; i++) {
    const x = core[i];
    if (skip.has(i)) continue;
    if (x === "--") break;
    if ((x === "-S" || x === "-G" || x === "--grep") && i + 1 < core.length) {
      if (!skip.has(i + 1)) out.push(i + 1);
      i++;
    } else if (/^-[SG]./.test(x) || x.startsWith("--grep=")) out.push(i);
  }
  return out;
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
  // an allowlist of git shapes that only read their path operands: effects.ts's GIT_READ without its writing options
  // (`grep` is no reader: `-O` runs a program); a global `-c` or any other subcommand is no reader
  if (verb === "git") {
    return gitProtectedRead(core);
  }
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

/** Options of a bare `npm install` / `npm ci` that write only the project (no registry, prefix or program choice). */
const NPM_INSTALL_FLAGS = /^--(no-)?(audit|fund|progress|ignore-scripts|prefer-offline|offline|legacy-peer-deps|package-lock)$|^--package-lock-only$|^--silent$|^--loglevel=(silent|error|warn|info)$/;

/** The most top-level `cd <dir>` units a line may hold and keep the owned-root npm pre-allow (each subset of the chain is a possible cwd). */
const NPM_MAX_CDS = 4;

/** A `--prefix` value or cd target the owned-root pre-allow cannot resolve: an expansion, glob, `\`, or a `~` (win32: a `~` inside a name, as in an 8.3 short name `RUNNER~1`, is literal). */
function npmUnsafeWord(w: string, platform?: string): boolean {
  return (platform === "win32" ? /[$`*?[\]{}\\]|(^|[^A-Za-z0-9])~/ : /[$`~*?[\]{}\\]/).test(w);
}

/** The `--prefix` values of an owned-root-safe `npm install|ci` argument list (`[]` without one), or null when an argument is not safe (`-g`, a package name, any other option, an expansion). */
function npmInstallArgs(args: string[], platform?: string): string[] | null {
  const prefixes: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (NPM_INSTALL_FLAGS.test(a)) continue;
    let val: string | undefined;
    if (a === "--prefix") val = args[++i];
    else if (a.startsWith("--prefix=")) val = a.slice(9);
    else return null;
    if (val === undefined || val === "" || npmUnsafeWord(val, platform)) return null;
    prefixes.push(val);
  }
  return prefixes;
}

/**
 * Every cwd a line's top-level `cd` chain may leave (each subset of the chain in order: a failed cd leaves the dir as it was), starting at `cwd`.
 */
function npmCwds(cwd: string, cds: string[], p: path.PlatformPath): string[] {
  let dirs = [cwd];
  for (const t of cds) dirs = [...new Set([...dirs, ...dirs.map((d) => p.resolve(d, t))])];
  return dirs;
}

/** The dir npm installs into when run in `dir` without --prefix: the nearest ancestor (itself included) with package.json or node_modules, else `dir`. */
function npmLocalPrefix(dir: string, p: path.PlatformPath, exists: (x: string) => boolean): string {
  for (let d = dir, n = 0; n < 64; n++) {
    if (exists(p.join(d, "package.json")) || exists(p.join(d, "node_modules"))) return d;
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return dir;
}

/**
 * A child's `npm install|ci` runs unasked in its owned worktree root or a subdir of it (R10 item 6): nothing else asks, every cd is one literal
 * top-level `cd <dir>`, and every dir npm may install into realpaths inside one owned root that holds the session cwd: for each cwd the cd
 * chain may leave, each `--prefix` resolved against it, or without one the dir npm takes itself (npmLocalPrefix). A symlink out of the root asks.
 */
function npmInstallOwned(c: Collected, ctx: MatchCtx): boolean {
  if (c.askUnsafe || c.npmCdUnsafe || !ctx.cwd) return false;
  if (ctx.platform === "win32") return npmInstallOwnedWin32(c, ctx);
  const fsx = defaults(ctx);
  const inRoot = (root: string, d: string): boolean => {
    const r = fsx.realpath(d);
    return !!r && (r === root || r.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
  };
  const root = (ctx.roundRoots ?? []).map((r) => fsx.realpath(r)).find((r): r is string => !!r && inRoot(r, ctx.cwd));
  const dirs = npmCwds(ctx.cwd, c.npmCds ?? [], path);
  const into = (r: string, noLink = false): boolean => {
    const ok = (t: string): boolean => inRoot(r, t) && !(noLink && linksNodeModules(fsx.realpath(t) ?? t));
    return (c.npmUnits ?? [[]]).every((prefixes) => dirs.every((d) => (prefixes.length ? prefixes.every((p) => ok(path.resolve(d, p))) : ok(npmLocalPrefix(d, path, fsx.exists)))));
  };
  // never into a worktree whose node_modules is a symlink: npm would write through it into another checkout's tree
  if (root && dirs.every((d) => inRoot(root, d)) && into(root, true)) return true;
  // the foreman's own `bench/pi-lock` (R11 item 10): every dir npm may install into is inside it, wherever the child's cwd is
  const lock = ctx.foremanRoot ? fsx.realpath(path.join(ctx.foremanRoot, "bench", "pi-lock")) : undefined;
  return !!lock && into(lock);
}

/**
 * The root of a pi-subagents managed worktree (`worktree: true`, `<repo>/../worktrees/<repo>/pi-worktree-<run>-<i>`) that holds `dir`: the
 * nearest ancestor (itself included) with a `.git`, when that `.git` is a file (a linked worktree) and the directory name starts with `pi-worktree-`.
 */
function pSubagentsLeaf(dir: string, fsx: ReturnType<typeof defaults>): string | null {
  for (let d = dir, n = 0; n < 64; n++) {
    const g = path.join(d, ".git");
    if (fsx.exists(g)) return !fsx.isDir(g) && path.basename(d).startsWith("pi-worktree-") ? d : null;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/**
 * `npm-ci-worktree` (trace label): a child's exact `npm ci` (no flag, no env prefix, no chain) whose cwd lies in a `roundRoots` entry or in a
 * pi-subagents managed worktree, and whose npm local prefix does too. POSIX only (win32 asks); never the parent checkout.
 * Never when that prefix's `node_modules` is a symlink: npm ci would wipe the tree it points to (another checkout's).
 */
export function npmCiWorktreeLabel(command: string, ctx: MatchCtx): "npm-ci-worktree" | null {
  if (ctx.role !== "child" || ctx.platform === "win32" || !ctx.cwd || !/^npm[ \t]+ci$/.test(command.trim())) return null;
  const fsx = defaults(ctx);
  const cwd = fsx.realpath(ctx.cwd);
  if (!cwd) return null;
  const inside = (root: string, d: string): boolean => d === root || d.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  const roots = (ctx.roundRoots ?? []).map((r) => fsx.realpath(r)).filter((r): r is string => !!r);
  const root = roots.find((r) => inside(r, cwd)) ?? pSubagentsLeaf(cwd, fsx);
  if (!root) return null;
  const prefix = npmLocalPrefix(cwd, path, fsx.exists);
  return inside(root, prefix) && !linksNodeModules(prefix) ? "npm-ci-worktree" : null;
}

/** `<dir>/node_modules` is a symlink (lstat): npm ci would wipe the tree it points to. */
function linksNodeModules(dir: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * npmInstallOwned on win32: an 8.3 short name and its long name are one directory, so the cwd, the round roots and each `--prefix`
 * (forward or back slashes, resolved with path.win32) are compared case-folded in their JS-realpath and native-realpath (8.3 expanded)
 * spellings. A prefix's native spelling counts only when no symlink is on its way (the JS realpath leaves it unchanged): a link is no
 * alias, so it counts by its target alone. Inside means equal to or below one spelling of the root (R10 item 6), never a parent of it.
 */
function npmInstallOwnedWin32(c: Collected, ctx: MatchCtx): boolean {
  const fsx = defaults(ctx);
  const nat = nativeReal(ctx);
  const norm = (p: string): string => path.win32.resolve(p).toLowerCase();
  const spellings = (p: string): string[] => {
    const abs = path.win32.resolve(ctx.cwd, p);
    const js = fsx.realpath(abs);
    if (!js) return [];
    const noLink = norm(js) === norm(abs);
    return [js, ...(noLink ? [nat(abs)] : [])].filter((x): x is string => !!x).map(norm);
  };
  const inside = (a: string[], root: string[]): boolean => a.some((x) => root.some((r) => x === r || x.startsWith(r.endsWith("\\") ? r : r + "\\")));
  const dirs = npmCwds(path.win32.resolve(ctx.cwd), c.npmCds ?? [], path.win32);
  const into = (root: string[]): boolean => (c.npmUnits ?? [[]]).every((prefixes) => dirs.every((d) => (prefixes.length ? prefixes.every((p) => inside(spellings(path.win32.resolve(d, p)), root)) : inside(spellings(npmLocalPrefix(d, path.win32, fsx.exists)), root))));
  const root = (ctx.roundRoots ?? []).map(spellings).find((r) => r.length > 0 && inside(spellings(ctx.cwd), r));
  if (root && dirs.every((d) => inside(spellings(d), root)) && into(root)) return true;
  // the foreman's own `bench/pi-lock` (R11 item 10), as on POSIX: every dir npm may install into is inside it, wherever the cwd is
  const lock = ctx.foremanRoot ? spellings(path.win32.join(ctx.foremanRoot, "bench", "pi-lock")) : [];
  return lock.length > 0 && into(lock);
}

function collect(src0: string, shell: "posix" | "powershell", depth: number, out: Collected): void {
  const src = shell === "powershell" ? psDashes(src0) : src0;
  const parsed = parseShell(src, shell);
  // same-line variables (shellvars.ts): the expanded words and texts are checked next to the line as written
  const resolved = depth === 0 && shell === "posix" && out.vars ? resolveVars(parsed.pipelines, parsed.seps, out.vars, (u) => REDIRECTS.has(u), src, out.platform) : new Map<string[], string[]>();
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
    if (redir.size) out.redirected = true;
    if (v.core.length) out.cmdWords?.push(unitWords[off]);
    const skip = new Set([...redir].filter((i) => i >= off).map((i) => i - off));
    // the pattern of grep/rg and their include/exclude/glob values are no paths, whatever the rest of the command does
    const verb0 = v.core.length ? baseName(v.core[0]) : "";
    const patt = GREP_FAMILY.has(verb0) || verb0 === "git" || verb0 === "sed" || verb0.endsWith("awk") ? new Set(nonPathArgs(v.core, skip).map((i) => i + off)) : new Set<number>();
    out.words.push(...unitWords.filter((_, i) => !patt.has(i)));
    out.proseSkip?.push(...proseIndexes(v.core).filter((i) => !patt.has(i + off)).map((i) => unitWords[i + off]));
    if (verb0 === "git") {
      const m = gitMessageFiles(v.core, skip);
      (m.tag ? out.tagMsgFiles : out.msgFiles)?.push(...m.at.flatMap((i) => { const x = unitWords[i + off]; return x.startsWith("--file=") ? [x, x.slice(7)] : [x]; }));
    }
    const rw = resolved.get(allWords);
    if (rw) {
      const rest = lead ? rw.slice(lead) : rw;
      const extra = rest.filter((w, i) => w !== unitWords[i] && !patt.has(i));
      rest.forEach((w, i) => { if (w !== unitWords[i]) out.resolvedWords?.add(unitWords[i]); });
      out.words.push(...extra);
      out.protWords?.push(...extra);
      out.unitTexts.push(rest.join(" "));
    }
    // ONE resolution for every target set below: the unit's words with the grammar's values (shellvars.ts) substituted
    const rWords = rw ? (lead ? rw.slice(lead) : rw) : unitWords;
    const rcore = rWords.slice(off);
    const trustedBound = new Set([...(out.bound ?? [])].filter((n) => TRUSTED_VARS.has(n)));
    if (trustedBound.size) out.boundRefs?.push(...rWords.filter((w, i) => !patt.has(i) && refsBound(w, trustedBound)));
    if (CD_VERBS.has(verb0.toLowerCase())) {
      const t = v.core[1];
      const ok = depth === 0 && verb0 === "cd" && off === 0 && v.core.length === 2 && skip.size === 0 && !!t && !t.startsWith("-") && !npmUnsafeWord(t, out.platform) && (out.npmCds?.length ?? 0) < NPM_MAX_CDS;
      if (ok) (out.npmCds ??= []).push(t);
      else out.npmCdUnsafe = true;
    }
    {
      let k = 1;
      let ask: string | undefined;
      if (verb0 === "git") {
        while (k < v.core.length && v.core[k].startsWith("-")) k += /^-[Cc]$/.test(v.core[k]) ? 2 : 1;
        if (v.core[k] === "fetch") ask = "git fetch";
        if (ask !== undefined) out.askUnsafe = true;
      } else if (verb0 === "npm" && (v.core[1] === "ci" || v.core[1] === "install" || v.core[1] === "i")) {
        ask = `npm ${v.core[1]}`;
        // Fail closed: any env assignment prefix (npm_*, PATH, COMSPEC, CC, ...) may change what npm reads, writes or runs, so it loses the pre-allow.
        const safe = v.env.length > 0 ? null : npmInstallArgs(v.core.slice(2), out.platform);
        if (safe === null) out.askUnsafe = true;
        else (out.npmUnits ??= []).push(safe);
      }
      if (ask !== undefined && out.childAsk === undefined) out.childAsk = ask;
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
      // an assignment-only unit (`PATH=/x; cat F`) may change what a later reader runs: the line is no protected read
      if (!neutral && raw === undefined) out.rdr = false;
      // a loop (`for PATH in /tmp/e; do cat F; done`) may bind a variable the reader runs under: the line is no protected read
      if (unitWords[0] === "for" || unitWords[0] === "select") out.rdr = false;
      if (!neutral && raw !== undefined) {
        out.verbs?.push(off === 0 && v.core.length ? baseName(v.core[0]) : "");
        // a unit with an env prefix or wrapper (`PATH=/tmp/e cat`, `GIT_EXTERNAL_DIFF=rm git diff`, `env … git`) is no reader: `off` counts the stripped words
        const reader = v.core.length > 0 && off === 0 && protectedReader(v.core, skip);
        if (!reader) out.rdr = false;
        const gitRead = reader && baseName(v.core[0]) === "git";
        if (!(PURE_VERBS.has(baseName(raw)) || gitRead) || !v.core.length || !(PURE_VERBS.has(baseName(v.core[0])) || gitRead)) out.pure = false;
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
    // R12 item 3: a same-line function or alias with the interpreter's name may run the body as shell: it is checked as shell
    const shadow = !!code && !!out.shadowed?.has(baseName(v.core[0]));
    if (shadow && depth < MAX_DEPTH) collect(code!, "posix", depth + 1, out);
    if (code && !shadow && out.readCode && /^(python[0-9.]*|pypy[0-9.]*)$/.test(baseName(v.core[0])) && pythonReadOnlyCode(code)) {
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
  // win32: in `--prefix=C:/x` the first `:` is the drive colon of the value after `=`, which the `=` reading above takes whole (as it
  // takes a bare `C:/x`); split there it gave a drive-less `/x` that resolves against another drive
  const driveAfterEq = ctx.platform === "win32" && eq > 0 && colon === eq + 2 && /^[A-Za-z]:[\\/]/.test(s.slice(eq + 1));
  if (colon >= 0 && depth < 2 && !driveAfterEq && !/^[A-Za-z]:([\\/]|$)/.test(s)) out.push(...tokenCandidates(s.slice(colon + 1), ctx, 2));
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
const STDIN_WRITE = /open\s*\([^)]*['"]\s*>>?|open\([^)]*,\s*(?:mode\s*=\s*)?(['"])[rwax]*[wax+][^'"]*\1|\b(write_text|write_bytes|writeFile\w*|appendFile\w*|createWriteStream|copyFile\w*|os\.(remove|rename|replace|unlink)|shutil\.|fs\.(write|rm|unlink|rename))/;

/**
 * A child never writes files through a heredoc or a stdin script: `cat > f <<'EOF'`, `tee f <<EOF`, `python3 - <<EOF` / `node -e` fed from stdin
 * that open a file for write, inline code (`python3 -c`, `node -e`, `perl -e`) that does, and in-place edits (`perl -pi`, `ruby -i`, `awk -i inplace`). Inline code always denies, since its code can name any path; an in-place edit may target only the child's own scratch dir. The body is invisible to the path checks, so it is refused outright (deny-only, no dialog).
 */
function childStdinWriteDeny(command: string, ctx: MatchCtx): Decision | null {
  const heredoc = /<<(?!<)/.test(command);
  const stripped = command.replace(/\d*>&\d*-?|&>\s*\/dev\/null|\d*>>?\s*\/dev\/null/g, "");
  const writer = (heredoc && /\bcat\b[^|;&\n]*>|\btee\b|\bdd\b[^|;&\n]*\bof=/.test(stripped))
    || ((heredoc || /\|\s*(python[\d.]*|node|perl|ruby)\b|\b(python[\d.]*|node|perl|ruby)\s+-(\s|$)|<<</.test(command)) && /\b(python[\d.]*|node|perl|ruby)\b/.test(command) && STDIN_WRITE.test(command));
  const deny: Decision = { kind: "deny", reason: "pi-foreman: denied for a child (heredoc or stdin-script file write): never heredoc or stdin-script file writes; use the write or edit tool." };
  if (writer) return deny;
  if (INLINE_CODE.test(command) && STDIN_WRITE.test(command)) return deny;
  if (!INPLACE_EDIT.test(command)) return null;
  return scratchOnlyWriter(command, ctx) ? null : deny;
}

const INPLACE_EDIT = /\b(perl|ruby)\b[^|;&\n]*(?<=\s)-(?![MIrCEFm])[A-Za-z0-9]*i[A-Za-z0-9.]*(?=\s|$)|\b\w*awk\b[^|;&\n]*\s-i\s*inplace\b/;
const INLINE_CODE = /\b(python[\d.]*|node|perl|ruby)\s+-[ce]\b/;
const INTERP_NAME = /^(python[\d.]*|node|perl|ruby|\w*awk)$/;
/** A command word (quotes kept) or an operator run (`|;&`, newline), which splits a command into units. */
const SHELL_WORD = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s|;&'"\\])+|[|;&\n]+/g;
const unquote = (w: string): string => w.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g, (_m, a?: string, b?: string, c?: string) => a ?? b ?? c ?? "");

/**
 * True when every unit that edits in place names only file arguments inside the child's own scratch dir (lexically and through links).
 * The code itself is not read; a unit with no file argument, or no scratch dir, is not exempt. An awk program operand is not a file.
 */
function scratchOnlyWriter(command: string, ctx: MatchCtx): boolean {
  const scratch = scratchOf(ctx);
  const cwd = ctx.cwd;
  if (!scratch || !cwd) return false;
  const fsx = defaults(ctx);
  const realOf = (x: string): string => fsx.realpath(x) ?? (path.dirname(x) === x ? x : path.join(realOf(path.dirname(x)), path.basename(x)));
  const realScratch = fsx.realpath(scratch) ?? scratch;
  const inScratch = (w: string): boolean => {
    const abs = path.resolve(cwd, expandWord(w, ctx));
    return insideDir(scratch, abs, ctx) && insideDir(realScratch, realOf(abs), ctx);
  };
  const units: string[][] = [[]];
  for (const m of command.matchAll(SHELL_WORD)) {
    if (/^[|;&\n]/.test(m[0])) units.push([]);
    else units[units.length - 1].push(m[0]);
  }
  let found = false;
  for (const u of units) {
    const text = u.join(" ");
    if (!INPLACE_EDIT.test(text)) continue;
    found = true;
    const words = u.map(unquote);
    const k = words.findIndex((w) => INTERP_NAME.test(w.split("/").pop() ?? ""));
    if (k < 0) return false;
    // awk's first operand is the program text, unless -f names a program file
    let program = /awk$/.test(words[k].split("/").pop() ?? "") && !words.includes("-f");
    const args: string[] = [];
    for (let j = k + 1; j < words.length; j++) {
      const w = words[j];
      if (w === "-i" && words[j + 1] === "inplace") j++;
      else if (!w.startsWith("-")) {
        if (program) program = false;
        else args.push(w);
      } else if (/^-[A-Za-z]*e$/.test(w)) j++;
    }
    if (!args.length || !args.every(inScratch)) return false;
  }
  return found;
}

/**
 * The words of a `git commit` unit without its literal message values (`-m X`, `-mX`, `-am X`, `--message=X`, `--message X`; a `-F file`
 * path is not message content), or null when the unit is no `git commit`. A value with a `$` or backtick outside single quotes may expand
 * (`"${N:=v}"` binds N in the shell): it stays in the words and `literal` is false.
 */
function commitMessageFree(u: string[]): { words: string[]; literal: boolean } | null {
  const v = variants(u);
  const core = v.core;
  if (!core.length || baseName(core[0]) !== "git") return null;
  let k = 1;
  while (k < core.length && core[k].startsWith("-")) k += /^-[Cc]$/.test(core[k]) ? 2 : 1;
  if (core[k] !== "commit") return null;
  // core is a suffix of u (variants strips leading words, a path prefix keeps the length); no lexer record: every word may expand
  const off = u.length - core.length;
  const lv = LIVE_WORDS.get(u);
  const isLive = (i: number): boolean => !lv || lv.has(off + i);
  const out = [...v.env, ...core.slice(0, k + 1)];
  let literal = true;
  for (let i = k + 1; i < core.length; i++) {
    const w = core[i];
    if (w === "--") {
      out.push(...core.slice(i));
      break;
    }
    const sep = /^-[A-Za-z]*m$/.test(w) || w === "--message";
    const joined = !sep && (/^-[A-Za-z]*m.+$/.test(w) || w.startsWith("--message="));
    if (!sep && !joined) out.push(w);
    else if (sep && i + 1 < core.length && isLive(i + 1)) {
      literal = false;
      out.push(w, core[++i]);
    } else if (joined && isLive(i)) {
      literal = false;
      out.push(w);
    } else if (sep) i++;
  }
  return { words: out, literal };
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
  let cur = new Set([p.resolve(norm(ctx.cwd))]);
  const stack: Array<{ set: Set<string>; sure: boolean }> = [];
  // sep: the operator after the unit (`|` inside a pipeline, "" for a keyword-only unit)
  const units: Array<{ core: string[]; sep: string }> = [];
  let blocked = false;
  const gather = (src: string, shell: "posix" | "powershell", depth: number): void => {
    const parsed = parseShell(src, shell);
    // a literal `git commit` message is text, not a command: with a commit in the source and every message value literal the scan runs per
    // unit on the words outside the message values
    const commits = parsed.pipelines.flatMap((pipe) => pipe.map(commitMessageFree)).filter((x) => x !== null);
    if ((!commits.length || commits.some((x) => !x.literal)) && cdpath(src)) blocked = true;
    for (const sub of parsed.subs) if (depth < MAX_DEPTH) gather(sub, shell, depth + 1);
    parsed.pipelines.forEach((pipe, pi) => pipe.forEach((u, ui) => {
      const sep = ui < pipe.length - 1 ? "|" : parsed.seps[pi];
      if ((commitMessageFree(u)?.words ?? u).some(cdpath)) blocked = true;
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

/**
 * The line without the quoted body of an inline `python3 -c` / `node -e` (R11 item 9): that code is no shell, so its `=` and names bind nothing.
 * Only a plain body (no `$`, backtick or backslash: the shell expands none of it) is dropped, and only the code word of that very unit (by its
 * source offsets) whose command word is python or node; the same text as a `bash -c` body elsewhere stays. An env prefix
 * (`HOME=x python3 -c ..`) stays in the line.
 */
function withoutInlineBodies(command: string, shadowed: Set<string>): string {
  const cut: Array<[number, number]> = [];
  for (const pipe of parseShell(command, "posix").pipelines) {
    for (const u of pipe) {
      const core = variants(u).core;
      if (!core.length || !/^(python[0-9.]*|node)$/.test(baseName(core[0])) || shadowed.has(baseName(core[0]))) continue;
      const code = inlineCode(core);
      if (!code || /[$`\\]/.test(code)) continue;
      const off = u.length - core.length;
      const idx = core.findIndex((w, k) => k > 0 && w === code && /^-[A-Za-z]*[ce]$/.test(core[k - 1]));
      const span = idx > 0 ? WORD_SPANS.get(u)?.[off + idx] : undefined;
      if (span && !LIVE_WORDS.get(u)?.has(off + idx)) cut.push(span);
    }
  }
  let out = command;
  for (const [s, e] of cut.sort((a, b) => b[0] - a[0])) out = `${out.slice(0, s)} ${out.slice(e)}`;
  return out;
}

/**
 * R12 item 3: the interpreter names (python, python3, python3.x, pypy, node) the line defines as a shell function (`name(){`, `function name`)
 * or an alias (`alias name=`), anywhere in the whole text (newlines and nested -c bodies included; a definition after the call also counts:
 * fail closed). Such a name may run its -c/-e body as shell.
 */
function shadowedInterpreters(command: string): Set<string> {
  const out = new Set<string>();
  const N = "python[0-9.]*|pypy[0-9.]*|node";
  const lead = "(?:^|[\\s;&|(){}'\"`])";
  for (const m of command.matchAll(new RegExp(`${lead}(?:function\\s+)?(${N})\\s*\\(\\s*\\)`, "g"))) out.add(m[1]);
  for (const m of command.matchAll(new RegExp(`${lead}function\\s+(${N})(?![\\w.-])`, "g"))) out.add(m[1]);
  for (const m of command.matchAll(new RegExp(`${lead}alias\\s+([^;&|\\n]*)`, "g"))) {
    for (const a of m[1].matchAll(new RegExp(`(?:^|[\\s'"])(${N})=`, "g"))) out.add(a[1]);
  }
  return out;
}

export function checkShell(rules: OverlayRules, rawCommand: string, ctx0: MatchCtx): Decision | null {
  const shell = ctx0.shell ?? "posix";
  const command = shell === "powershell" ? psDashes(rawCommand) : rawCommand;
  const bound = boundNames(command, shell);
  const shadowed = shell === "posix" ? shadowedInterpreters(command) : new Set<string>();
  const homeLine = shell === "posix" ? withoutInlineBodies(command, shadowed) : command;
  const homeBound = homeLine === command ? bound : boundNames(homeLine, shell);
  const ctx: MatchCtx = { ...ctx0, ...(ctx0.owned || !rules.owned ? {} : { owned: rules.owned }), bound };
  // a line that binds a harness-trusted variable it also uses (`HOME=-i; sed $HOME ...`, `read HOME; cat ~/x`) fails closed
  for (const n of ["HOME", "FOREMAN_SCRATCH", "USERPROFILE"]) {
    if (homeBound.has(n) && (new RegExp(`(?:^|[^\\w$-])${n}(?:\\[[^\\]]*\\])?\\+?=|\\$\\{?(?:env:)?\\{?${n}(?![A-Za-z0-9_])`, "i").test(homeLine) || (n === "HOME" && /(?<![\w])~/.test(homeLine)))) {
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
    const sw = childStdinWriteDeny(command, ctx);
    if (sw) return sw;
  }
  const scratch0 = scratchOf(ctx);
  const c: Collected = { vars: { ...(scratch0 ? { FOREMAN_SCRATCH: scratch0 } : {}), ...(ctx.cwd ? { PWD: ctx.cwd } : {}) }, platform: ctx.platform, resolvedWords: new Set(), bound, boundRefs: [], unitTexts: [], pipeTexts: [command.trim(), command.trim().replace(/\s+/g, " ")], words: [], removeWords: [], protWords: [], proseSkip: [], msgFiles: [], tagMsgFiles: [], verbs: [], cmdWords: [], pure: true, ro: true, rdr: true, writeTargets: new Set(), tmpTargets: new Set(), roTargets: new Set(), worktreeRemoveWords: new Set(), probeFiles: [], readCode: new Set(), shadowed, ...(ctx.cwd && shell === "posix" && ctx.platform !== "win32" ? { cdBase: { cwd: ctx.cwd, realpath: defaults(ctx).realpath, isDir: defaults(ctx).isDir } } : {}) };
  collect(command, shell, 0, c);
  // win32 (Git Bash runs the posix-unescaped words): the ambiguous path words of the posix pass, before the raw pass adds its own
  const winAmb = ctx.platform === "win32" && shell === "posix" ? winAmbiguity(command, c) : undefined;
  if (ctx.platform === "win32" && shell === "posix") {
    // native paths in a bash command (`cat C:\Users\x\.ssh\id`): lex again with `\` kept literal
    const raw: Collected = { unitTexts: [], pipeTexts: [], words: [], removeWords: [], protWords: [], proseSkip: [], msgFiles: [], tagMsgFiles: [], pure: true, ro: true, rdr: true, writeTargets: new Set() };
    collect(command, "powershell", 0, raw);
    c.words.push(...raw.words);
    c.removeWords!.push(...raw.removeWords!);
    c.protWords!.push(...raw.protWords!);
    c.proseSkip!.push(...raw.proseSkip!);
    c.msgFiles!.push(...raw.msgFiles!);
    c.tagMsgFiles!.push(...raw.tagMsgFiles!);
    c.pure = c.pure && raw.pure;
    c.ro = c.ro && raw.ro;
    c.rdr = c.rdr && raw.rdr;
    // a target the posix pass resolved (`> $S/tc.txt` after `S=$FOREMAN_SCRATCH`) is there with its value already
    raw.writeTargets!.forEach((x) => { if (!c.resolvedWords!.has(x)) c.writeTargets!.add(x); });
  }
  if (ctx.role === "child" && winAmb?.target !== undefined) {
    return { kind: "deny", reason: `pi-foreman: write target '${clip(winAmb.target)}' denied for a child: under Git Bash it is drive-relative or keeps a \\ without being an absolute path, so where it writes is not certain. Use a forward-slash path (C:/...) or a quoted native path ("C:\\...").` };
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
  if (ctx.role === "child" && c.childAsk !== undefined && !npmInstallOwned(c, ctx) && !npmCiWorktreeLabel(command, ctx)) {
    const ci = c.childAsk === "npm ci" ? " Run a bare `npm ci` in your worktree (no pipe, chain or background) or ask the foreman." : "";
    return { kind: "ask", reason: `pi-foreman: ${c.childAsk} needs approval for a child (it writes the project or the network; the foreman may run it).${ci}` };
  }
  // R31c: in a network read (netread.ts) a URL operand is no path (`https://h/x` would read as `<cwd>/https:/h/x`)
  const netRead = shell === "posix" && netReadCommand(command, ctx.role === "child" ? "child" : "orchestrator", scratch0 ? [scratch0] : [], ctx.cwd);
  const urlWord = (w: string): boolean => netRead && /^https?:\/\//.test(w);
  const words = [...new Set(c.words.flatMap((w) => [w, ...expandBraces(w)]))].filter((w) => !urlWord(w));
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
  // R16 item 4c: the foreman's own usage records (ctx.ownReads) are lifted only for an ownStateRead line that writes nothing (the one own-read decision)
  const ownRead = !!ctx.ownReads?.length && shell === "posix" && c.writeTargets!.size === 0 && c.tmpTargets!.size === 0 && ownStateRead(command, ctx);
  // `--exclude-dir=.git` names a path to leave out, never one to write: only a redirect target keeps such a word
  // the read-only python exemption holds only when the whole command is that one invocation: nothing else on the line may use the words
  const soloPython = /^\s*(?:[\w./-]*python[\w.]*)(?:\s+-[A-Za-z]+)*\s*$/.test(command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ""));
  const notFilter = (w: string): boolean => (!FILTER_OPT.test(w) && !(ctx.role === "child" && soloPython && c.readCode!.has(w))) || c.writeTargets!.has(w) || !!c.tmpTargets?.has(w);
  // R14 item 2: a `git commit` message file is read, not written: out of the `{cwd}/.pi/*` rule (only) when every occurrence of the word is one
  const pool = pure ? c.protWords! : c.words;
  const msgLeft = new Map<string, number>();
  for (const w of pool) msgLeft.set(w, (msgLeft.get(w) ?? 0) + 1);
  for (const w of c.msgFiles!) msgLeft.set(w, (msgLeft.get(w) ?? 0) - 1);
  const msgOnly = (w: string): boolean => c.msgFiles!.includes(w) && (msgLeft.get(w) ?? 0) <= 0 && !c.writeTargets!.has(w) && !c.tmpTargets?.has(w) && !c.roTargets?.has(w);
  // the message-file exemption is for the write protection only: the child read-block (handoffs, artifacts, siblings, other scratch) sees every word
  const rwords = (pure ? [...new Set(c.protWords!.flatMap((w) => [w, ...expandBraces(w)]))] : words).filter(notFilter).filter((w) => !urlWord(w));
  // R14 ruling 5: lifted are `{cwd}/.pi/*` and the writeAsk package-root pair (`{pkgRoot}`, `{pkgRoot}/*`: a read of a package file is no write);
  // every ask/deny/childDeny rule (another session's state, intercom, settings.json, .git) and the handoff parent/child writeAsk rules still see it
  const msgProtect = rules.protect.filter((r) => r.pattern !== "{cwd}/.pi/*" && !(r.fromWriteAsk && !r.pattern.includes("/handoffs/")));
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
    for (const w of rwords) {
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
    // R31c: a network read (netread.ts, the grammar the review link uses) is no write; its output files lie in the bound scratch dir only
    if (c.roUnknown !== undefined && childCwdReadOnly(pctx) && !netReadCommand(command, "child", scratchOf(pctx) ? [scratchOf(pctx)!] : [], pctx.cwd)) {
      return { kind: "deny", reason: `pi-foreman: '${clip(c.roUnknown)}' denied for a child: the round worktree is read-only except for its builder, and this command is neither a known reader nor a test run, so it may write there. Use a read command or ask the foreman.` };
    }
  }
  if (ctx.role === "child") {
    // R14 ruling 5: a `git tag -F` message file has no exemption (git_guard lints commits only)
    for (const w of c.tagMsgFiles!) {
      const hit = protectHit(rules.protect, w, pctx, true);
      if (hit) return { kind: "deny", reason: `pi-foreman: denied for a child: '${clip(w)}' is a git tag message file under the write protection (rule '${hit.rule.pattern}'). Only a git commit -F/--file message file may lie below .pi; put a tag message in .workflow/scratch/ or $FOREMAN_SCRATCH, or use -m.` };
    }
  }
  const prot = rwords.map((w) => ({ w, hit: protectHit(msgOnly(w) ? msgProtect : rules.protect, w, pctx, true, removed.has(w), readOnly, ownRead) })).filter((x) => x.hit);
  const pd = prot.find((x) => x.hit!.kind === "deny");
  if (pd) return protectDecision(pd.hit!, pd.w, "shell command");
  // R16 item 1, ruling 2: every ask from here on is self-modification (never auto-reviewed) when a protect ask hit is a write or remove target
  const written = prot.find((x) => (targets.has(x.w) || targets.has(asPathWord(x.w)) || removed.has(x.w)) && !ownScratch(pctx, x.w, true));
  const sm = written ? { selfMod: true as const } : {};
  // R10 item 3: the permission system read-allows the toolchain probe dirs for any command; only a pure ls/stat/which line may name them
  const probeWord = words.find((w) => !c.cmdWords!.includes(w) && probeHit(rules, w, pctx) !== null);
  if (probeWord !== undefined) {
    const probeOk = shell === "posix" && !/\$\(|`|[<>]\(/.test(command) && !/\$/.test(command.replace(/\$(?:\{HOME\}|HOME)(?=\/)/g, "")) && c.redirected !== true && c.writeTargets!.size === 0 && c.tmpTargets!.size === 0 && c.removeWords!.length === 0 && c.verbs!.length > 0 && c.verbs!.every((v) => PROBE_VERBS.has(v));
    if (!probeOk) return { kind: "ask", reason: `pi-foreman: '${clip(probeWord)}' is in a toolchain bin dir or the npx cache: only a plain ls, stat or which line may name it without approval (no other command, pipe, redirect or substitution).`, rule: "toolchain-probe", path: clip(probeWord), ...sm };
  }
  const amb = winAmb ? (winAmb.viaVar ?? (ctx.role === "child" ? winAmb.word : undefined)) : undefined;
  if (amb !== undefined) {
    return { kind: "ask", reason: `pi-foreman: '${clip(amb)}' needs approval: under Git Bash it is (or holds a variable assigned) a drive-relative or backslash path, so which file it names is not certain. Use a forward-slash path (C:/...) or a quoted native path ("C:\\...").`, rule: "ambiguous-drive-path", path: clip(amb), ...sm };
  }
  for (const pat of rules.bashAsk) {
    if (texts.some((t) => bashMatches(pat, t, ctx))) return { kind: "ask", reason: `pi-foreman: this command needs approval (project/session rule '${pat}').`, rule: pat, ...sm };
  }
  for (const w of words) {
    const pat = pathAskHit(rules.pathAsk, w, ctx);
    if (pat) return { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(w)}').`, rule: pat, path: clip(w), ...sm };
  }
  if (written) return protectDecision(written.hit!, written.w, "shell command");
  if (prot.length) return protectDecision(prot[0].hit!, prot[0].w, "shell command", false);
  return null;
}

/**
 * R16 item 4a (ruling.ts): the write surfaces of a shell line as this lexer collects them, with no cd or variable resolution: the words of
 * write redirects, writer operands and removes, and `unnamed` when a unit may write without naming a target (an unknown command, in-place
 * sed, a script run, any PowerShell line: its cmdlet writes are not modelled here). win32 bash lines are lexed a second time with `\` kept
 * literal, as checkShell does.
 */
export function shellWrites(command: string, shell: "posix" | "powershell" = "posix", platform: string = process.platform): { words: string[]; unnamed: boolean } {
  const c: Collected = { unitTexts: [], pipeTexts: [], words: [], removeWords: [], protWords: [], ro: true, writeTargets: new Set(), tmpTargets: new Set(), roTargets: new Set() };
  collect(command, shell, 0, c);
  if (platform === "win32" && shell === "posix") collect(command, "powershell", 0, c);
  const words = [...c.writeTargets!, ...c.tmpTargets!, ...c.roTargets!, ...c.removeWords!].flatMap((w) => [w, ...expandBraces(w)]);
  return { words: [...new Set(words)], unnamed: shell === "powershell" || c.ro === false || c.roUnknown !== undefined || c.roRun === true };
}

/** The only verbs a shell line naming a toolchain probe dir may use (R10 item 3). */
const PROBE_VERBS = new Set(["ls", "stat", "which"]);

/** The shell verbs that may read the foreman's own usage records (MatchCtx.ownReads). */
const USAGE_VERBS = new Set(["ls", "cat", "head", "tail", "wc", "stat", "grep"]);

/** R31c: the grep options an own-record read may carry (bundles of the letters; `-m N -A N -B N -C N` and `--color=never` are handled in ownReadOperands). */
const GREP_OWN_OPT = /^-([nciwvxohHlLsEF]*)(?:([mABC])(\d*))?$/;

/**
 * R31c: the file operands of an own-record read (USAGE_VERBS), or null when a grep option is outside the allowlist. A dash word before `--` is
 * an option; a number is an option value only after `-n`/`-c` of head/tail or `-m/-A/-B/-C` of grep, otherwise an operand; every word after `--`
 * is an operand; the first non-option word of grep is its pattern.
 */
function ownReadOperands(words: string[]): string[] | null {
  const verb = words[0];
  const out: string[] = [];
  let ended = false;
  let pattern = verb !== "grep";
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (ended || !w.startsWith("-")) {
      if (!pattern) pattern = true;
      else out.push(w);
      continue;
    }
    if (w === "--") {
      ended = true;
      continue;
    }
    if (verb === "grep") {
      if (w === "--color=never" || w === "-") continue;
      const m = GREP_OWN_OPT.exec(w);
      if (!m) return null;
      if (m[2] && !m[3]) {
        if (!/^\d+$/.test(words[i + 1] ?? "")) return null;
        i++;
      }
    } else if ((verb === "head" || verb === "tail") && /^-[A-Za-z]*[nc]$/.test(w) && /^[+-]?\d+$/.test(words[i + 1] ?? "")) i++;
  }
  return out;
}

/**
 * R31c: the words of a parsed unit are written in plain quoting (the round-29 stop tokens): single-quoted text is literal, a double-quoted
 * part has no `$` (but a leading `$HOME/`), backtick or backslash, and no ANSI-C `$'..'`, `$".."` or unquoted backslash appears.
 */
function plainQuoting(unit: string[], command: string): boolean {
  return (WORD_SPANS.get(unit) ?? []).every(([s, e]) => {
    const raw = command.slice(s, e);
    // the parser starts a word at the quote of a leading `$".."` (the `$` is dropped), so look one character back
    if (command[s - 1] === "$" && /^["']/.test(raw)) return false;
    let q = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q === "'") q = c === "'" ? "" : q;
      else if (c === "'" || c === '"') {
        if (!q) q = c;
        else if (q === c) q = "";
      } else if (c === "\\" || c === "`") return false;
      else if (c === "$" && (raw[i + 1] === "'" || raw[i + 1] === '"' || (q === '"' && !/^\$\{?HOME\}?\//.test(raw.slice(i))))) return false;
    }
    return true;
  });
}

const USAGE_PY = /^\s*(?:import\s+json\s*;\s*)?print\(\s*(?:open\(\s*(['"])([^'"\\$`]+)\1\s*\)\.read\(\s*\)|json\.load\(\s*open\(\s*(['"])([^'"\\$`]+)\3\s*\)\s*\))\s*\)\s*;?\s*$/;

/**
 * R12 item 2: the D1 code reading `sys.argv[N]` instead of a literal (`python3 -c '…open(sys.argv[N])…' <path>…`); only json/sys imported.
 * The open has no mode or mode 'r'/'rb'; json.load may be followed by literal subscripts (`["state"]`, `[0]`), nothing else.
 */
const USAGE_PY_ARGV = /^\s*(?:import\s+(?:json|sys)(?:\s*,\s*(?:json|sys))?\s*;\s*)*print\(\s*(?:open\(\s*sys\.argv\[[1-9]\](?:\s*,\s*(?:'rb?'|"rb?"))?\s*\)\.read\(\s*\)|json\.load\(\s*open\(\s*sys\.argv\[[1-9]\](?:\s*,\s*(?:'rb?'|"rb?"))?\s*\)\s*\)(?:\[\s*(?:\d+|'[\w.-]*'|"[\w.-]*")\s*\])*)\s*\)\s*;?\s*$/;

/** R14 item 4: the results-file read of the chair's line, `d=json.load(open(sys.argv[N])); print(str(d.get('output') or d.get('results') or d)[-K:])`; fixed text, one file read, nothing else. */
const USAGE_PY_ARGV_TAIL = /^\s*import\s+json\s*,\s*sys\s*;\s*d\s*=\s*json\.load\(\s*open\(\s*sys\.argv\[[1-9]\]\s*\)\s*\)\s*;\s*print\(\s*str\(\s*d\.get\(\s*(['"])output\1\s*\)\s+or\s+d\.get\(\s*(['"])results\2\s*\)\s+or\s+d\s*\)(?:\[\s*-\d{1,5}\s*:\s*\])?\s*\)\s*;?\s*$/;

/**
 * Ruling R10 D1 (an ownStateRead unit): `python3 -c '<code>'` (or `python`) whose code is a single `print(open('<literal>').read())` or
 * `print(json.load(open('<literal>')))` (an `import json;` before it), with no `'w'`/`'a'`, `os.`, `subprocess` or `exec` token, the literal
 * an own record; or `python3 -c <argv code> <path>`.
 */
function usagePyWords(words: string[], patterns: string[], ctx: MatchCtx): boolean {
  if (words.length < 3 || words.length > 12 || !/^python3?$/.test(words[0]) || words[1] !== "-c") return false;
  const code = words[2];
  // the argv form is closed by its regex (only json/sys imports, one print of the file); pythonReadOnlyCode refuses `import json,sys`.
  // Every argv word is an own record and the one index read names one of them.
  if (words.length > 3) {
    const n = Number(/sys\.argv\[(\d)\]/.exec(code)?.[1] ?? 0);
    return (USAGE_PY_ARGV.test(code) || USAGE_PY_ARGV_TAIL.test(code)) && n >= 1 && n <= words.length - 3 && words.slice(3).every((x) => ownLiteral(x, patterns, ctx));
  }
  if (/\bos\.|subprocess|exec|['"][wa]/.test(code) || !pythonReadOnlyCode(code)) return false;
  const m = USAGE_PY.exec(code);
  return ownLiteral(m ? (m[2] ?? m[4]) : undefined, patterns, ctx);
}

/** An absolute literal without `..` whose every spelling (realpath included) matches one of `patterns`. */
function ownLiteral(lit: string | undefined, patterns: string[], ctx: MatchCtx): boolean {
  if (!lit || !path.posix.isAbsolute(lit) || lit.split("/").includes("..")) return false;
  const cands = pathCandidates(lit, ctx).filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x));
  return cands.length > 0 && cands.every((x) => patterns.some((p) => pathMatches(p, x, ctx)));
}

const USAGE_NODE = /^\s*(?:console\.log|process\.stdout\.write)\(\s*require\(\s*(['"])(?:node:)?fs\1\s*\)\.readFileSync\(\s*(['"])([^'"\\$`]+)\2\s*(?:,\s*(['"])utf-?8\4\s*)?\)(?:\.toString\(\s*\))?\s*\)\s*;?\s*$/;

/**
 * R12 item 2 (the node twin of usagePyWords, an ownStateRead unit): `node -e '<code>'` whose code is a single
 * `console.log(require('fs').readFileSync('<literal>'[, 'utf8']))` (or `process.stdout.write(…)`), the literal an own record.
 */
function usageNodeWords(words: string[], patterns: string[], ctx: MatchCtx): boolean {
  if (words.length !== 3 || words[0] !== "node" || words[1] !== "-e") return false;
  const m = USAGE_NODE.exec(words[2]);
  return ownLiteral(m?.[3], patterns, ctx);
}

/** Read-only units a chain naming the own records may hold besides the reads of them (R12 item 2); none of their words may name an own record. */
const CHAIN_READERS = new Set(["grep", "egrep", "fgrep", "rg", "wc", "head", "tail", "cat", "ls", "stat", "echo", "pwd", "true", "false", "sort", "uniq", "cut", "tr"]);
const VERSION_PROBE = /^(?:node|python3?)$/;

/**
 * R12 item 2: the foreman's line reads its own records (ctx.ownReads) in a chain. Every unit is joined by `;`, `&&`, `||` or `|` (no
 * substitution, redirect, background, group or subshell) and is either
 * - a literal binding `name=<path>` alone at the top level after `;` or at the start (`~/`/`$HOME/` expanded, no `$`, glob or space), whose
 *   `$name`/`${name}` later units see as that literal;
 * - a read of the own records: ls/cat/head/tail/wc/stat whose operands are all own records, or the D1 python / node read form;
 * - a read-only unit from CHAIN_READERS naming no own record, or `node|python3 --version`;
 * - R14 item 1: a worktree scratch script given only own records, `node [--experimental-strip-types] <script>.mjs <own>…` or
 *   `python3 <script>.py <own>…`, the script's realpath below `<worktree>/.workflow/scratch/` (ownScratchScript).
 * R14 item 1: the line may start with `cd <worktree> &&` (the session's own worktree root, workspaceOf(ctx.cwd)); a unit's only redirect may
 * be an fd dup `N>&M` (`2>&1`).
 * At least one unit reads an own record. Any other `$` fails. No unit removes (no remover verb; the code of the read forms is fixed, so
 * Collected.removeWords holds only its literals). Write targets and tee are checked by the caller (Collected).
 * R14 item 1: the one own-read decision, shared by the overlay (checkShell ownRead) and review.ts ownUsageAllow (formerly ownReadChain).
 */
export function ownStateRead(command: string, ctx0: MatchCtx): boolean {
  const pats = ctx0.ownReads ?? [];
  if (!pats.length || ctx0.role === "child" || /\$\(|`|[<>]\(/.test(command)) return false;
  const parsed = parseShell(command, "posix");
  if (parsed.subs.length || parsed.seps.some((s) => ![";", "&&", "||", "end"].includes(s))) return false;
  let ctx = ctx0;
  const root = ctx0.cwd ? workspaceOf(ctx0.cwd).root : "";
  const lead = parsed.pipelines[0];
  if (lead?.length === 1 && lead[0][0] === "cd") {
    if (lead[0].length !== 2 || parsed.seps[0] !== "&&" || parsed.pipelines.length < 2 || REDIRECTS.get(lead[0])?.size || !root) return false;
    const real = defaults(ctx0).realpath;
    const d = expandWord(lead[0][1], ctx0);
    if (/[$`\\*?[\]{}\s~]/.test(d) || !path.posix.isAbsolute(d) || real(d) === null || real(d) !== real(root)) return false;
    ctx = { ...ctx0, cwd: root };
  }
  const own = (w: string): boolean => {
    const abs = pathCandidates(w, ctx).filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x));
    return abs.length > 0 && abs.every((x) => pats.some((p) => pathMatches(p, x, ctx)));
  };
  // R31c: grep reads only the session's own usage file (not the whole usage dir) and its own trace and presence files
  // the session's own usage file is the one exact (glob-free) `.jsonl` pattern under state/usage (roundsurface.ts ownUsageReadable)
  const ownUsage = new Set(pats.filter((p) => /\/pi-foreman\/state\/usage\/[^*?[\]{}/]+\.jsonl$/.test(p.replace(/\\/g, "/"))));
  const grepOwn = (w: string): boolean => {
    if (!own(w)) return false;
    return pathCandidates(w, ctx).filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x)).every((x) => {
      const m = /\/pi-foreman\/state\/usage(?:\/(.*))?$/.exec(x.replace(/\\/g, "/"));
      return !m || ownUsage.has(x);
    });
  };
  const vars = new Map<string, string>();
  let reads = 0;
  for (let i = ctx === ctx0 ? 0 : 1; i < parsed.pipelines.length; i++) {
    const pipe = parsed.pipelines[i];
    for (const unit0 of pipe) {
      const unit = fdDupFree(unit0, command);
      if (!unit?.length) return false;
      const bind = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(unit[0]);
      if (bind) {
        if (unit.length !== 1 || pipe.length !== 1 || (i > 0 && parsed.seps[i - 1] !== ";")) return false;
        if (["HOME", "FOREMAN_SCRATCH", "USERPROFILE", "S", "PATH", "PWD"].includes(bind[1])) return false;
        const v = expandWord(bind[2], ctx);
        if (!v || /[$`\\*?[\]{}\s~]/.test(v) || !path.posix.isAbsolute(v)) return false;
        vars.set(bind[1], v);
        continue;
      }
      const words = unit.map((w) => w.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a: string | undefined, b: string | undefined) => vars.get((a ?? b)!) ?? m));
      if (words.some((w) => /[$`]/.test(w.replace(/^\$(?:\{HOME\}|HOME)(?=\/)/, "")))) return false;
      const verb = words[0];
      if (usagePyWords(words, pats, ctx) || usageNodeWords(words, pats, ctx)) {
        reads++;
        continue;
      }
      if (USAGE_VERBS.has(verb) && protectedReader(words, new Set()) && (verb !== "grep" || plainQuoting(unit0, command))) {
        const operands = ownReadOperands(words);
        if (operands?.length && operands.every(verb === "grep" ? grepOwn : own)) {
          reads++;
          continue;
        }
      }
      if (root && ownScratchScript(words, root, ctx) && words.slice(words[1] === "--experimental-strip-types" ? 3 : 2).every(own)) {
        reads++;
        continue;
      }
      if (words.slice(1).some(own)) return false;
      // R31c: a chain unit that is not an own-record read names no other state or trace file (another session's trace, usage or presence record)
      if (words.slice(1).some((w) => pathCandidates(w, ctx).some((x) => /\/pi-foreman\/state(?:\/|$)|\/trace-[^/]*\.jsonl$/.test(x.replace(/\\/g, "/"))))) return false;
      if (VERSION_PROBE.test(verb) && words.length === 2 && (words[1] === "--version" || words[1] === "-V" || words[1] === "-v")) continue;
      // R14 item 4: the chair's `…; git log --oneline -8` tail (plain history flags only, no pager/format/output option)
      if (verb === "git" && words[1] === "log" && words.slice(2).every((w, k, a) => /^(?:--oneline|--decorate|--graph|--stat|-\d{1,3}|--max-count=\d{1,3})$/.test(w) || (/^\d{1,3}$/.test(w) && a[k - 1] === "-n") || w === "-n")) continue;
      if (!CHAIN_READERS.has(verb)) return false;
      // R31c: a grep chain unit is no recursive read and names no directory (as the own-read grep unit), so no link or ancestor dir is followed
      if (verb === "grep" && words.slice(1).some((w) => /^-[A-Za-z]*[rRd]|^--(?:dereference-)?recursive$|^--directories/.test(w) || pathCandidates(w, ctx).some((x) => { try { return fs.statSync(x).isDirectory(); } catch { return false; } }))) return false;
      if (PROTECTED_READERS.has(verb) ? !protectedReader(words, new Set()) : !unitReadOnly(words, new Set())) return false;
    }
  }
  return reads > 0;
}

/**
 * The words of a parsed unit without its fd dup redirects (`2>&1`, `>&2`: the operand a single digit right after `>&` in `command`), or null
 * when the unit has any other redirect.
 */
function fdDupFree(unit: string[], command: string): string[] | null {
  const r = REDIRECTS.get(unit);
  if (!r?.size) return unit;
  const spans = WORD_SPANS.get(unit);
  for (const k of r) {
    const s = spans?.[k]?.[0];
    if (s === undefined || !/^\d$/.test(unit[k]) || command.slice(s - 2, s + 1) !== `>&${unit[k]}` || /[<>&]/.test(command[s - 3] ?? "")) return null;
  }
  return unit.filter((_, k) => !r.has(k));
}

/**
 * R14 item 1: `node [--experimental-strip-types] <script>.mjs …` or `python3 <script>.py …` whose script word (no `$`, glob or `~`) resolves
 * against ctx.cwd to an existing file whose realpath lies below the realpath of `<root>/.workflow/scratch/` (no parent, sibling or symlink
 * escape). The operands are checked by the caller.
 */
function ownScratchScript(words: string[], root: string, ctx: MatchCtx): boolean {
  const node = words[0] === "node";
  if (!node && words[0] !== "python3") return false;
  const script = words[node && words[1] === "--experimental-strip-types" ? 2 : 1];
  if (!script || script.startsWith("-") || /[$`*?[\]{}\s~\\]/.test(script) || !script.endsWith(node ? ".mjs" : ".py") || !ctx.cwd) return false;
  const real = defaults(ctx).realpath;
  const dir = real(path.join(root, ".workflow", "scratch"));
  const file = real(path.resolve(ctx.cwd, script));
  return !!dir && !!file && file !== dir && insideDir(dir, file, ctx) && !defaults(ctx).isDir(file);
}

/** The strictest write-protection decision for one path word (deny before ask), or null. */
function protectHit(rules: ProtectRule[], word: string, ctx: MatchCtx, shell: boolean, remove = false, readOnly = false, ownRead = false): ProtectHit | null {
  const child = ctx.role === "child";
  let ask: ProtectHit | null = null;
  const cands = pathCandidates(word, ctx);
  if (ownRead && shell && !child && ctx.ownReads?.length) {
    // a binding `name=<own record>` (ownStateRead) writes nothing: its value is the path
    const bind = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(word);
    // a word with white space that is the code of the node read form (USAGE_NODE) is split into tokens: its absolute tokens must be own records, its code
    // fragments (`.readFileSync`) are no paths of the line (posix only)
    const tokens = /\s/.test(word) && ctx.platform !== "win32" && USAGE_NODE.test(word) ? word.split(/[\s'"`(),;<>]+/).filter((t) => /^(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)/.test(t)) : null;
    const abs = (tokens ? tokens.flatMap((t) => pathCandidates(t, ctx)) : bind ? pathCandidates(word.slice(bind[0].length), ctx) : cands).filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x));
    if (abs.length && abs.every((x) => ctx.ownReads!.some((p) => pathMatches(p, x, ctx)))) return null;
  }
  if (readOnly && shell && ctx.ownTasks?.length) {
    const abs = cands.filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x));
    if (abs.length && abs.every((x) => ctx.ownTasks!.some((p) => pathMatches(p, x, ctx)))) return null;
  }
  // a named skill is read, not written: only the childDeny `.agents` rules step aside, and only when every absolute candidate lies in a skill dir
  let skillRead = false;
  if (readOnly && shell && child && ctx.skillDirs?.length) {
    const abs = cands.filter((x) => path.isAbsolute(x) || path.win32.isAbsolute(x));
    skillRead = abs.length > 0 && abs.every((x) => ctx.skillDirs!.some((d) => insideDir(d, x, ctx)));
  }
  const guessed = ctx.platform === "win32" ? shortNameVariants(cands, rules.map((r) => r.pattern)) : [];
  // the foreman's own roots (owned.ts): its writeAsk rules (the package root) do not ask below them, except the handoff files `parent`/`child`
  const owned = !child && ctx.owned?.readWrite.length ? ctx.owned.readWrite : [];
  const inOwned = (x: string): boolean => owned.some((o) => insideDir(o, x, ctx));
  for (const r of rules) {
    if (r.removeOnly && !remove) continue;
    if (skillRead && r.fromChildDeny && r.pattern.includes(".agents")) continue;
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
  // win32: os.tmpdir() may be an 8.3 short name (`C:\Users\RUNNER~1\...`) that fs.realpathSync keeps; the native realpath gives the long one
  if (ctx.platform === "win32") return [...new Set(raw.flatMap((r) => [r, fsx.realpath(r), nativeReal(ctx)(r)]).filter((x): x is string => !!x))];
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
  if (ctx.platform === "win32") return childTmpWriteDenyWin32(word, ctx, scratch, roots, own);
  for (const cand of pathCandidates(word, ctx)) {
    if (!roots.some((r) => insideDir(r, cand, ctx))) continue;
    if (own.some((o) => insideDir(o, cand, ctx))) continue;
    return { kind: "deny", reason: `pi-foreman: write to ${clip(word)} denied for a child: use FOREMAN_SCRATCH (${scratch}), not /tmp.` };
  }
  return null;
}

/** win32: fs.realpathSync.native (GetFinalPathNameByHandle expands 8.3 short names), or the injected ctx.realpathNative. */
function nativeReal(ctx: MatchCtx): (p: string) => string | null {
  return ctx.realpathNative ?? ((p) => { try { return fs.realpathSync.native(p); } catch { return null; } });
}

/**
 * childTmpWriteDeny on win32: an 8.3 short name and its long name are one directory, so the candidates and the child's own dirs are
 * also compared in their native-realpath spelling (the deepest existing ancestor, tail re-appended): a candidate with either spelling
 * below a temp root is denied unless it lies inside an own dir; its native spelling counts for that only when no symlink is on its way
 * (the JS realpath leaves it unchanged), so a link in the temp dir that points into the scratch stays denied as before.
 */
function childTmpWriteDenyWin32(word: string, ctx: MatchCtx, scratch: string, roots: string[], own0: (string | null | undefined)[]): Decision | null {
  const nat = nativeReal(ctx);
  const nfsx = { ...defaults(ctx), realpath: nat };
  const own = [...own0, ...own0.map((o) => (o ? nat(o) : null))].filter((x): x is string => !!x);
  for (const cand of pathCandidates(word, ctx)) {
    const abs = path.win32.resolve(ctx.cwd, cand);
    const spellings = [cand, realDeep(abs, path.win32, nfsx)].filter((x): x is string => !!x);
    if (!spellings.some((s) => roots.some((r) => insideDir(r, s, ctx)))) continue;
    const js = realDeep(abs, path.win32, defaults(ctx));
    const noLink = !js || js.toLowerCase() === abs.toLowerCase();
    if ((noLink ? spellings : [cand]).some((s) => own.some((o) => insideDir(o, s, ctx)))) continue;
    return { kind: "deny", reason: `pi-foreman: write to ${clip(word)} denied for a child: use FOREMAN_SCRATCH (${scratch}), not /tmp.` };
  }
  return null;
}

/** win32: a path word Git Bash leaves drive-relative (`C:x`, an unquoted `C:\x`) or with a `\` while not absolute (`a\b`). */
const WIN_ABS = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;
const winAmbiguousWord = (w: string): boolean => /^[A-Za-z]:(?![\\/])/.test(w) || (w.includes("\\") && !WIN_ABS.test(w));

/**
 * win32 bash line (words of the posix pass, as bash runs them): `target` is the first write target (redirect, writer operand) that is
 * an ambiguous word; `word` the first ambiguous path operand; `viaVar` the first path operand referencing a name the line assigns a
 * drive-relative or backslash-bearing literal that is not absolute after unescaping (`H=C:\w; cat $H/f`; the grammar never resolves it).
 */
function winAmbiguity(command: string, c: Collected): { target?: string; word?: string; viaVar?: string } {
  const targets = [...c.writeTargets!, ...c.tmpTargets!, ...c.roTargets!];
  const names = new Set<string>();
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=((?:[^\s;&|()<>'"\\]|\\.|'[^']*'|"(?:[^"\\]|\\.)*")*)/g)) {
    const raw = m[2];
    const v = parseShell(`: ${raw}`, "posix").pipelines[0]?.[0]?.[1] ?? "";
    if ((raw.includes("\\") || /^[A-Za-z]:(?![\\/])/.test(v)) && !WIN_ABS.test(v)) names.add(m[1]);
  }
  const words = c.protWords ?? [];
  return {
    target: targets.find(winAmbiguousWord),
    word: words.find(winAmbiguousWord),
    viaVar: names.size ? [...words, ...targets].find((w) => refsBound(w, names)) : undefined,
  };
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

/** R17: `word` (resolved against the session cwd, `..` folded) lies strictly below the session's own `{cwd}/.pi/scratch`. */
function ownScratch(ctx: MatchCtx, word: string, shell = false): boolean {
  // the shell lexer resolves no `$var`, substitution or glob: only literal words (a path tool's input is no shell word)
  if (shell && !/^[\w./@+:-]+$/.test(word)) return false;
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const fold = (s: string): string => (foldsCase(ctx.platform) ? s.toLowerCase() : s);
  const inside = (root: string, x: string): boolean => {
    const rel = p.relative(fold(root), fold(p.resolve(ctx.cwd, x)));
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + p.sep) && !p.isAbsolute(rel);
  };
  if (!inside(p.resolve(ctx.cwd, ".pi", "scratch"), word)) return false;
  // the protect match follows links: every spelling it sees, the realpath included, must lie in the real scratch dir (fail closed)
  try {
    const fsx = defaults(ctx);
    const root = fsx.realpath(p.resolve(ctx.cwd, ".pi", "scratch"));
    const realCwd = fsx.realpath(ctx.cwd);
    // the root itself must not be a link (`.pi/scratch -> .pi`, or `.pi` a link): else the carve-out would move onto `.pi/*`
    if (!root || !realCwd || fold(root) !== fold(p.join(realCwd, ".pi", "scratch"))) return false;
    const real = (x: string): string | null => realDeep(p.resolve(ctx.cwd, x), p, fsx);
    for (const c of pathCandidates(word, ctx)) {
      const r = real(c);
      if (!r || !inside(root, r)) return false;
    }
    const abs = p.resolve(ctx.cwd, word);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(abs); } catch { st = null; }
    if (st?.isSymbolicLink()) {
      const r = fsx.realpath(abs);
      if (!r || !inside(root, r)) return false;
      try { st = fs.lstatSync(r); } catch { return false; }
    }
    return !(st && !st.isDirectory() && st.nlink > 1);
  } catch {
    return false;
  }
}

function protectDecision(hit: ProtectHit, word: string, what: string, selfMod = true): Decision {
  const how = hit.shortName ? `matched '${clip(word)}' read as a Windows 8.3 short name, which may be the protected path,` : `matched '${clip(word)}'`;
  return hit.kind === "deny"
    ? { kind: "deny", reason: `pi-foreman: denied by the write protection (rule '${hit.rule.pattern}' ${how} in a ${what}). Git internals, agent and harness configuration are off limits${hit.rule.main === "ask" ? " to subagents; ask the foreman" : ""}.${hit.rule.fromWriteAsk ? " The foreman stages and commits this file; report the needed change." : ""}` }
    : { kind: "ask", reason: `pi-foreman: this changes protected configuration (rule '${hit.rule.pattern}' ${how} in a ${what}) and needs approval.`, rule: hit.rule.pattern, path: clip(word), ...(selfMod ? { selfMod: true as const } : {}) };
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
  // R16 item 1: as in checkShell, an ask after a protect ask hit is self-modification
  const selfProt = prot.filter((x) => !ownScratch(ctx, x.w));
  const sm = selfProt.length ? { selfMod: true as const } : {};
  for (const { value } of paths) {
    const pat = pathAskHit(rules.pathAsk, value, ctx);
    if (pat) return { kind: "ask", reason: `pi-foreman: this path needs approval (project/session rule '${pat}' matched '${clip(value)}').`, rule: pat, path: clip(value), ...sm };
  }
  // R10 item 3: in a toolchain probe dir only the ls tool lists without approval
  if (toolName !== "ls") {
    const pv = paths.find((x) => probeHit(rules, x.value, ctx) !== null);
    if (pv) return { kind: "ask", reason: `pi-foreman: '${clip(pv.value)}' is in a toolchain bin dir or the npx cache: only the ls tool (or a plain ls/stat/which shell line) may look there without approval.`, rule: "toolchain-probe", path: clip(pv.value), ...sm };
  }
  return prot.length ? protectDecision(prot[0].hit!, prot[0].w, `${toolName} call`, selfProt.length > 0) : null;
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
