// Repository and branch of a session's checkout for the presence file (livestate.ts `repo`, `branch`): the radar
// and the herdr-app mod join a feed PR to a session by equal repo and head branch. The repository (owner/name of
// the origin remote) is read once; the branch is re-read at most once per presence write. Never throws.
import { execFile } from "node:child_process";
import { validRepo } from "./prhost.ts";

export interface WhereDeps {
  cwd(): string;
  /** `owner/name` of the origin remote, null when unknown. */
  repo(cwd: string): Promise<string | null>;
  /** The checked-out branch, "" when detached or unknown. */
  branch(cwd: string): Promise<string>;
  /** The repo or branch differs from the last read: a new presence write. */
  changed(): void;
}

/** `owner/name` from an origin remote URL (https, ssh or scp form), else null. */
export function repoOfRemote(url: string): string | null {
  const m = /[:/]([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && validRepo(m[1]) ? m[1] : null;
}

export function originRepo(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : repoOfRemote(String(stdout))));
  });
}

export class Where {
  private readonly deps: WhereDeps;
  private repo: string | null = null;
  private repoDone = false;
  private branch: string | null = null;
  private busy = false;

  constructor(deps: WhereDeps) {
    this.deps = deps;
  }

  /** The cached values; starts one refresh when none runs. */
  read(): { repo: string | null; branch: string | null } {
    this.refresh();
    return { repo: this.repo, branch: this.branch };
  }

  private refresh(): void {
    if (this.busy) return;
    this.busy = true;
    void (async () => {
      try {
        const cwd = this.deps.cwd();
        let changed = false;
        if (!this.repoDone) {
          this.repoDone = true;
          const r = await this.deps.repo(cwd);
          if (r !== this.repo) {
            this.repo = r;
            changed = true;
          }
        }
        const b = (await this.deps.branch(cwd)) || null;
        if (b !== this.branch) {
          this.branch = b;
          changed = true;
        }
        if (changed) this.deps.changed();
      } catch {
        // best effort
      } finally {
        this.busy = false;
      }
    })();
  }
}
