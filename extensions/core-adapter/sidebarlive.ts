// Herdr sidebar row pushed by the session itself (integrations/herdr/pi-foreman-sidebar/sidebar.py push).
// Every LiveState event flushes the presence file and runs one `push` (one in flight, 250 ms apart, one
// trailing push when requests arrived meanwhile); a 5 s timer keeps the 15 s token TTL alive. While the session
// works a 1 s timer cycles a braille spinner into fm_sym (herdr only, no Python); after every full push the
// current frame is re-published at once, so the glyph never shows between frames. session_shutdown stops the
// timers and runs `push --final` (the daemon takes the keys over). Only with HERDR_ENV=1, HERDR_PANE_ID, mode
// tui, a Python interpreter, the sidebar.py file and a LiveState for the session.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveStateName } from "./livestate.ts";

export const SIDEBAR_SOURCE = "plugin:pi-foreman.sidebar";
export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
export const PUSH_GAP_MS = 250;
export const REFRESH_MS = 5000;
export const SPIN_MS = 1000;
export const SPIN_TTL_MS = 15_000;

type Env = Record<string, string | undefined>;

export const sidebarScript = (pkgRoot: string): string => path.join(pkgRoot, "integrations", "herdr", "pi-foreman-sidebar", "sidebar.py");

export function sidebarGate(env: Env, mode: string | undefined, python: string | null, script: string): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID?.trim() && mode === "tui" && !!python && fs.existsSync(script);
}

export const frameArgv = (pane: string, frame: string): string[] => ["pane", "report-metadata", pane, "--source", SIDEBAR_SOURCE, "--token", `fm_sym=${frame}`, "--ttl-ms", String(SPIN_TTL_MS)];

export interface SidebarDeps {
  pane: string;
  sessionId: string;
  agentDir: string;
  symbols?: string;
  spinner: boolean;
  /** Runs sidebar.py with these args (starting with "push"); calls done when the process ended. */
  push: (args: string[], done: () => void) => void;
  /** Runs herdr with this argv, fire and forget. */
  herdr: (argv: string[]) => void;
  /** Writes the presence file now. */
  flush: () => void;
  state: () => LiveStateName;
  /** Marks the session done in the presence file (LiveState.stop, idempotent). */
  finish: () => void;
  gapMs?: number;
  refreshMs?: number;
  spinMs?: number;
}

export class SidebarLive {
  private readonly d: SidebarDeps;
  private inflight = false;
  private pending = false;
  private stopped = false;
  private lastStart = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private refresh: ReturnType<typeof setInterval> | null = null;
  private spin: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(d: SidebarDeps) {
    this.d = d;
  }

  private args(...extra: string[]): string[] {
    const { sessionId, pane, agentDir, symbols } = this.d;
    return ["push", "--session", sessionId, "--pane", pane, "--agent-dir", agentDir, ...(symbols === "unicode" || symbols === "nerd" ? ["--symbols", symbols] : []), ...extra];
  }

  start(): void {
    this.refresh = setInterval(() => this.request(), this.d.refreshMs ?? REFRESH_MS);
    this.refresh.unref?.();
    this.request();
  }

  /** Any trigger: sync the spinner, then push now, or after the gap / the push in flight. */
  request(): void {
    if (this.stopped) return;
    this.syncSpinner();
    if (this.inflight) {
      this.pending = true;
      return;
    }
    const wait = this.lastStart + (this.d.gapMs ?? PUSH_GAP_MS) - Date.now();
    if (wait <= 0) return this.run();
    this.pending = true;
    if (this.gapTimer) return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.kick();
    }, wait);
    this.gapTimer.unref?.();
  }

  private kick(): void {
    if (this.stopped || this.inflight || !this.pending) return;
    this.pending = false;
    this.run();
  }

  private run(): void {
    this.lastStart = Date.now();
    this.inflight = true;
    this.pending = false;
    try {
      this.d.flush();
    } catch {
      // the push composes from whatever file exists
    }
    let ended = false;
    const done = (): void => {
      if (ended) return;
      ended = true;
      this.inflight = false;
      if (this.stopped) return;
      if (this.spin) this.publishFrame();
      if (this.pending) this.request();
    };
    try {
      this.d.push(this.args(), done);
    } catch {
      done();
    }
  }

  private syncSpinner(): void {
    const want = this.d.spinner && this.d.state() === "working";
    if (want && !this.spin) {
      this.spin = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
        this.publishFrame();
      }, this.d.spinMs ?? SPIN_MS);
      this.spin.unref?.();
    } else if (!want && this.spin) {
      clearInterval(this.spin);
      this.spin = null;
      this.frame = 0;
    }
  }

  private publishFrame(): void {
    try {
      this.d.herdr(frameArgv(this.d.pane, SPINNER_FRAMES[this.frame]));
    } catch {
      // best effort
    }
  }

  /** Shutdown: timers off, presence marked done, then `push --final` (again after a push still in flight). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of [this.refresh, this.spin]) if (t) clearInterval(t);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.refresh = this.spin = this.gapTimer = null;
    try {
      this.d.finish();
      this.d.flush();
    } catch {
      // best effort
    }
    const wasInflight = this.inflight;
    const final = (): void => {
      try {
        this.d.push(this.args("--final"), () => {});
      } catch {
        // best effort
      }
    };
    final();
    if (wasInflight) {
      // an older push still running could land after the final one; send the final row once more behind it
      const t = setTimeout(final, 1000);
      t.unref?.();
    }
  }
}

const execQuiet = (bin: string, argv: string[], timeout: number, done: () => void = () => {}): void => {
  try {
    execFile(bin, argv, { timeout, windowsHide: true }, () => done());
  } catch {
    done();
  }
};

export interface SidebarStart {
  python: string | null;
  pkgRoot: string;
  agentDir: string;
  sessionId: string;
  symbols?: unknown;
  spinner?: unknown;
  live: { onChange: (cb: () => void) => () => void; flush: () => void; stop: () => void; stateName: LiveStateName } | null;
}

/** Wire the session-owned sidebar row; `start(ctx, cfg)` runs at the end of session_start, shutdown stops it. */
export function installSidebarLive(pi: Pick<ExtensionAPI, "on">, opts: { env?: Env } = {}): { start: (ctx: ExtensionContext, cfg: SidebarStart) => void } {
  const env = opts.env ?? process.env;
  let side: SidebarLive | null = null;
  let off: (() => void) | null = null;
  const stop = (): void => {
    off?.();
    off = null;
    side?.stop();
    side = null;
  };
  pi.on("session_shutdown", async () => stop());
  const start = (ctx: ExtensionContext, cfg: SidebarStart): void => {
    stop();
    const script = sidebarScript(cfg.pkgRoot);
    if (!cfg.live || !cfg.python || !sidebarGate(env, ctx.mode, cfg.python, script)) return;
    const python = cfg.python;
    const live = cfg.live;
    const herdrBin = env.HERDR_BIN?.trim() || "herdr";
    side = new SidebarLive({
      pane: env.HERDR_PANE_ID!.trim(),
      sessionId: cfg.sessionId,
      agentDir: cfg.agentDir,
      symbols: typeof cfg.symbols === "string" ? cfg.symbols : undefined,
      spinner: cfg.spinner !== false,
      push: (args, done) => execQuiet(python, ["-E", "-s", script, ...args], 10_000, done),
      herdr: (argv) => execQuiet(herdrBin, argv, 5000),
      flush: () => live.flush(),
      state: () => live.stateName,
      finish: () => live.stop(),
    });
    const s = side;
    off = live.onChange(() => s.request());
    s.start();
  };
  return { start };
}
