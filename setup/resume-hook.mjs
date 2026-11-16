// The shell block that restarts a Pi session in its pane after a crash: at the first prompt of a shell the block runs `foreman pane-resume`
// when a pane note exists for the terminal (docs/herdr.md). Pure over its inputs (home, shell, platform, the foreman command), so tests never
// touch a real profile. The block has its own markers; it is independent of the env block of persist-env.mjs.
import * as fs from "node:fs";
import * as path from "node:path";

export const RESUME_START = "# >>> pi-foreman resume >>>";
export const RESUME_END = "# <<< pi-foreman resume <<<";

const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** The files the block goes to, by login shell: zsh `~/.zshrc`; bash `~/.bashrc` and the first existing of `.bash_profile`, `.bash_login`, `.profile`; fish its own conf.d file. Others: none. */
export function resumeTargets({ home, shell = "" }) {
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

const POSIX_BODY = (bin) => [
  "__pi_foreman_resume() {",
  "  [ -z \"${__pi_foreman_resume_ran:-}\" ] || return 0",
  "  __pi_foreman_resume_ran=1",
  "  [ -n \"${HC_TERMINAL_ID:-}\" ] || return 0",
  "  [ -t 0 ] || return 0",
  "  [ -f \"${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/pi-foreman/state/panes/$HC_TERMINAL_ID.json\" ] || return 0",
  `  [ -x ${q(bin)} ] || return 0`,
  `  ${q(bin)} pane-resume --shell-pid "$$"`,
  "  return 0",
  "}",
];

/** The marked block for one shell flavor ("zsh", "bash", "fish") running the foreman command `bin` (an absolute path). */
export function renderResumeBlock({ bin, flavor }) {
  const head = [RESUME_START, "# restarts the Pi session of this pane after a crash; remove with: foreman setup --no-resume-hook"];
  if (flavor === "fish") {
    return [
      ...head,
      "function __pi_foreman_resume --on-event fish_prompt",
      "    set -q __pi_foreman_resume_ran; and return 0",
      "    set -g __pi_foreman_resume_ran 1",
      "    test -n \"$HC_TERMINAL_ID\"; or return 0",
      "    set -l dir $HOME/.pi/agent",
      "    test -n \"$PI_CODING_AGENT_DIR\"; and set dir $PI_CODING_AGENT_DIR",
      "    test -f \"$dir/pi-foreman/state/panes/$HC_TERMINAL_ID.json\"; or return 0",
      `    test -x ${q(bin)}; or return 0`,
      `    ${q(bin)} pane-resume --shell-pid $fish_pid`,
      "    return 0",
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
    ...POSIX_BODY(bin).map((l) => `  ${l}`),
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
  if (text[end] === "\n") end++;
  let start = s;
  if (start >= 2 && text[start - 1] === "\n" && text[start - 2] === "\n") start--; // the blank line mergeBlock put before it
  return text.slice(0, start) + text.slice(end);
}

/**
 * Writes (or with `remove` takes out) the resume block in the target files. Returns the lines to print. Nothing is written on `dry`.
 * A file that holds only the block (fish) is deleted by a removal.
 */
export function applyResumeHook({ home, shell = "", bin, dry = false, remove = false }) {
  const out = [];
  const targets = resumeTargets({ home, shell });
  if (targets.length === 0) {
    if (!remove) out.push(`resume hook: shell ${path.basename(String(shell)) || "unknown"} is not zsh, bash or fish; add the block by hand (docs/install.md).`);
    return out;
  }
  for (const t of targets) {
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
function mergeBlockWith(text, block) {
  const e = text.indexOf(RESUME_END);
  const s = e >= 0 ? text.lastIndexOf(RESUME_START, e) : -1;
  if (s >= 0 && e >= 0) return text.slice(0, s) + block + text.slice(e + RESUME_END.length);
  const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${block}\n`;
}
