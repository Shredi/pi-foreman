// Mermaid sidecars for the side panel: fence scanning (the rule shared with the herdr-app plan mod), a render engine around the optional
// `beautiful-mermaid` package, SVG flattening and the allow-list check. Rendering never runs on the tool-result path: show.ts schedules it
// after a document is published. A missing module, a refused SVG, a timeout or a cap leaves the fence a code block (no sidecar).
//
// Fence rule: an opening fence starts at column 0 (three or more backticks or tildes) and its first info word is `mermaid`; the closing
// fence is the same character, at least as long, followed only by blanks; an unclosed fence gets no sidecar; a fence nested in a longer
// fence of another language is not a diagram. The text is the inner lines with `\r\n` as `\n` and exactly one final `\n` removed; the hash is
// sha256 over its UTF-8 bytes. Test vectors: tests/fixtures/mermaid-fences.json.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";

export const FENCE_MAX_BYTES = 16 * 1024;
export const SVG_MAX_BYTES = 512 * 1024;
export const FENCES_MAX = 32;
/** Nodes plus edges of one diagram, counted before any layout. */
export const ITEMS_MAX = 200;
export const RENDER_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 10_000;
export const DIAGRAMS_DIR = "diagrams";
export type Theme = "dark" | "light";
export const THEMES: readonly Theme[] = ["dark", "light"];

export interface Fence {
  text: string;
  sha: string;
}

/** One published diagram: both sidecars exist; the paths are relative to the show dir. */
export interface Diagram {
  sha: string;
  dark: string;
  light: string;
}

export const diagramName = (sha: string, theme: Theme): string => `${sha}-${theme}.svg`;
export const SIDECAR_RE = /^[0-9a-f]{64}-(?:dark|light)\.svg$/;

export const fenceSha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const OPEN_RE = /^(`{3,}|~{3,})(.*)$/;

/** The mermaid fences of a markdown document, in order. Every other fence is skipped whole, so a diagram nested in it is not found. */
export function scanFences(markdown: string): Fence[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i]);
    if (!open) continue;
    const mark = open[1];
    const info = open[2].trim();
    if (mark[0] === "`" && info.includes("`")) continue; // not a fence line (an inline code span)
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      const run = /^[`~]+/.exec(l)?.[0] ?? "";
      if (run[0] === mark[0] && run.length >= mark.length && l.slice(run.length).trim() === "" && new Set(run).size === 1) {
        close = j;
        break;
      }
    }
    if (close < 0) break; // unclosed: runs to the end of the document
    if (info.split(/\s+/)[0] === "mermaid") {
      const text = lines.slice(i + 1, close).join("\n");
      out.push({ text, sha: fenceSha(text) });
    }
    i = close;
  }
  return out;
}

/**
 * Nodes plus edges of a diagram, counted from the statements: every statement counts its arrows as edges and the arrows plus one as node
 * occurrences (a node used twice counts twice, so the number is an upper bound); a line without an arrow counts one. `parseMermaid` is not
 * used: it returns no nodes for flowcharts.
 */
export function countItems(src: string): number {
  let n = 0;
  for (const raw of src.split(/\r?\n|;/)) {
    const line = raw.replace(/"[^"]*"|\[[^\]]*\]|\|[^|]*\|/g, "").trim();
    if (!line || line.startsWith("%%")) continue;
    const arrows = (line.match(/(?:-{2,}|={2,}|-\.+-|\.-+|<-|->)[>xo)]?/g) ?? []).length;
    n += arrows > 0 ? 2 * arrows + 1 : 1;
  }
  return n;
}

const PALETTE: Record<Theme, Record<string, string>> = {
  dark: {
    "--bg": "#1B1B1F", "--fg": "#E4E4E7", "--muted": "#A1A1AA", "--line": "#52525B", "--accent": "#60A5FA", "--surface": "#27272A", "--border": "#52525B",
    "--_text": "#E4E4E7", "--_text-sec": "#A1A1AA", "--_text-muted": "#8B8B94", "--_text-faint": "#71717A", "--_line": "#71717A", "--_arrow": "#A1A1AA",
    "--_node-fill": "#27272A", "--_node-stroke": "#52525B", "--_inner-stroke": "#3F3F46", "--_group-fill": "#202024", "--_group-hdr": "#2D2D32",
  },
  light: {
    "--bg": "#FFFFFF", "--fg": "#27272A", "--muted": "#52525B", "--line": "#A1A1AA", "--accent": "#2563EB", "--surface": "#F4F4F5", "--border": "#A1A1AA",
    "--_text": "#27272A", "--_text-sec": "#52525B", "--_text-muted": "#71717A", "--_text-faint": "#A1A1AA", "--_line": "#71717A", "--_arrow": "#52525B",
    "--_node-fill": "#F4F4F5", "--_node-stroke": "#A1A1AA", "--_inner-stroke": "#D4D4D8", "--_group-fill": "#FAFAFA", "--_group-hdr": "#E4E4E7",
  },
};
const FONT = "Inter, Helvetica, Arial, sans-serif";
const ALLOWED = new Set(["svg", "g", "rect", "path", "text", "tspan", "line", "polyline", "polygon", "circle", "ellipse", "marker", "defs"]);
/** A reference to a marker of the same file is the one `url(` the check lets through (arrowheads); everything else with `url(` is refused. */
const MARKER_REF = /\bmarker-(?:start|mid|end)="url\(#[A-Za-z0-9_-]+\)"/g;

