// R31c test helper: the round's base commit (bada3ba) extracted into a temp dir so a test can run the BASE decision functions next to the new ones
// ("the base asks"). Returns null when the commit is not in this clone (a shallow checkout); the test then skips.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BASE_SHA = "bada3ba";
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface BaseModules {
  dir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  load: (name: string) => Promise<any>;
}

export function loadBase(): BaseModules | null {
  try {
    execFileSync("git", ["-C", PKG, "cat-file", "-e", `${BASE_SHA}^{commit}`], { stdio: "ignore" });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r31c-base-")));
    const tar = execFileSync("git", ["-C", PKG, "archive", BASE_SHA, "extensions/core-adapter", "package.json"], { maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", dir, "--exclude", "test"], { input: tar });
    return { dir, load: (name) => import(pathToFileURL(path.join(dir, "extensions", "core-adapter", `${name}.ts`)).href) };
  } catch {
    return null;
  }
}

export function dropBase(b: BaseModules | null): void {
  if (b) fs.rmSync(b.dir, { recursive: true, force: true });
}
