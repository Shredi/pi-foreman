import { execFileSync } from "node:child_process";

export type Bump = "major" | "minor" | "patch";

/** The checked-out branch of `repoDir`. */
export function currentBranch(repoDir: string): string {
  return execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
}

/** `1.4.2` + minor -> `1.5.0`. A leading `v` is kept. */
export function nextVersion(current: string, bump: Bump): string {
  const prefix = current.startsWith("v") ? "v" : "";
  const [major, minor, patch] = current.slice(prefix.length).split(".").map((n) => Number.parseInt(n, 10));
  if ([major, minor, patch].some((n) => !Number.isInteger(n) || n < 0)) throw new Error(`not a version: ${current}`);
  if (bump === "major") return `${prefix}${major + 1}.0.0`;
  if (bump === "minor") return `${prefix}${major}.${minor + 1}.0`;
  return `${prefix}${major}.${minor}.${patch + 1}`;
}
