// Entry guard for the shell CLIs: is this module the script node was started with? Compares real paths, so a symlinked package folder still matches.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function real(p: string): string {
  let r: string;
  try {
    r = fs.realpathSync(p);
  } catch {
    r = path.resolve(p);
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export function isMainModule(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  return real(argv1) === real(fileURLToPath(metaUrl));
}
