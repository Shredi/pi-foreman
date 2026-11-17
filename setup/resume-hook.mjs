// The shell block that restarts a Pi session in its pane after a crash: at a prompt of a shell the block runs `foreman pane-resume`
// when a pane note exists for the terminal (docs/herdr.md). Pure over its inputs (home, shell, platform, the foreman command), so tests never
// touch a real profile. The block has its own markers; it is independent of the env block of persist-env.mjs.
import * as fs from "node:fs";
import * as path from "node:path";

export const RESUME_START = "# >>> pi-foreman resume >>>";
export const RESUME_END = "# <<< pi-foreman resume <<<";

const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

const EDITIONS = {
  pwsh: { dir: "PowerShell", label: "PowerShell 7" },
  powershell: { dir: "WindowsPowerShell", label: "Windows PowerShell 5.1" },
};

/**
 * The files the block goes to, by login shell: zsh `~/.zshrc`; bash `~/.bashrc` and the first existing of `.bash_profile`, `.bash_login`, `.profile`; fish its own conf.d file. Others: none.
 * On win32 (`platform`) the shell is ignored: the current-user profile of each PowerShell edition in `editions` ("pwsh", "powershell") under `documents`
 * (default `<home>/Documents`), and with `gitBash` Git Bash's `~/.bashrc` and the first existing login file.
 */
export function resumeTargets({ home, shell = "", platform = "", documents, editions = [], gitBash = false }) {
  if (platform === "win32") {
    const docs = documents || path.join(home, "Documents");
    const out = editions.filter((e) => EDITIONS[e]).map((e) => ({ file: path.join(docs, EDITIONS[e].dir, "Microsoft.PowerShell_profile.ps1"), flavor: "powershell", edition: e }));
    if (gitBash) {
      out.push({ file: path.join(home, ".bashrc"), flavor: "gitbash" });
      const login = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(home, f)).find((f) => fs.existsSync(f));
      if (login) out.push({ file: login, flavor: "gitbash" });
    }
    return out;
  }
  const name = path.basename(String(shell));
  if (name === "zsh") return [{ file: path.join(home, ".zshrc"), flavor: "zsh" }];
  if (name === "fish") return [{ file: path.join(home, ".config", "fish", "conf.d", "pi-foreman-resume.fish"), flavor: "fish" }];
  if (name === "bash") {
    const out = [{ file: path.join(home, ".bashrc"), flavor: "bash" }];
    const login = [".bash_profile", ".bash_login", ".profile"].map((f) => path.join(home, f)).find((f) => fs.existsSync(f));
    if (login) out.push({ file: login, flavor: "bash" });
    return out;
  }
  return [];
}

