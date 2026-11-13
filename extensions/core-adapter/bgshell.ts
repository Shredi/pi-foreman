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

export interface BgShellResult {
  /** Both variables were set by this call. */
  set: boolean;
  /** win32, neither variable set by the user, and no usable bash was found (the add-on falls back to cmd.exe). */
  noBash: boolean;
}

/** Like `applyBgShellEnv`, and also says whether the lookup found no bash, so the session can tell the user once. */
export function resolveBgShell(deps: BgShellDeps & { getShellConfig: ShellConfigFn }): BgShellResult {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== "win32") return { set: false, noBash: false };
  if (env.PI_BG_SHELL || env.PI_BG_SHELL_PATH) return { set: false, noBash: false };
  try {
    const cfg = deps.getShellConfig(deps.shellPath || undefined);
    if (cfg.commandTransport === "stdin") return { set: false, noBash: false };
    const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
    if (!path.win32.isAbsolute(cfg.shell) || !/(^|[\\/])bash(\.exe)?$/i.test(cfg.shell) || !exists(cfg.shell)) return { set: false, noBash: true };
    env.PI_BG_SHELL = "bash";
    env.PI_BG_SHELL_PATH = cfg.shell;
    return { set: true, noBash: false };
  } catch {
    return { set: false, noBash: true }; // no bash found: the add-on keeps its own default
  }
}

/** Sets PI_BG_SHELL=bash and PI_BG_SHELL_PATH=<bash exe> on win32 when both are unset and bash resolves to an existing absolute path. Returns whether it set them. */
export function applyBgShellEnv(deps: BgShellDeps & { getShellConfig: ShellConfigFn }): boolean {
  return resolveBgShell(deps).set;
}

/** The notice text when this session should say bash is missing (a child session never does), else null. */
export function bgBashNotice(result: BgShellResult, isChild: boolean): string | null {
  return result.noBash && !isChild ? NO_BG_BASH_NOTICE : null;
}

/** The notice text for a missing bash on win32; index.ts shows it once per session (notifyOnce). */
export const NO_BG_BASH_NOTICE = "pi-foreman: no bash found, so background commands run in cmd.exe. Install Git for Windows and run `foreman setup` (or set shellPath in Pi's settings.json, or PI_BG_SHELL_PATH), then restart Pi.";
