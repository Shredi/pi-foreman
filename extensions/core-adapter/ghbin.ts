// Binary lookup for gh and glab (S8). Kept apart from wait.ts so the CLIs that run outside Pi (`foreman prs`)
// load without reaching bg.ts, whose value import needs the Pi package. Node built-ins and triage.ts only.
import * as fs from "node:fs";
import * as path from "node:path";
import { realDeep, under } from "./triage.ts";

/**
 * Absolute path of `name` from PATH entries that are absolute and outside the workspace (S8): an empty,
 * `.` or relative entry, or one inside the workspace, is skipped, so a planted binary is never run.
 */
export function resolveBin(name: string, workspace: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, pathExt?: string): string | null {
  const win = platform === "win32";
  const pathVar = (win ? Object.entries(env).find(([k]) => k.toLowerCase() === "path")?.[1] : env.PATH) ?? "";
  const exts = win ? (pathExt ?? (env.PATHEXT || ".COM;.EXE")).split(";").filter(Boolean) : [""];
  const ws = realDeep(workspace);
  for (const entry of pathVar.split(win ? ";" : ":")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || dir === "." || !path.isAbsolute(dir)) continue;
    if (under(ws, realDeep(dir), platform)) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch {
        // next candidate
      }
    }
  }
  return null;
}

export const resolveGh = (workspace: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null => resolveBin("gh", workspace, env, platform);
