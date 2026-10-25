// Herdr sidebar row pushed by the session itself (integrations/herdr/pi-foreman-sidebar/sidebar.py push).
// Every LiveState event flushes the presence file and runs one `push` (one in flight, 250 ms apart, one
// trailing push when requests arrived meanwhile); a 5 s timer keeps the 15 s token TTL alive. With a socket
// reporter the push runs as `push --json` and this file sends `pane.report_metadata` itself (only when the tokens
// changed, or after 10 s), then writes the stamp; a failed report falls back to a plain `push` for that cycle.
// While the session may tick (live state neither blocked nor done, `ui.spinner` not false, and Python's template
// carries `{spin}`: working, waiting-external, idle with a reason) a 250 ms timer sends only `fm_hd` with the current
// spinner frame in place of `{spin}`. session_shutdown stops the timers and runs `push --final` (the daemon takes the keys
// over). Only with HERDR_ENV=1, HERDR_PANE_ID, mode tui, a Python interpreter, the sidebar.py file and a
// LiveState for the session.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveStateName } from "./livestate.ts";
import { SPINNER_MS, spinnerFrame, symbolSet } from "./symbols.ts";

export const SIDEBAR_SOURCE = "plugin:pi-foreman.sidebar";
export const PUSH_GAP_MS = 250;
export const REFRESH_MS = 5000;
export const TTL_MS = 15_000;
/** An unchanged token set is sent again after this long (sidebar.py REPUSH_S). */
export const REPUSH_MS = 10_000;

type Env = Record<string, string | undefined>;

export const sidebarScript = (pkgRoot: string): string => path.join(pkgRoot, "integrations", "herdr", "pi-foreman-sidebar", "sidebar.py");

/** Herdr's socket like sidebar.py `socket_path()`: HERDR_SOCKET_PATH, else <XDG_CONFIG_HOME or ~/.config>/herdr/herdr.sock. */
export function socketPath(env: Env): string {
  return env.HERDR_SOCKET_PATH || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr", "herdr.sock");
}

export type Tokens = Record<string, string | null>;

let reqCounter = 0;

/** One `pane.report_metadata` request per connection: one JSON line out, one reply line in. Rejects on any failure. */
export function reportMetadata(sock: string, params: { pane_id: string; source: string; tokens: Tokens; ttl_ms: number }, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = { id: `fmts${++reqCounter}`, method: "pane.report_metadata", params };
    let buf = "";
    let settled = false;
    const conn = net.createConnection(sock);
    const end = (err?: Error): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      if (err) reject(err);
      else resolve();
    };
    conn.setTimeout(timeoutMs, () => end(new Error("herdr socket timeout")));
    conn.on("error", (e) => end(e));
    conn.on("connect", () => conn.write(JSON.stringify(req) + "\n"));
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(buf.slice(0, nl)) as { error?: unknown };
        end(reply.error ? new Error(`pane.report_metadata: ${JSON.stringify(reply.error)}`) : undefined);
      } catch (e) {
        end(e as Error);
      }
    });
    conn.on("close", () => end(new Error("herdr socket closed without a reply")));
  });
}

/** mkdir -p, temp file in the same folder, rename. Throws on failure. */
export function writeStampAtomic(file: string, pane: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, pane, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing to clean
    }
    throw e;
  }
}

export function sidebarGate(env: Env, mode: string | undefined, python: string | null, script: string): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID?.trim() && mode === "tui" && !!python && fs.existsSync(script);
}

export interface SidebarDeps {
  pane: string;
  sessionId: string;
  agentDir: string;
  symbols?: string;
  /** Runs sidebar.py with these args (starting with "push"); calls done (with the stdout, when captured) when the process ended. */
  push: (args: string[], done: (stdout?: string) => void) => void;
  /** Sends the tokens to Herdr over its socket (rejects on failure). Present = `push --json` mode; absent = plain `push` only. */
  report?: (tokens: Tokens) => Promise<void>;
  /** Writes the stamp file (default writeStampAtomic). */
  writeStamp?: (file: string, pane: string) => void;
  /** `ui.spinner` (false = static glyphs; default on). */
  spinner?: boolean;
  /** The session may tick now (see `sidebarMayTick`); the `{spin}` template still decides whether it does. */
  working?: () => boolean;
  /** Spinner frames (default: the unicode set's). */
  frames?: readonly string[];
  /** Clock for tests (epoch ms). */
  nowMs?: () => number;
  tickMs?: number;
  /** Writes the presence file now. */
  flush: () => void;
  /** Marks the session done in the presence file (LiveState.stop, idempotent). */
  finish: () => void;
  gapMs?: number;
  refreshMs?: number;
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
  private tpl: string | null = null;
  private lastSent: string | null = null;
  private lastSentAt = 0;

  constructor(d: SidebarDeps) {
    this.d = d;
  }

  private args(...extra: string[]): string[] {
    const { sessionId, pane, agentDir, symbols } = this.d;
    return ["push", "--session", sessionId, "--pane", pane, "--agent-dir", agentDir, ...(symbols === "unicode" || symbols === "nerd" || symbols === "emoji" || symbols === "ascii" ? ["--symbols", symbols] : []), ...extra];
  }