/** Palette values in place of `var(--x)`, no `<style>`, no remote font, a background rect and `font-family` attributes. Not validated: see `validateSvg`. */
export function flatten(svg: string, theme: Theme): string {
  const pal = PALETTE[theme];
  let out = svg.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<svg\b[^>]*>/i, (tag) => tag.replace(/\sstyle="[^"]*"/i, ""));
  out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (m, name: string, fallback?: string) => pal[name] ?? fallback?.trim() ?? m);
  out = out.replace(/<(text|tspan)\b(?![^>]*\sfont-family=)/g, `<$1 font-family="${FONT}"`);
  return out.replace(/<svg\b[^>]*>/i, (tag) => {
    const w = /\swidth="([\d.]+)"/.exec(tag)?.[1];
    const h = /\sheight="([\d.]+)"/.exec(tag)?.[1];
    return `${tag}<rect x="0" y="0" width="${w ?? "100%"}" height="${h ?? "100%"}" fill="${pal["--bg"]}"/>`;
  });
}

/** The allow-list check of a flattened SVG: null when it is fine, else the reason (the sidecar is then not written). */
export function validateSvg(svg: string): string | null {
  if (Buffer.byteLength(svg, "utf8") > SVG_MAX_BYTES) return "too_large";
  if (!/^\s*<svg[\s>]/.test(svg)) return "not_svg";
  if (/<!|<\?/.test(svg)) return "declaration"; // DOCTYPE, ENTITY, CDATA, comments, processing instructions
  if (/foreignObject|<script/i.test(svg)) return "active_content";
  if (/\bhref\s*=/i.test(svg)) return "href";
  if (/\bon[a-z]+\s*=/i.test(svg)) return "event_attribute";
  const bare = svg.replace(MARKER_REF, "");
  if (/url\(/i.test(bare)) return "url";
  if (/var\(/i.test(svg)) return "var";
  if (/@import|color-mix\(|javascript:/i.test(svg)) return "unsupported";
  for (const m of svg.matchAll(/<\/?\s*([A-Za-z][\w:-]*)/g)) if (!ALLOWED.has(m[1])) return `element:${m[1].slice(0, 20)}`;
  return null;
}

// ---- engine --------------------------------------------------------------------------------------------------------------------

interface Bm {
  renderMermaid(src: string, o?: { bg?: string; fg?: string }): Promise<string>;
}

/** The optional module is not installed (or cannot be loaded). */
export class MermaidMissing extends Error {}
export class MermaidTimeout extends Error {}

export interface Engine {
  /** Raw SVG of one diagram. Rejects with `MermaidMissing`, `MermaidTimeout` or the renderer's error. */
  render(src: string, theme: Theme): Promise<string>;
  close(): void;
}

export interface EngineOpts {
  timeoutMs?: number;
  /** In-process loader; default: `import("beautiful-mermaid")` inside a try. */
  load?: () => Promise<Bm | null>;
  /** False: never start a worker (tests; also the state after a worker that cannot start). */
  useWorker?: boolean;
  /** Called once, when the module turns out to be missing. */
  onMissing?: () => void;
}

const loadModule = async (): Promise<Bm | null> => {
  try {
    const name = "beautiful-mermaid"; // a variable: tsc does not need the optional package
    const m = (await import(name)) as Bm;
    return typeof m.renderMermaid === "function" ? m : null;
  } catch {
    return null;
  }
};

type WorkerReply = { ready?: boolean; id?: number; svg?: string; error?: string };

/**
 * A `worker_threads` worker (mermaid-worker.mjs) renders one fence per message and is terminated when a render passes the timeout; the next
 * fence gets a new worker. When a worker cannot start, rendering moves in-process: scheduled with `setImmediate`, bounded by the same timeout
 * for the wait but not interruptible (one fence can block up to its own layout time).
 */
export function createEngine(o: EngineOpts = {}): Engine {
  const timeoutMs = o.timeoutMs ?? RENDER_TIMEOUT_MS;
  const load = o.load ?? loadModule;
  let useWorker = o.useWorker ?? true;
  let missing = false;
  let worker: Worker | null = null;
  let seq = 0;
  let inproc: Promise<Bm | null> | null = null;
  const noModule = (): MermaidMissing => {
    if (!missing) {
      missing = true;
      try {
        o.onMissing?.();
      } catch {
        // a trace failure never stops a render
      }
    }
    return new MermaidMissing("beautiful-mermaid is not installed");
  };

  const startWorker = (): Promise<Worker | "missing" | null> =>
    new Promise((resolve) => {
      let w: Worker;
      try {
        w = new Worker(new URL("./mermaid-worker.mjs", import.meta.url));
      } catch {
        resolve(null);
        return;
      }
      w.unref();
      const timer = setTimeout(() => {
        void w.terminate();
        resolve(null);
      }, START_TIMEOUT_MS);
      timer.unref();
      w.once("message", (m: WorkerReply) => {
        clearTimeout(timer);
        if (m.ready) resolve(w);
        else {
          void w.terminate();
          resolve("missing");
        }
      });
      w.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      w.once("exit", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

  const viaWorker = (w: Worker, src: string, theme: Theme): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const pal = PALETTE[theme];
      const end = (f: () => void) => {
        clearTimeout(timer);
        w.off("message", onMsg);
        w.off("error", onErr);
        w.off("exit", onExit);
        f();
      };
      const drop = () => {
        if (worker === w) worker = null;
      };
      const timer = setTimeout(() => end(() => {
        drop();
        void w.terminate();
        reject(new MermaidTimeout("render timed out"));
      }), timeoutMs);
      const onMsg = (m: WorkerReply) => {
        if (m.id !== id) return;
        end(() => (typeof m.svg === "string" ? resolve(m.svg) : reject(new Error(m.error ?? "render failed"))));
      };
      const onErr = (e: Error) => end(() => { drop(); reject(e); });
      const onExit = () => end(() => { drop(); reject(new Error("worker exited")); });
      w.on("message", onMsg);
      w.once("error", onErr);
      w.once("exit", onExit);
      w.postMessage({ id, src, bg: pal["--bg"], fg: pal["--fg"] });
    });

  const inProcess = async (src: string, theme: Theme): Promise<string> => {
    inproc ??= load();
    const mod = await inproc;
    if (!mod) throw noModule();
    await new Promise<void>((r) => setImmediate(r));
    const pal = PALETTE[theme];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        mod.renderMermaid(src, { bg: pal["--bg"], fg: pal["--fg"] }),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new MermaidTimeout("render timed out")), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async render(src, theme) {
      if (missing) throw new MermaidMissing("beautiful-mermaid is not installed");
      if (useWorker) {
        if (!worker) {
          const w = await startWorker();
          if (w === "missing") throw noModule();
          if (w === null) useWorker = false;
          else worker = w;
        }
        if (worker) return viaWorker(worker, src, theme);
      }
      return inProcess(src, theme);
    },
    close() {
      const w = worker;
      worker = null;
      if (w) void w.terminate();
    },
  };
}

// ---- sidecars ------------------------------------------------------------------------------------------------------------------

export interface SidecarIo {
  /** Atomic write of `diagrams/<name>`. */
  write(name: string, data: string): Promise<void>;
  trace?: (rec: Record<string, unknown>) => void;
  /** False when the sidecar is not on disk as a regular file. */
  has?: (name: string) => boolean;
}

/** True when the file is a regular file in `dir`. */
export const sidecarOnDisk = (dir: string, name: string): boolean => {
  try {
    return fs.lstatSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
};

/** Why a fence is not rendered at all (before any layout), or null. */
export function fenceRefusal(f: Fence): string | null {
  if (Buffer.byteLength(f.text, "utf8") > FENCE_MAX_BYTES) return "fence_too_large";
  if (countItems(f.text) > ITEMS_MAX) return "too_many_items";
  return null;
}

/**
 * Renders the missing sidecars of `fences` (at most FENCES_MAX of them) one after the other. A fence that fails in any way is skipped and
 * traced; a missing module stops the batch. Returns the shas whose two sidecars exist afterwards.
 */
export async function renderSidecars(engine: Engine, fences: Fence[], io: SidecarIo): Promise<string[]> {
  const have = io.has ?? (() => false);
  const done: string[] = [];
  for (const f of fences.slice(0, FENCES_MAX)) {
    const todo = THEMES.filter((t) => !have(diagramName(f.sha, t)));
    if (todo.length === 0) {
      done.push(f.sha);
      continue;
    }
    const refused = fenceRefusal(f);
    if (refused) {
      io.trace?.({ event: "show_diagram", outcome: refused });
      continue;
    }
    try {
      for (const theme of todo) {
        const svg = flatten(await engine.render(f.text, theme), theme);
        const bad = validateSvg(svg);
        if (bad) {
          io.trace?.({ event: "show_diagram", outcome: "refused", reason: bad.split(":")[0] });
          throw new Error("refused");
        }
        await io.write(diagramName(f.sha, theme), svg);
      }
      done.push(f.sha);
    } catch (e) {
      if (e instanceof MermaidMissing) break;
      if (e instanceof MermaidTimeout) io.trace?.({ event: "show_diagram", outcome: "timeout" });
      else if ((e as Error).message !== "refused") io.trace?.({ event: "show_diagram", outcome: "render_failed" });
    }
  }
  return done;
}