// The function saves `$?` on entry and returns it on every path, so a later PROMPT_COMMAND entry or precmd hook still sees the status of the user's command.
// A prompt with no note costs only file tests. A note is checked when this shell has not checked one yet or the note is newer than the shell's
// marker file (touched before each check, in $XDG_RUNTIME_DIR when set, else $TMPDIR); a kept note that did not change is not checked again.
// A missing marker (tmp cleaner, unwritable dir) means check; the hook removes the marker itself when the command asks for a recheck (exit 75:
// Pi is still ending) or could not run (exit 127: no node yet), so the next prompt checks again. `>|` keeps the touch working under noclobber.
// Git Bash (win32) differs in two places: the agent dir may be a Windows path (`cygpath -u`), and the shell pid handed to the command is the Windows pid of this
// shell (`/proc/$$/winpid`), the one `hc get` and the process table know; the marker keeps `$$`.
const POSIX_BODY = (bin, gitBash = false) => [
  "__pi_foreman_resume() {",
  "  __pi_foreman_rc=$?",
  "  [ -n \"${HC_TERMINAL_ID:-}\" ] || return \"$__pi_foreman_rc\"",
  "  [ -t 0 ] || return \"$__pi_foreman_rc\"",
  ...(gitBash
    ? [
        "  __pi_foreman_dir=\"${PI_CODING_AGENT_DIR:+$(cygpath -u \"$PI_CODING_AGENT_DIR\" 2>/dev/null)}\"",
        "  __pi_foreman_note=\"${__pi_foreman_dir:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}/pi-foreman/state/panes/$HC_TERMINAL_ID.json\"",
      ]
    : ["  __pi_foreman_note=\"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-foreman/state/panes/$HC_TERMINAL_ID.json\""]),
  "  [ -f \"$__pi_foreman_note\" ] || return \"$__pi_foreman_rc\"",
  "  __pi_foreman_mark=\"${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/pi-foreman-resume.$$\"",
  "  if [ -n \"${__pi_foreman_resume_seen:-}\" ] && [ -e \"$__pi_foreman_mark\" ] && ! [ \"$__pi_foreman_note\" -nt \"$__pi_foreman_mark\" ]; then return \"$__pi_foreman_rc\"; fi",
  `  [ -x ${q(bin)} ] || return "$__pi_foreman_rc"`,
  "  __pi_foreman_resume_seen=1",
  "  : >| \"$__pi_foreman_mark\" 2>/dev/null",
  gitBash ? `  ${q(bin)} pane-resume --shell-pid "$(cat /proc/$$/winpid 2>/dev/null || echo $$)"` : `  ${q(bin)} pane-resume --shell-pid "$$"`,
  "  case $? in 75|127) rm -f \"$__pi_foreman_mark\" ;; esac",
  "  return \"$__pi_foreman_rc\"",
  "}",
];

const pq = (v) => `'${String(v).replace(/'/g, "''")}'`;

// PowerShell (5.1 and 7): the prompt function present when the profile loads is wrapped once per session. The wrapper keeps `$?` and `$LASTEXITCODE` for the
// prompt of a theme and never fails. A note is checked when this session has not checked one yet or the note is newer than the session's marker file (as the
// POSIX body). `node` runs through Start-Process without -Wait: -Wait would also wait for Pi's detached children; the handle is read first so ExitCode is kept.
// The test seam is `__PiForemanResume` (the redirected-input guard), which `__PiForemanResumeCheck` follows.
const POWERSHELL_BODY = (cli) => [
  "function __PiForemanResumeCheck {",
  "  if (-not $env:HC_TERMINAL_ID) { return }",
  "  $dir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi\\agent' }",
  "  $note = Join-Path $dir ('pi-foreman\\state\\panes\\' + $env:HC_TERMINAL_ID + '.json')",
  "  if (-not (Test-Path -LiteralPath $note -PathType Leaf)) { return }",
  "  $mark = Join-Path $env:TEMP ('pi-foreman-resume.' + $PID)",
  "  if ((Get-Variable -Name __PiForemanResumeSeen -Scope Global -ValueOnly -ErrorAction Ignore) -and (Test-Path -LiteralPath $mark) -and -not ((Get-Item -LiteralPath $note).LastWriteTimeUtc -gt (Get-Item -LiteralPath $mark).LastWriteTimeUtc)) { return }",
  `  $cli = ${pq(cli)}`,
  "  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { return }",
  "  $global:__PiForemanResumeSeen = $true",
  "  try { [IO.File]::WriteAllText($mark, '') } catch { }",
  "  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  if (-not $node) { Remove-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue; return }",
  "  $ver = $null",
  "  try { $ver = [version]((& $node.Source --version) -replace '^v', '') } catch { }",
  "  if (-not $ver -or $ver -lt [version]'22.6') { return }",
  "  $p = Start-Process -NoNewWindow -PassThru -FilePath $node.Source -ArgumentList ('--no-warnings --experimental-strip-types \"' + $cli + '\" --shell-pid ' + $PID)",
  "  $null = $p.Handle",
  "  $p.WaitForExit()",
  "  if ($p.ExitCode -eq 75) { Remove-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue }",
  "}",
  "function __PiForemanResume {",
  "  if ([Console]::IsInputRedirected) { return }",
  "  __PiForemanResumeCheck",
  "}",
  "if (-not (Get-Variable -Name __PiForemanResumeWrapped -Scope Global -ValueOnly -ErrorAction Ignore)) {",
  "  $global:__PiForemanResumeWrapped = $true",
  "  $__fn = Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue | Select-Object -First 1",
  "  $global:__PiForemanOriginalPrompt = if ($__fn) { $__fn.ScriptBlock } else { $null }",
  "  function prompt {",
  "    $__ok = $?",
  "    $__rc = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore",
  "    $__orig = Get-Variable -Name __PiForemanOriginalPrompt -Scope Global -ValueOnly -ErrorAction Ignore",
  "    try { $null = __PiForemanResume } catch { }",
  "    $global:LASTEXITCODE = $__rc",
  "    if (-not $__ok) { Write-Error '-' -ErrorAction Ignore }",
  "    if ($__orig) { & $__orig } else { 'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($nestedPromptLevel + 1)) + ' ' }",
  "  }",
  "}",
];

