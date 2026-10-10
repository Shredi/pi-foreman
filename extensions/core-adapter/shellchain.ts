// Quote-aware split of a bash command into a chain of simple commands (ladder-polish item 7), for
// the review link's deterministic allows (timeoutallow.ts, effects.ts). It splits on top-level
// `&&`, `||`, `;` and `|` and parses redirects; it returns null (the caller then refuses the whole
// command) on anything it does not model exactly:
//   - `$(`, backticks, a newline anywhere (also inside quotes);
//   - unquoted `(`, `)`, `{`, `}` (subshell, grouping, brace expansion), `$` (variables), `\`,
//     globs `*` `?` `[` `]`, `!`, `#`, a lone `&` (background), `|&`, `;;`;
//   - heredocs and herestrings (`<<`, `<<<`), `<>`, `>|`, process substitution;
//   - a double-quoted string holding `$`, a backtick, `\` or `!`;
//   - an empty segment (`; ls`, `ls |`) or a redirect without its target.
// Redirects: `[N]>`, `[N]>>`, `&>`, `&>>`, `[N]<` with a word target, and fd dups `[N]>&M`. A
// segment's `text` is its raw source with the redirects cut out, for the permission patterns.

export interface Redirect {
  /** `dup` is an fd duplication (`2>&1`); its target is the fd number. */
  op: ">" | ">>" | "&>" | "&>>" | "<" | "dup";
  fd: string | null;
  target: string;
}

export interface Segment {
  words: string[];
  redirects: Redirect[];
  text: string;
}

export interface Chain {
  segments: Segment[];
  /** The operators between segments, in order (`&&`, `||`, `;`, `|`). */
  ops: string[];
}

const WORD = /[A-Za-z0-9_./,:@%+=^~-]/;

export function splitChain(command: string): Chain | null {
  const s = command;
  if (/[\n\r`]|\$\(/.test(s)) return null;
  const segments: Segment[] = [];
  const ops: string[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let text = "";
  let cur: string | null = null;
  let quoted = false;
  let wordStart = 0;
  let pending: { op: Redirect["op"]; fd: string | null; start: number } | null = null;

  const startWord = (): void => {
    if (cur === null) {
      cur = "";
      wordStart = text.length;
    }
  };
  const endWord = (): void => {
    if (cur === null) return;
    if (pending) {
      redirects.push({ op: pending.op, fd: pending.fd, target: cur });
      text = text.slice(0, pending.start);
      pending = null;
    } else words.push(cur);
    cur = null;
    quoted = false;
  };
  const endSeg = (): boolean => {
    endWord();
    if (pending || !words.length) return false;
    segments.push({ words, redirects, text: text.trim() });
    words = [];
    redirects = [];
    text = "";
    return true;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      endWord();
      text += " ";
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null;
      startWord();
      cur += s.slice(i + 1, end);
      quoted = true;
      text += s.slice(i, end + 1);
      i = end + 1;
    } else if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) return null;
      const body = s.slice(i + 1, end);
      if (/[$`\\!]/.test(body)) return null;
      startWord();
      cur += body;
      quoted = true;
      text += s.slice(i, end + 1);
      i = end + 1;
    } else if (c === "&" || c === "|" || c === ";") {
      const two = s.slice(i, i + 2);
      if (c === "&" && (s[i + 1] === ">")) {
        endWord();
        if (pending) return null;
        const append = s[i + 2] === ">";
        pending = { op: append ? "&>>" : "&>", fd: null, start: text.length };
        i += append ? 3 : 2;
        continue;
      }
      let op: string;
      if (two === "&&" || two === "||") op = two;
      else if (c === "&" || two === "|&" || two === ";;") return null;
      else op = c;
      if (!endSeg()) return null;
      ops.push(op);
      i += op.length;
    } else if (c === ">" || c === "<") {
      let fd: string | null = null;
      if (cur !== null && !quoted && /^\d+$/.test(cur)) {
        fd = cur;
        cur = null;
        text = text.slice(0, wordStart);
      } else endWord();
      if (pending) return null;
      let j = i + 1;
      let op: Redirect["op"];
      if (c === "<") {
        if (s[j] === "<" || s[j] === ">" || s[j] === "(" || s[j] === "&") return null;
        op = "<";
      } else {
        if (s[j] === "|" || s[j] === "(") return null;
        if (s[j] === ">") {
          op = ">>";
          j++;
        } else op = ">";
        if (s[j] === "&") {
          const m = /^\d+/.exec(s.slice(j + 1));
          if (!m || op === ">>") return null;
          redirects.push({ op: "dup", fd, target: m[0] });
          i = j + 1 + m[0].length;
          continue;
        }
      }
      pending = { op, fd, start: text.length };
      i = j;
    } else if (WORD.test(c)) {
      startWord();
      cur += c;
      text += c;
      i++;
    } else return null;
  }
  if (!endSeg()) return null;
  return { segments, ops };
}
