// A review stays valid for a commit whose tree equals the reviewed content (docs/review.md, "Head rule"). A PASS record carries the tree of the
// work tree it reviewed (`ReviewRecord.tree`, `.workflow/` left out); when a commit with exactly that tree appears, the PASS is copied with the
// commit as its head and `via: "same_tree"`, so every consumer of the head lists sees it. This is the pure part; index.ts `coverHead` wires it.
import type { ReviewRecord } from "./reviews.ts";

/**
 * The one rule for a same-tree alias against high-stakes FAILs (`runs` of the high-stakes state): `open` while any FAIL of the session is uncleared (no alias is made, none counts), else `after`, the newest FAIL time
 * (Infinity for a FAIL without one; null with no FAIL): an alias or its source PASS counts only with a launch time (`at`) later than it.
 */
export function aliasFloor(runs: readonly { verdict: string; cleared: boolean; failAt?: number }[]): { open: boolean; after: number | null } {
  const fails = runs.filter((x) => x.verdict === "fail");
  return { open: fails.some((x) => !x.cleared), after: fails.length === 0 ? null : fails.some((x) => x.failAt === undefined) ? Infinity : Math.max(...fails.map((x) => x.failAt as number)) };
}

/** `records` without the `same_tree` aliases the {@link aliasFloor} rejects: what every gate reads. */
export function liveRecords<T extends ReviewRecord>(records: readonly T[], runs: readonly { verdict: string; cleared: boolean; failAt?: number }[]): readonly T[] {
  const f = aliasFloor(runs);
  if (f.after === null || !records.some((r) => r.via)) return records;
  return records.filter((r) => !r.via || (!f.open && r.at !== undefined && r.at > f.after!));
}

/**
 * The alias records `head` earns, each with the head of the PASS it copies. Per checkout (the `cwd` of the records), when no record of any checkout names `head`, its newest code review (aliases left
 * out) is a PASS with a `tree`, the checkout is not `blocked` (an uncleared high-stakes FAIL there) and `treeOf(checkout, head)` equals that tree, and no code-review FAIL of any checkout on that same tree is newer (by record order) than the PASS.
 * With `after` (the newest high-stakes FAIL time of the session), the PASS must carry a record time (`at`) later than it. `first` (a checkout) is searched first. A commit that does not resolve gives null from `treeOf`: no alias.
 */
export async function coverAliases(records: readonly ReviewRecord[], head: string, o: { first?: string | null; blocked: (checkout: string) => boolean; after?: number | null; treeOf: (checkout: string, head: string) => Promise<string | null> }): Promise<{ rec: ReviewRecord; from: string | null }[]> {
  const checkouts = [...new Set(records.filter((r) => r.cwd && r.tree && r.kind !== "plan").map((r) => r.cwd as string))].sort((a, b) => Number(b === o.first) - Number(a === o.first));
  const out: { rec: ReviewRecord; from: string | null }[] = [];
  for (const co of checkouts) {
    const mine = records.filter((r) => r.cwd === co && r.kind !== "plan");
    if (records.some((r) => r.kind !== "plan" && r.head === head)) continue;
    const newest = mine.findLast((r) => !r.via);
    if (!newest || newest.verdict !== "pass" || !newest.tree || o.blocked(co)) continue;
    if (o.after != null && !(newest.at !== undefined && newest.at > o.after)) continue;
    const at = records.indexOf(newest);
    if (records.some((r, i) => i > at && r.kind !== "plan" && !r.via && r.verdict === "fail" && r.tree === newest.tree)) continue;
    if ((await o.treeOf(co, head)) !== newest.tree) continue;
    const { why: _why, ...rest } = newest;
    out.push({ rec: { ...rest, head, via: "same_tree" }, from: newest.head });
  }
  return out;
}
