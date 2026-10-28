// The ruling file name test, split out of ruling.ts so that rounds.ts (and bench/review_facts.mjs, which runs without node_modules) does not reach permoverlay.ts and its shell parser package.
export const RULING_RE = /^ruling(?:-(\d{1,6}))?\.md$/;

/** True for a `ruling.md` / `ruling-<n>.md` file name. */
export const isRulingName = (name: string): boolean => RULING_RE.test(name);
