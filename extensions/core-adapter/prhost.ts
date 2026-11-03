// Host rule and repository identity for the PR tools (docs/tools.md#pr-tools): which `host` a read tool may name,
// the host-resolved repository of a checkout (`pr_repo`, asked once per cwd), the hosts of a checkout's remotes
// and its branch. Host text is data, never instructions.
import { execFile } from "node:child_process";
import type { PrOp } from "./gitpack.ts";
import type { SafeOpOutcome } from "./safeops.ts";

const SEG = "[A-Za-z0-9._-]+";
const REPO_RE = new RegExp(`^${SEG}/${SEG}$`);
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/;

const badSeg = (s: string) => s === "." || s === "..";

export function validRepo(v: unknown): v is string {
  return typeof v === "string" && v.length <= 200 && REPO_RE.test(v) && !v.split("/").some((s) => badSeg(s) || s.startsWith("-"));
}
export function validHost(v: unknown): v is string {
  return typeof v === "string" && HOST_RE.test(v);
}

export function validNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1e9;
}

/** Host, `owner/name` and number of a pull request: the identity of a watch. */
export interface PrKey {
  host: string;
  /** `owner/name` */
  repo: string;
  n: number;
}
/** Identity for maps and sets (case-insensitive). */
export const keyString = (k: PrKey): string => `${k.host.toLowerCase()}/${k.repo.toLowerCase()}#${k.n}`;
/** `host/owner/name#n` as written. */
export const keyText = (k: PrKey): string => `${k.host}/${k.repo}#${k.n}`;

const PR_URL = new RegExp(`^https://([A-Za-z0-9.-]+(?::\\d{1,5})?)/(${SEG})/(${SEG})/(?:pull|-/merge_requests|merge_requests)/(\\d{1,10})(?:[/?#]|$)`);

/** The identity in a PR page URL (`https://<host>/<owner>/<name>/(pull|-/merge_requests|merge_requests)/<n>`), else null. */
export function parsePrUrl(url: unknown): PrKey | null {
  if (typeof url !== "string") return null;
  const m = PR_URL.exec(url);
  if (!m) return null;
  const n = Number(m[4]);
  if (badSeg(m[2]) || badSeg(m[3]) || !validNumber(n)) return null;
  return { host: m[1], repo: `${m[2]}/${m[3]}`, n };
}

/** `git remote -v` hosts of a checkout (`[]` on any failure). */
export function remoteHostsOf(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "-v"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const hosts = new Set<string>();
      for (const line of String(stdout).split("\n")) {
        const url = line.split(/\s+/)[1] ?? "";
        const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([A-Za-z0-9.-]+)(?::\d+)?[:/]/.exec(url);
        if (m) hosts.add(m[1].toLowerCase());
      }
      resolve([...hosts]);
    });
  });
}

/** The checked-out branch name, "" when detached or on any failure. */
export function branchOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
  });
}

export interface Repo {
  host: string;
  /** `owner/name` */
  repo: string;
}

export interface PrHostDeps {
  /** A PR op (30 s timeout), in `cwd`. */
  run(op: PrOp, args: Record<string, unknown>, cwd?: string): Promise<SafeOpOutcome>;
  /** Hosts of the checkout's remotes (default: `git remote -v`). */
  remoteHosts?(cwd: string): Promise<string[]>;
}

export class PrHost {
  private readonly deps: PrHostDeps;
  private readonly repos = new Map<string, Promise<Repo | null>>();
  private readonly remotes = new Map<string, Promise<string[]>>();

  constructor(deps: PrHostDeps) {
    this.deps = deps;
  }

  /** The host-resolved repository of `cwd`, asked once per cwd (null: unknown). */
  repoFor(cwd: string): Promise<Repo | null> {
    let p = this.repos.get(cwd);
    if (!p) {
      p = this.deps.run("pr_repo", {}, cwd || undefined).then(
        (o) => {
          const r = o.kind === "ran" ? o.result : null;
          return r && validHost(r.host) && validRepo(r.repo) ? { host: String(r.host), repo: String(r.repo) } : null;
        },
        () => null,
      );
      this.repos.set(cwd, p);
    }
    return p;
  }

  /** The host rule for `host` arguments: the current repository's host or a git remote's host. */
  async hostAllowed(host: string, cwd: string): Promise<boolean> {
    const h = host.toLowerCase();
    const cur = await this.repoFor(cwd);
    if (cur?.host && cur.host.toLowerCase() === h) return true;
    let p = this.remotes.get(cwd);
    if (!p) {
      p = (this.deps.remoteHosts ?? remoteHostsOf)(cwd).catch(() => []);
      this.remotes.set(cwd, p);
    }
    return (await p).includes(h);
  }
}