  start(): void {
    this.refresh = setInterval(() => this.request(), this.d.refreshMs ?? REFRESH_MS);
    this.refresh.unref?.();
    this.request();
  }

  /** Any trigger: push now, or after the gap / the push in flight. */
  request(): void {
    if (this.stopped) return;
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
      if (this.pending) this.request();
    };
    try {
      if (!this.d.report) return this.d.push(this.args(), () => done());
      this.d.push(this.args("--json"), (out) => {
        void this.publish(out).then(done, done);
      });
    } catch {
      done();
    }
  }

  private now(): number {
    return (this.d.nowMs ?? Date.now)();
  }

  private frame(): string {
    return spinnerFrame(this.d.frames ?? symbolSet("unicode").spinner, this.now());
  }

  private animating(): boolean {
    return this.d.spinner !== false && this.tpl !== null && (this.d.working?.() ?? false);
  }

  /** `push --json` output -> socket report -> stamp. Anything unusable or a failed report falls back to a plain push. */
  private async publish(out: string | undefined): Promise<void> {
    let j: { tokens?: Tokens; fm_hd_tpl?: unknown; stamp?: unknown; pane?: unknown };
    try {
      j = JSON.parse((out ?? "").trim());
    } catch {
      return this.fallback();
    }
    if (!j || typeof j !== "object") return this.fallback();
    if (this.stopped || !j.tokens) return; // stopped, or another session owns the pane: nothing to publish
    const tokens = j.tokens;
    this.tpl = typeof j.fm_hd_tpl === "string" ? j.fm_hd_tpl : null;
    const raw = JSON.stringify(tokens);
    const t = this.now();
    if (raw !== this.lastSent || t - this.lastSentAt >= REPUSH_MS) {
      const sent = this.animating() && this.tpl ? { ...tokens, fm_hd: this.tpl.replace("{spin}", this.frame()) } : tokens;
      try {
        await this.d.report!(sent);
      } catch {
        this.lastSent = null;
        return this.fallback();
      }
      if (this.stopped) return; // the final push owns the row now
      this.lastSent = raw;
      this.lastSentAt = t;
    }
    if (typeof j.stamp === "string" && typeof j.pane === "string") {
      try {
        (this.d.writeStamp ?? writeStampAtomic)(j.stamp, j.pane);
      } catch {
        // the daemon keeps the pane covered
      }
    }
    this.syncSpin();
  }

  private fallback(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        this.d.push(this.args(), () => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** The 250 ms `fm_hd` timer runs only while the header template has a spinner slot and the session works. */
  private syncSpin(): void {
    if (this.stopped || !this.animating()) {
      this.stopSpin();
      return;
    }
    if (this.spin) return;
    this.spin = setInterval(() => {
      if (this.stopped || !this.animating() || !this.tpl) return this.stopSpin();
      this.d.report!({ fm_hd: this.tpl.replace("{spin}", this.frame()) }).catch(() => {});
    }, this.d.tickMs ?? SPINNER_MS);
    this.spin.unref?.();
  }

  private stopSpin(): void {
    if (this.spin) clearInterval(this.spin);
    this.spin = null;
  }

  /** Shutdown: timers off, presence marked done, then `push --final` (again after a push still in flight). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refresh) clearInterval(this.refresh);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.refresh = this.gapTimer = null;
    this.stopSpin();
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

const execQuiet = (bin: string, argv: string[], timeout: number, done: (stdout?: string) => void = () => {}): void => {
  try {
    execFile(bin, argv, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (_e, stdout) => done(typeof stdout === "string" ? stdout : undefined));
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
  /** `ui.spinner` is not false. */
  spinner?: boolean;
  live: { onChange: (cb: () => void) => () => void; flush: () => void; stop: () => void; stateName: LiveStateName } | null;
}

/** Live states that never tick whatever the template says; Python's `fm_hd_tpl` picks the rest. */
export const sidebarMayTick = (state: LiveStateName): boolean => state !== "blocked" && state !== "done";

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
    side = new SidebarLive({
      pane: env.HERDR_PANE_ID!.trim(),
      sessionId: cfg.sessionId,
      agentDir: cfg.agentDir,
      symbols: typeof cfg.symbols === "string" ? cfg.symbols : undefined,
      push: (args, done) => execQuiet(python, ["-E", "-s", script, ...args], 10_000, done),
      report: (tokens) => reportMetadata(socketPath(env), { pane_id: env.HERDR_PANE_ID!.trim(), source: SIDEBAR_SOURCE, tokens, ttl_ms: TTL_MS }),
      spinner: cfg.spinner !== false,
      working: () => sidebarMayTick(live.stateName),
      frames: symbolSet(cfg.symbols).spinner,
      flush: () => live.flush(),
      finish: () => live.stop(),
    });
    const s = side;
    off = live.onChange(() => s.request());
    s.start();
  };
  return { start };
}
