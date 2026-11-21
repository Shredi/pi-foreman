// What a review leaves for the next one, kept per checkout (the real path of the git toplevel, the key reviewgates.ts and ReviewRecord.cwd use): a
// worktree's own FAIL findings, its failed items and the ledger items its reviews judged. A session that ships several pull requests, each from its own
// worktree, so never hands one checkout's facts to a review of another. Persisted with the ceremony state (planstate.ts).

export interface CheckoutFacts {
  /** The latest counted review verdict of this checkout is FAIL and no owner prompt came since (the next item review there is a re-review). */
  failOpen: boolean;
  /** The findings of the last normal-review FAIL here; null after a PASS or a FAIL without findings. */
  findings: string | null;
  /** The head the last counted FAIL here reviewed; null when unknown. */
  failHead: string | null;
  /** Item numbers of the last FAIL verdict here, until a review there passes. */
  failItems: string[];
  /** Numbered item ids a counting review here gave a `pass` or `fail` result, and ids a launch here named in `items`. */
  judged: string[];
}

export const MAX_CHECKOUTS = 16;
const MAX_IDS = 200;

const empty = (): CheckoutFacts => ({ failOpen: false, findings: null, failHead: null, failItems: [], judged: [] });
const isEmpty = (f: CheckoutFacts): boolean => !f.failOpen && f.findings === null && f.failHead === null && f.failItems.length === 0 && f.judged.length === 0;
const ids = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x)))].slice(-MAX_IDS) : []);

/** The facts of every checkout, oldest touched first; at most `MAX_CHECKOUTS`. */
export class ReviewMemory {
  private readonly map = new Map<string, CheckoutFacts>();

  private touch(root: string): CheckoutFacts {
    const f = this.map.get(root) ?? empty();
    this.map.delete(root);
    this.map.set(root, f); // most recently touched last
    while (this.map.size > MAX_CHECKOUTS) this.map.delete(this.map.keys().next().value as string);
    return f;
  }

  isEmpty(): boolean {
    return this.map.size === 0;
  }
  has(root: string): boolean {
    return this.map.has(root);
  }
  failOpen(root: string): boolean {
    return this.map.get(root)?.failOpen === true;
  }
  findings(root: string): string | null {
    return this.map.get(root)?.findings ?? null;
  }
  failHead(root: string): string | null {
    return this.map.get(root)?.failHead ?? null;
  }
  failItems(root: string): string[] {
    return [...(this.map.get(root)?.failItems ?? [])];
  }
  judgedIn(root: string): string[] {
    return [...(this.map.get(root)?.judged ?? [])];
  }
  /** The ids another checkout judged and this one did not. */
  judgedElsewhere(root: string): string[] {
    const here = new Set(this.map.get(root)?.judged ?? []);
    const out = new Set<string>();
    for (const [r, f] of this.map) if (r !== root) for (const id of f.judged) if (!here.has(id)) out.add(id);
    return [...out];
  }

  setFailOpen(root: string, open: boolean): void {
    if (open || this.map.has(root)) this.touch(root).failOpen = open;
  }
  setFindings(root: string, text: string | null): void {
    if (text !== null || this.map.has(root)) this.touch(root).findings = text;
  }
  setFailHead(root: string, head: string | null): void {
    if (head !== null || this.map.has(root)) this.touch(root).failHead = head;
  }
  setFailItems(root: string, items: readonly string[]): void {
    if (items.length > 0 || this.map.has(root)) this.touch(root).failItems = [...items];
  }
  judge(root: string, items: readonly string[]): void {
    const add = items.filter((x) => /^\d+$/.test(x));
    if (add.length === 0) return;
    const f = this.touch(root);
    f.judged = [...new Set([...f.judged, ...add])].slice(-MAX_IDS);
  }
  /** The owner prompt (root absent: every checkout): the next review is no re-review; the findings and failed items stay for the owner's next round. */
  clearOpen(root?: string): void {
    for (const [r, f] of this.map) if (root === undefined || r === root) f.failOpen = false;
  }

  /** The persisted shape; absent when there is nothing to keep. */
  snapshot(): Record<string, CheckoutFacts> | undefined {
    const out: Record<string, CheckoutFacts> = {};
    for (const [r, f] of this.map) if (!isEmpty(f)) out[r] = { failOpen: f.failOpen, findings: f.findings, failHead: f.failHead, failItems: [...f.failItems], judged: [...f.judged] };
    return Object.keys(out).length > 0 ? out : undefined;
  }
  load(snap: Record<string, CheckoutFacts> | undefined): void {
    for (const [r, f] of Object.entries(snap ?? {})) this.map.set(r, { ...f });
    while (this.map.size > MAX_CHECKOUTS) this.map.delete(this.map.keys().next().value as string);
  }
}

/** The facts of a persisted entry, validated field by field; undefined when there are none. */
export function factsOfEntry(raw: unknown): Record<string, CheckoutFacts> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, CheckoutFacts> = {};
  for (const [root, v] of Object.entries(raw as Record<string, unknown>).slice(-MAX_CHECKOUTS)) {
    if (!root || !v || typeof v !== "object") continue;
    const d = v as Record<string, unknown>;
    const f: CheckoutFacts = { failOpen: d.failOpen === true, findings: typeof d.findings === "string" && d.findings !== "" ? d.findings : null, failHead: typeof d.failHead === "string" && d.failHead !== "" ? d.failHead : null, failItems: ids(d.failItems), judged: ids(d.judged) };
    if (!isEmpty(f)) out[root] = f;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
