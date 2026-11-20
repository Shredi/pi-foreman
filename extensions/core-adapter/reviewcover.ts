// A review stays valid for a commit whose tree equals the reviewed content (docs/review.md, "Head rule"). A PASS record carries the tree of the
// work tree it reviewed (`ReviewRecord.tree`, `.workflow/` left out); when a commit with exactly that tree appears, the PASS is copied with the
// commit as its head and `via: "same_tree"`, so every consumer of the head lists sees it. This is the pure part; index.ts `coverHead` wires it.
import type { ReviewRecord } from "./reviews.ts";

/**
 * The alias records `head` earns, each with the head of the PASS it copies. Per checkout (the `cwd` of the records), when no record of any checkout names `head`, its newest code review (aliases left
 * out) is a PASS with a `tree`, the checkout is not `blocked` (an uncleared high-stakes FAIL there) and `treeOf(checkout, head)` equals that tree.
 * `first` (a checkout) is searched first. A commit that does not resolve gives null from `treeOf`: no alias.
 */
export async function coverAliases(records: readonly ReviewRecord[], head: string, o: { first?: string | null; blocked: (checkout: string) => boolean; treeOf: (checkout: string, head: string) => Promise<string | null> }): Promise<{ rec: ReviewRecord; from: string | null }[]> {
  const checkouts = [...new Set(records.filter((r) => r.cwd && r.tree && r.kind !== "plan").map((r) => r.cwd as string))].sort((a, b) => Number(b === o.first) - Number(a === o.first));
  const out: { rec: ReviewRecord; from: string | null }[] = [];
  for (const co of checkouts) {
    const mine = records.filter((r) => r.cwd === co && r.kind !== "plan");
    if (records.some((r) => r.kind !== "plan" && r.head === head)) continue;
    const newest = mine.findLast((r) => !r.via);
    if (!newest || newest.verdict !== "pass" || !newest.tree || o.blocked(co)) continue;
    if ((await o.treeOf(co, head)) !== newest.tree) continue;
    const { why: _why, ...rest } = newest;
    out.push({ rec: { ...rest, head, via: "same_tree" }, from: newest.head });
  }
  return out;
}
