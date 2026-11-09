// win32: point the optional pi-background-tasks add-on at Git Bash. The add-on reads PI_BG_SHELL / PI_BG_SHELL_PATH in its own
// extension factory; without them it falls back to cmd.exe. pi-foreman loads first (setup.mjs orders `packages`), so setting
// them synchronously in our factory reaches it. Never overrides a value the user set; nothing happens off win32.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ShellConfigFn } from "./bg.ts";

export interface BgShellDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  getShellConfig?: ShellConfigFn;
  /** Pi's `shellPath` setting, when set. */
  shellPath?: string;
  exists?: (p: string) => boolean;
}

/** Sets PI_BG_SHELL=bash and PI_BG_SHELL_PATH=<bash exe> on win32 when both are unset and bash resolves to an existing absolute path. Returns whether it set them. */
export function applyBgShellEnv(deps: BgShellDeps & { getShellConfig: ShellConfigFn }): boolean {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "win32") return false;
  if (env.PI_BG_SHELL || env.PI_BG_SHELL_PATH) return false;
  try {
    const cfg = deps.getShellConfig(deps.shellPath || undefined);
    if (cfg.commandTransport === "stdin") return false;
    const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
    if (!path.win32.isAbsolute(cfg.shell) || !/(^|[\\/])bash(\.exe)?$/i.test(cfg.shell) || !exists(cfg.shell)) return false;
    env.PI_BG_SHELL = "bash";
    env.PI_BG_SHELL_PATH = cfg.shell;
    return true;
  } catch {
    return false; // no bash found: the add-on keeps its own default
  }
}
