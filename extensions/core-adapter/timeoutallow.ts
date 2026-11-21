// `timeout <N> <cmd>`: unwrapTimeout strips the wrapper so the effect classes (effects.ts) see the wrapped command.

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const FLAGS_WITH_VALUE = new Set(["-s", "-k"]);
const PLAIN_FLAGS = new Set(["--foreground", "--preserve-status", "-v", "--verbose"]);

/** `timeout [flags] N rest` -> `rest`, or null when the form is anything else. */
export function unwrapTimeout(unit: string): string | null {
  const m = /^timeout\s+(.*)$/s.exec(unit.trim());
  if (!m) return null;
  let rest = m[1].trim();
  for (;;) {
    const w = /^(\S+)\s*(.*)$/s.exec(rest);
    if (!w) return null;
    const [, first, tail] = w;
    if (PLAIN_FLAGS.has(first) || /^--(?:signal|kill-after)=\S+$/.test(first)) {
      rest = tail;
    } else if (FLAGS_WITH_VALUE.has(first)) {
      const v = /^(\S+)\s*(.*)$/s.exec(tail);
      if (!v) return null;
      rest = v[2];
    } else if (DURATION.test(first)) {
      return tail.trim() || null;
    } else return null;
  }
}