/**
 * The marked block for one shell flavor ("zsh", "bash", "fish", "gitbash", "powershell") running the foreman command `bin` (an absolute path).
 * The PowerShell block runs `cli` (the path of paneresume-cli.ts; default: next to `bin`'s package) through node itself.
 */
export function renderResumeBlock({ bin, flavor, cli }) {
  const head = [RESUME_START, "# restarts the Pi session of this pane after a crash; remove with: foreman setup --no-resume-hook"];
  if (flavor === "powershell") {
    const P = String(bin).includes("\\") ? path.win32 : path;
    return [...head, ...POWERSHELL_BODY(cli || P.join(P.dirname(P.dirname(String(bin))), "extensions", "core-adapter", "paneresume-cli.ts")), RESUME_END].join("\n");
  }
  if (flavor === "gitbash") bin = String(bin).replace(/\\/g, "/");
  if (flavor === "fish") {
    return [
      ...head,
      "function __pi_foreman_resume --on-event fish_prompt",
      "    set -l last $status",
      "    test -n \"$HC_TERMINAL_ID\"; or return $last",
      "    set -l dir $HOME/.pi/agent",
      "    test -n \"$PI_CODING_AGENT_DIR\"; and set dir $PI_CODING_AGENT_DIR",
      "    set -l note \"$dir/pi-foreman/state/panes/$HC_TERMINAL_ID.json\"",
      "    test -f \"$note\"; or return $last",
      "    set -l tmp /tmp",
      "    test -n \"$TMPDIR\"; and set tmp $TMPDIR",
      "    test -n \"$XDG_RUNTIME_DIR\"; and set tmp $XDG_RUNTIME_DIR",
      "    set -l mark \"$tmp/pi-foreman-resume.$fish_pid\"",
      "    if set -q __pi_foreman_resume_seen; and test -e \"$mark\"; and not test \"$note\" -nt \"$mark\"",
      "        return $last",
      "    end",
      `    test -x ${q(bin)}; or return $last`,
      "    set -g __pi_foreman_resume_seen 1",
      "    : > \"$mark\" 2>/dev/null",
      `    ${q(bin)} pane-resume --shell-pid $fish_pid`,
      "    set -l rc $status",
      "    if test $rc -eq 75; or test $rc -eq 127; rm -f \"$mark\"; end",
      "    return $last",
      "end",
      RESUME_END,
    ].join("\n");
  }
  if (flavor === "zsh") {
    return [...head, "if [ -n \"${ZSH_VERSION:-}\" ]; then", ...POSIX_BODY(bin).map((l) => `  ${l}`), "  autoload -Uz add-zsh-hook && add-zsh-hook precmd __pi_foreman_resume", "fi", RESUME_END].join("\n");
  }
  // bash: sh and dash read ~/.profile too, so the body runs only under bash; PROMPT_COMMAND gets the function once, by content
  return [
    ...head,
    "if [ -n \"${BASH_VERSION:-}\" ]; then",
    ...POSIX_BODY(bin, flavor === "gitbash").map((l) => `  ${l}`),
    "  case \"${PROMPT_COMMAND:-}\" in",
    "    *__pi_foreman_resume*) ;;",
    "    *) PROMPT_COMMAND=\"__pi_foreman_resume${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;;",
    "  esac",
    "fi",
    RESUME_END,
  ].join("\n");
}

