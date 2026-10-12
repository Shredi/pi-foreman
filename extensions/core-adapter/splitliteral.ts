// Reassembled guarded tokens (R6 lane 1c/1d): string fragments joined by `+`, `..`, `.concat`, `.join` or `.replace(All)` that spell a
// whole guarded command token no single fragment spells. Mirrors `reassembles_token` in scripts/git_guard.py (parity fixture:
// tests/fixtures/split-literal-cases.json). `probeFileHit` adds `String.fromCharCode` and base64 literals for the probe-file scan.

/** The reason shared with git_guard.py. */
export const SPLIT_LITERAL_REASON = "split literal reassembles a guarded token";

const LIT = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const TOKEN_WORD = /(?<![A-Za-z0-9_])(?:rm|dd|truncate|mkfs|shred|cd|git|push\s+--force|reset\s+--hard|checkout\s+--)(?![A-Za-z0-9_])/g;
const PLUS = String.raw`\s*(?:\+|\.\.)\s*` + LIT;
const CONCAT = String.raw`\s*\.concat\(\s*` + LIT + String.raw`(?:\s*,\s*` + LIT + String.raw`)*\s*\)`;
const FRAGMENT_CHAIN = new RegExp(LIT + `(?:${PLUS}|${CONCAT})+`, "g");
const LIST = LIT + String.raw`(?:\s*,\s*` + LIT + ")*";
const JOIN_JS = new RegExp(String.raw`\[\s*(?<items>` + LIST + String.raw`)\s*,?\s*\]\s*\.join\(\s*(?<sep>` + LIT + String.raw`)?\s*\)`, "g");
const JOIN_PY = new RegExp(String.raw`(?<sep>` + LIT + String.raw`)\s*\.join\(\s*[\[(]\s*(?<items>` + LIST + String.raw`)\s*,?\s*[\])]\s*\)`, "g");
const REPLACE_CALL = new RegExp(String.raw`(?<base>` + LIT + String.raw`)\s*\.replace(?:All)?\(\s*(?<old>` + LIT + String.raw`)\s*,\s*(?<new>` + LIT + String.raw`(?:\s*\+\s*` + LIT + String.raw`)*)\s*\)`, "g");
const PIECE = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g;
const FCC_CALL = String.raw`String\.fromCharCode\(\s*\d+(?:\s*,\s*\d+)*\s*\)`;
const FCC_CHAIN = new RegExp(FCC_CALL + String.raw`(?:\s*\+\s*` + FCC_CALL + ")*", "g");
const B64_LITERAL = /["']([A-Za-z0-9+/]{4,}={0,2})["']/g;

function piecesOf(src: string): string[] {
  return [...src.matchAll(PIECE)].map((m) => m[1] || m[2] || "");
}

function count(s: string): number {
  return [...s.matchAll(TOKEN_WORD)].length;
}

/** A guarded token of the joined pieces that no single piece holds whole (it spans a join). */
function crosses(pieces: string[]): boolean {
  const joined = pieces.join("");
  const bounds: number[] = [];
  let n = 0;
  for (const p of pieces.slice(0, -1)) bounds.push((n += p.length));
  return [...joined.matchAll(TOKEN_WORD)].some((m) => bounds.some((b) => m.index < b && b < m.index + m[0].length));
}

export function reassemblesToken(texts: string[]): boolean {
  for (const t of texts) {
    for (const m of t.matchAll(FRAGMENT_CHAIN)) if (crosses(piecesOf(m[0]))) return true;
    for (const [rx, dflt] of [[JOIN_JS, ","], [JOIN_PY, ""]] as const) {
      for (const m of t.matchAll(rx)) {
        const sep = m.groups!.sep ? piecesOf(m.groups!.sep)[0] : dflt;
        const parts: string[] = [];
        piecesOf(m.groups!.items).forEach((item, i) => {
          if (i && sep) parts.push(sep);
          parts.push(item);
        });
        if (crosses(parts)) return true;
      }
    }
    for (const m of t.matchAll(REPLACE_CALL)) {
      const base = piecesOf(m.groups!.base)[0];
      const out = base.split(piecesOf(m.groups!.old)[0]).join(piecesOf(m.groups!.new).join(""));
      if (count(out) > count(base)) return true;
    }
  }
  return false;
}

/** Printable text a base64 literal decodes to, or null. */
function b64Text(s: string): string | null {
  if (s.length % 4 !== 0) return null;
  const buf = Buffer.from(s, "base64");
  if (!buf.length) return null;
  for (const b of buf) if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) return null;
  return buf.toString("latin1");
}

/** A probe file (script run from outside git) that spells a guarded token from pieces, char codes or base64. */
export function probeFileHit(text: string): boolean {
  if (reassemblesToken([text])) return true;
  for (const m of text.matchAll(FCC_CHAIN)) {
    const decoded = [...m[0].matchAll(/String\.fromCharCode\(([^)]*)\)/g)].map((c) => String.fromCharCode(...c[1].split(",").map((x) => Number(x.trim())))).join("");
    if (count(decoded)) return true;
  }
  for (const m of text.matchAll(B64_LITERAL)) {
    const d = b64Text(m[1]);
    if (d !== null && count(d)) return true;
  }
  return false;
}
