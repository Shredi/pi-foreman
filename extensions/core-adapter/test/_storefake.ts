// Test helper: the PR tracker's store as a fake. `storeFromPoll` turns a poll-shaped fake (what #82's watch tests used) into the `storeEntry` dependency
// of PrWatches: a snap is an entry whose `okAt` is newer than the one before, an error is the tracker's last error for the PR, gone is its not-found.
import type { StoreRead, WatchPoll } from "../prwatch.ts";
import type { PrKey } from "../prhost.ts";

export function storeFromPoll(poll: (key: PrKey) => Promise<WatchPoll>): (key: PrKey) => Promise<StoreRead> {
  let okAt = 1_000_000;
  return async (key) => {
    const p = await poll(key);
    if ("snap" in p) return { kind: "entry", snap: p.snap, okAt: (okAt += 1000) };
    if ("gone" in p) return { kind: "error", error: "the pull request was not found", gone: true };
    return { kind: "error", error: p.error };
  };
}