/** `text` without the marked block (and the one newline after it); the same text when there is none. */
export function stripResumeBlock(text) {
  const e = text.indexOf(RESUME_END);
  const s = e >= 0 ? text.lastIndexOf(RESUME_START, e) : -1;
  if (s < 0 || e < 0) return text;
  let end = e + RESUME_END.length;
  if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
  else if (text[end] === "\n") end++;
  let start = s;
  if (start >= 4 && text.slice(start - 4, start) === "\r\n\r\n") start -= 2; // CRLF file: the blank line before it
  else if (start >= 2 && text[start - 1] === "\n" && text[start - 2] === "\n") start--; // the blank line mergeBlock put before it
  return text.slice(0, start) + text.slice(end);
}

/**
 * Writes (or with `remove` takes out) the resume block in the target files. Returns the lines to print. Nothing is written on `dry`.
 * A file that holds only the block (fish) is deleted by a removal.
 */
export function applyResumeHook({ home, shell = "", bin, dry = false, remove = false, platform = "", documents, editions = [], policy = {}, gitBash = false, cli }) {
  const out = [];
  const targets = resumeTargets({ home, shell, platform, documents, editions, gitBash });
  if (targets.length === 0) {
    if (remove) return out;
    if (platform === "win32") out.push("resume hook: no PowerShell profile or Git Bash found; add the block by hand (docs/install.md).");
    else out.push(`resume hook: shell ${path.basename(String(shell)) || "unknown"} is not zsh, bash or fish; add the block by hand (docs/install.md).`);
    return out;
  }
  for (const t of targets) {
    if (t.flavor === "powershell") {
      out.push(...applyPowerShell(t, { bin, cli, dry, remove, policy: policy[t.edition] }));
      continue;
    }
    let cur = null;
    try {
      cur = fs.readFileSync(t.file, "utf8");
    } catch {
      cur = null;
    }
    try {
      if (remove) {
        if (cur === null || !cur.includes(RESUME_START)) continue;
        const next = stripResumeBlock(cur);
        if (dry) out.push(`resume hook: would remove the pi-foreman block from ${t.file}`);
        else {
          if (next.trim() === "" && t.flavor === "fish") fs.unlinkSync(t.file);
          else fs.writeFileSync(t.file, next);
          out.push(`resume hook: removed the pi-foreman block from ${t.file}`);
        }
        continue;
      }
      const block = renderResumeBlock({ bin, flavor: t.flavor });
      const next = mergeBlockWith(cur ?? "", block);
      if (next === cur) out.push(`resume hook: already in ${t.file}`);
      else if (dry) out.push(`resume hook: would write the pi-foreman resume block to ${t.file}`);
      else {
        fs.mkdirSync(path.dirname(t.file), { recursive: true });
        fs.writeFileSync(t.file, next);
        out.push(`resume hook: wrote the pi-foreman resume block to ${t.file}; open a new shell for it to apply`);
      }
    } catch (err) {
      out.push(`WARN resume hook: could not change ${t.file} (${err.message}); see docs/install.md to add the block by hand`);
    }
  }
  return out;
}

// persist-env.mjs mergeBlock is bound to the env markers (it would replace that block), so the resume block is merged here the same way
function mergeBlockWith(text, block, eol = "\n") {
  const e = text.indexOf(RESUME_END);
  const s = e >= 0 ? text.lastIndexOf(RESUME_START, e) : -1;
  if (s >= 0 && e >= 0) return text.slice(0, s) + block + text.slice(e + RESUME_END.length);
  const sep = text === "" || text.endsWith(eol + eol) ? "" : text.endsWith(eol) ? eol : eol + eol;
  return `${text}${sep}${block}${eol}`;
}

