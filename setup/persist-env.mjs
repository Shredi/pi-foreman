// Persists add-on environment variables (e.g. PI_BG_FEATURES=process) across shells. Pure over its inputs: the home dir, shell, platform
// and the `setx` runner are parameters, so tests never touch a real profile or registry.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const BLOCK_START = "# >>> pi-foreman env >>>";
export const BLOCK_END = "# <<< pi-foreman env <<<";

/** Where the variables go: a profile file (POSIX, by login shell) or the Windows user environment (`setx`). */
export function envTarget({ platform, home, shell = "" }) {
  if (platform === "win32") return { kind: "setx" };
  const name = path.basename(String(shell));
  if (name === "zsh") return { kind: "profile", file: path.join(home, ".zshrc"), fish: false };
  if (name === "bash") return { kind: "profile", file: path.join(home, platform === "darwin" ? ".bash_profile" : ".bashrc"), fish: false };
  if (name === "fish") return { kind: "profile", file: path.join(home, ".config", "fish", "conf.d", "pi-foreman.fish"), fish: true };
  return { kind: "profile", file: path.join(home, ".profile"), fish: false };
}

const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export function renderBlock(vars, fish) {
  const lines = Object.entries(vars).map(([k, v]) => (fish ? `set -gx ${k} ${shellQuote(v)}` : `export ${k}=${shellQuote(v)}`));
  return [BLOCK_START, ...lines, BLOCK_END].join("\n");
}

/** `text` with the marked block replaced in place (appended when absent). Same input gives the same output. */
export function mergeBlock(text, block) {
  // anchor on the last start before the first end, so an orphan start marker never swallows user lines
  const e = text.indexOf(BLOCK_END);
  const s = e >= 0 ? text.lastIndexOf(BLOCK_START, e) : -1;
  if (s >= 0 && e >= 0) return text.slice(0, s) + block + text.slice(e + BLOCK_END.length);
  const sep = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${sep}${block}\n`;
}

const defaultSetx = (name, value) => {
  const r = spawnSync("setx", [name, value], { encoding: "utf8", windowsHide: true });
  return { status: r.status, error: r.error ? r.error.message : (r.stderr || "").trim() };
};

/**
 * Makes `vars` permanent. Returns the lines to print. Nothing is written on `dry`.
 * Writes are idempotent: a block that is already correct (or setx, which overwrites) changes nothing.
 */
export function persistEnv(vars, { platform = process.platform, home, shell = "", setx = defaultSetx, dry = false } = {}) {
  const out = [];
  const todo = Object.entries(vars);
  const target = envTarget({ platform, home, shell });
  if (target.kind === "setx") {
    for (const [k, v] of todo) {
      if (dry) {
        out.push(`env ${k}=${v}: would run setx ${k} ${v} (user environment; open a new terminal for it to apply)`);
        continue;
      }
      const r = setx(k, v);
      if (r.status === 0) out.push(`env ${k}=${v}: set for your Windows user (setx); open a new terminal for it to apply`);
      else out.push(`WARN env ${k}: setx failed (${r.error || `exit ${r.status}`}); set it yourself: setx ${k} ${v}`);
    }
    return out;
  }
  const block = renderBlock(Object.fromEntries(todo), target.fish);
  let cur = "";
  try {
    cur = fs.readFileSync(target.file, "utf8");
  } catch {
    cur = "";
  }
  const next = mergeBlock(cur, block);
  const names = todo.map(([k, v]) => `${k}=${v}`).join(", ");
  if (next === cur) {
    out.push(`env ${names}: already in ${target.file}; open a new shell for it to apply`);
    return out;
  }
  if (dry) {
    out.push(`env ${names}: would write the pi-foreman block to ${target.file}`);
    return out;
  }
  try {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    fs.writeFileSync(target.file, next);
    out.push(`env ${names}: wrote the pi-foreman block to ${target.file}; open a new shell for it to apply`);
  } catch (err) {
    out.push(`WARN env: could not write ${target.file} (${err.message}); add it yourself: ${block.split("\n")[1]}`);
  }
  return out;
}
