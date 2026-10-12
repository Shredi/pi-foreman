/**
 * Same-line shell variables for the path checks (`D=<dir>/x; mkdir -p $D`, `mkdir -p $FOREMAN_SCRATCH/x`).
 *
 * A `$NAME` / `${NAME}` in a word is replaced by its value only when that value is certain:
 *  (a) the value comes from an assignment that is a statement of its own (`NAME=literal`) before the use, joined
 *      to it by `;`, `&&` or `||` (a prefix assignment, `D=/x cmd $D`, never reaches the same command's words);
 *  (b) the literal holds no `$`, backtick, glob character, whitespace or quote-spanning expansion;
 *  (c) the last such assignment before the use wins;
 *  (d) `FOREMAN_*` names take their value from the harness env only, never from the line;
 *  (e) anything else (an assignment after `cmd &&`, in a loop, a subshell or a `{ }` group, `export`/`read`/`for`
 *      forms, a redirect on the assignment) leaves the variable unresolved, which keeps today's classification.
 */

/** Builtins and loop heads whose words name variables they set. */
const SETTERS = new Set(["read", "declare", "typeset", "export", "local", "readonly", "mapfile", "readarray", "getopts", "unset", "for", "select"]);
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A value that is one certain literal word naming an absolute path (a relative one depends on a `cd` the line may hold). */
function literal(v: string): boolean {
  return /^(\/|~\/|[A-Za-z]:\/)/.test(v) && !/[$`*?[\]{}\s\\]/.test(v);
}

/**
 * The resolvable `$NAME` / `${NAME}` inside the words of `pipelines`, replaced by their values. Returns, for each unit
 * with a change, a same-length copy of its words (keyed by the original array, which stays untouched: the read-only
 * and redirect bookkeeping keeps seeing the variable). `seps[i]` is the operator that ended pipeline `i`;
 * `redirected(unit)` says whether a unit carries a redirect.
 */
export function resolveVars(pipelines: string[][][], seps: string[], env: Record<string, string>, redirected: (unit: string[]) => boolean = () => false): Map<string[], string[]> {
  // a subshell, group or substitution may scope or hide an assignment: no assignment of the line counts
  const scoped = seps.some((s) => s === "(" || s === ")" || s === "`" || s === "&");
  const poisoned = new Set<string>();
  // IFS (word splitting), `let` / `((..))` (arithmetic assignment), eval / source: nothing on the line resolves
  const all = pipelines.flat(2);
  if (all.some((w) => /\bIFS\b/.test(w) || w === "let" || w.startsWith("(("))) return new Map();
  if (pipelines.some((p) => p.some((u) => ["eval", "source", "."].includes(u.find((x) => !ASSIGN.test(x)) ?? "")))) return new Map();
  // `H+=x`, `H[0]=x`: an append or element assignment leaves the value unknown
  for (const w of all) {
    const a = w.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\]|\+)=/s);
    if (a) poisoned.add(a[1]);
  }
  const sole = (i: number): RegExpMatchArray | null => {
    const p = pipelines[i];
    return p.length === 1 && p[0].length === 1 && !redirected(p[0]) ? p[0][0].match(ASSIGN) : null;
  };
  // pass 1: every variable some other form may set stays unresolved for the whole line
  const eligible: boolean[] = [];
  pipelines.forEach((pipe, i) => {
    const m = sole(i);
    const prevOk = i === 0 || seps[i - 1] === ";" || (eligible[i - 1] && seps[i - 1] === "&&");
    eligible[i] = !!m && !scoped && prevOk && !m[1].startsWith("FOREMAN_") && literal(m[2]);
    if (m && !eligible[i]) poisoned.add(m[1]);
    for (const unit of m ? [] : pipe) {
      for (const w of unit) {
        const a = w.match(ASSIGN);
        if (a) poisoned.add(a[1]);
      }
      const head = unit.find((w) => !ASSIGN.test(w));
      if ((head !== undefined && SETTERS.has(head)) || (head === "printf" && unit.includes("-v"))) for (const w of unit) if (NAME.test(w)) poisoned.add(w);
    }
  });
  const values = new Map<string, string>();
  const out = new Map<string[], string[]>();
  const subst = (w: string): string =>
    w.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a: string | undefined, b: string | undefined) => {
      const n = (a ?? b)!;
      const v = n.startsWith("FOREMAN_") ? env[n] : poisoned.has(n) ? undefined : values.get(n);
      if (v === undefined || v === "") return m;
      return v;
    });
  pipelines.forEach((pipe, i) => {
    if (eligible[i]) {
      const m = sole(i)!;
      // a value may build on an earlier one (`B=$A/x`) only through the literal rule: `$` is not literal, so no
      values.set(m[1], m[2]);
      return;
    }
    for (const unit of pipe) {
      const next = unit.map(subst);
      if (next.some((x, k) => x !== unit[k])) out.set(unit, next);
    }
  });
  return out;
}
