// The words of a PowerShell line, for the gate's path checks (guard round 2, step 4). No cmdlet knowledge: every word is a candidate path. Quotes and backtick
// escapes are honoured; `;` `|` `&` `<` `>` (so every redirect operator), the brackets and comma of PowerShell and `=` (an assignment, `-Path=x`, `@{Path='x'}`) end a word; a home spelling at the start of a
// word (`~`, `$HOME`, `$env:USERPROFILE`, `${env:USERPROFILE}`, `%USERPROFILE%`) is the home folder; each word is resolved against the cwd to its long name form (`longForm`), with the case it was written in (the checks fold case themselves).
import * as path from "node:path";
import { longForm, nativeResolver, type Resolver } from "./pathnorm.ts";

/** Characters that end an unquoted word besides white space. */
const ENDS = new Set([";", "|", "&", "<", ">", "(", ")", "{", "}", ",", "="]);
const HOME = /^(?:~|\$home|\$env:userprofile|\$\{env:userprofile\}|%userprofile%)/i;
/** A parameter written `-Name:value`: the value is the word. */
const PARAM = /^-[A-Za-z]+:(?=[^\s;|&<>])/;

const blank = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

/**
 * The absolute paths of the words of `line`, in order, without repeats. Both separators are accepted (off win32 `\` becomes `/`); on win32 the result has
 * backslash separators and the spelling's case. A drive-relative word (`D:x` on win32) resolves like any other word, lexically. An empty line has no words.
 */
export function psWords(line: string, cwd: string, home: string, platform: string, real: Resolver = nativeResolver): string[] {
  const out = new Set<string>();
  const seen = new Set<string>();
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (blank(line[i]) || ENDS.has(line[i])) {
      i++;
      continue;
    }
    const param = PARAM.exec(line.slice(i, i + 64));
    if (param) i += param[0].length;
    let buf = "";
    let quote: string | null = null;
    // a home spelling at the start of the word, after an opening quote if there is one (a single-quoted word is not expanded by PowerShell, but its `~` still is, by the provider)
    const q = line[i] === '"' || line[i] === "'" ? 1 : 0;
    const m = HOME.exec(line.slice(i + q, i + q + 24));
    if (m && (q === 0 || line[i] === '"' || m[0] === "~")) {
      const next = line[i + q + m[0].length];
      if (next === undefined || next === "/" || next === "\\" || blank(next) || ENDS.has(next) || next === '"' || next === "'") {
        buf = home;
        quote = q ? line[i] : null;
        i += q + m[0].length;
      }
    }
    let k = i;
    for (; k < n; k++) {
      const ch = line[k];
      if (quote) {
        if (ch === quote) {
          if (line[k + 1] === quote) {
            buf += quote;
            k++;
          } else quote = null;
        } else if (quote === '"' && ch === "`" && k + 1 < n) buf += line[++k];
        else buf += ch;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "`") {
        if (line[k + 1] === "\r" && line[k + 2] === "\n") k += 2;
        else if (k + 1 < n && line[k + 1] === "\n") k++;
        else if (k + 1 < n) buf += line[++k];
      } else if (blank(ch) || ENDS.has(ch)) break;
      else buf += ch;
    }
    i = k;
    // a repeated spelling is resolved once; PowerShell takes `\` as a separator on every platform
    if (buf && !buf.includes("\0") && !seen.has(buf)) {
      seen.add(buf);
      if (platform === "win32") out.add(longForm(platform, path.win32.resolve(cwd, buf), real).replace(/\//g, "\\"));
      else out.add(longForm(platform, path.posix.resolve(cwd, buf.replace(/\\/g, "/")), real));
    }
  }
  return [...out];
}