const BOM8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM16LE = Buffer.from([0xff, 0xfe]);
const isAscii = (s) => !/[^\x00-\x7f]/.test(s);
const handAdd = (file, why) => `resume hook: ${file} not changed (${why}); add the block by hand (docs/install.md).`;
const NO_PROFILE_POLICY = new Set(["Restricted", "AllSigned", "Undefined"]);

/**
 * One PowerShell profile. Encodings: a new file is UTF-8 with BOM; a UTF-8 BOM or UTF-16LE file keeps its encoding; UTF-16BE is skipped; a file without BOM
 * is read and written byte for byte (latin1) while the block is ASCII, so ANSI bytes survive; a block with non-ASCII characters (a path) goes into a BOM-less
 * file only for PowerShell 7 (reads BOM-less as UTF-8) and only when the file is valid UTF-8; Windows PowerShell 5.1 reads BOM-less as ANSI, so it is skipped.
 * A removal never needs the block text, so it round-trips any BOM-less file byte for byte.
 */
function applyPowerShell(t, { bin, cli, dry, remove, policy }) {
  const label = EDITIONS[t.edition].label;
  let buf = null;
  try {
    buf = fs.readFileSync(t.file);
  } catch {
    buf = null;
  }
  try {
    let enc = "bom8";
    let cur = null;
    if (buf) {
      if (buf.subarray(0, 3).equals(BOM8)) [enc, cur] = ["bom8", buf.subarray(3).toString("utf8")];
      else if (buf.subarray(0, 2).equals(BOM16LE)) [enc, cur] = ["utf16le", buf.subarray(2).toString("utf16le")];
      else if (buf[0] === 0xfe && buf[1] === 0xff) return remove ? [] : [handAdd(t.file, "it is UTF-16 big-endian")];
      else [enc, cur] = ["latin1", buf.toString("latin1")];
    }
    const encode = (text) => (enc === "bom8" ? Buffer.concat([BOM8, Buffer.from(text, "utf8")]) : enc === "utf16le" ? Buffer.concat([BOM16LE, Buffer.from(text, "utf16le")]) : Buffer.from(text, enc));
    if (remove) {
      if (cur === null || !cur.includes(RESUME_START)) return [];
      const next = stripResumeBlock(cur);
      if (dry) return [`resume hook: would remove the pi-foreman block from ${t.file}`];
      fs.writeFileSync(t.file, encode(next));
      return [`resume hook: removed the pi-foreman block from ${t.file}`];
    }
    let block = renderResumeBlock({ bin, flavor: "powershell", cli });
    if (buf && enc === "latin1" && !isAscii(block)) {
      let valid = null;
      try {
        valid = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        valid = null;
      }
      if (t.edition !== "pwsh") return [handAdd(t.file, "the block holds non-ASCII characters and Windows PowerShell 5.1 reads a file without a byte order mark as ANSI")];
      if (valid === null) return [handAdd(t.file, "the block holds non-ASCII characters and the file is not valid UTF-8")];
      [enc, cur] = ["utf8", valid];
    }
    const eol = cur !== null && cur.includes("\r\n") ? "\r\n" : "\n";
    block = block.replace(/\n/g, eol);
    const next = mergeBlockWith(cur ?? "", block, eol);
    const lines = [];
    const warn = policy && NO_PROFILE_POLICY.has(policy) ? `; the ${label} profile does not load under execution policy ${policy === "Undefined" ? "Restricted" : policy}, allow it with: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` : "";
    if (next === cur) lines.push(`resume hook: already in ${t.file}${warn}`);
    else if (dry) lines.push(`resume hook: would write the pi-foreman resume block to ${t.file}${warn}`);
    else {
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      fs.writeFileSync(t.file, encode(next));
      lines.push(`resume hook: wrote the pi-foreman resume block to ${t.file}; open a new shell for it to apply${warn}`);
    }
    return lines;
  } catch (err) {
    return [`WARN resume hook: could not change ${t.file} (${err.message}); see docs/install.md to add the block by hand`];
  }
}
