// A session brief written as a page (instructions/brief-skeleton.html): the new session reads a generated markdown copy, the owner reads the page
// rendered in the plan style. One converter for the TS callers (session open dialog, `session brief`) and, through briefpage-cli.ts, for
// scripts/foreman_session.py. The copy comes from the same converter as plan copies (htmlmd.ts); the page from renderHtmlPlanPage, with the
// diagrams rendered in memory (no sidecar files) and inlined, so the page is one self-contained file.
import * as fs from "node:fs";
import * as path from "node:path";
import { PLAN_MAX_BYTES } from "./checkpoint.ts";
import { htmlToMarkdown, mermaidPres } from "./htmlmd.ts";
import { createEngine, diagramName, fenceSha, RENDER_TIMEOUT_MS, renderSidecars, THEMES } from "./mermaid.ts";
import type { Engine } from "./mermaid.ts";
import { renderHtmlPlanPage } from "./pages.ts";
import type { Svgs } from "./pages.ts";

/** All diagrams of one page together. */
export const DIAGRAMS_TOTAL_MS = 10_000;

export type BriefPageCode = "brief_too_large" | "brief_unconvertible" | "brief_unreadable";

export interface BriefPage {
  /** The generated copy: the marker line, then the converted page. */
  markdown: string;
  /** The rendered owner page, one self-contained file. */
  page: string;
  /** The page's first `<h1>`, else its `<title>`; empty when it has neither. */
  title: string;
  /** Spots of hidden-style text on the page (summed over the kinds). */
  hiddenTotal: number;
}

export interface BriefPageError {
  error: BriefPageCode;
  message: string;
}

export interface BriefPageOpts {
  /** The diagram engine; default: `createEngine` with the per-diagram timeout. Closed before the call returns, also a given one. */
  engine?: Engine;
  /** Cap for all diagrams of the page; default DIAGRAMS_TOTAL_MS. */
  totalMs?: number;
}

/** True for a brief whose real path names a page. */
export const isBriefPage = (file: string): boolean => /\.html$/i.test(file);

const fail = (error: BriefPageCode, message: string): BriefPageError => ({ error, message });

const marker = (name: string): string => `<!-- generated from the brief page ${name.replace(/[^A-Za-z0-9._ -]/g, "_")}; the page is the source -->`;

/** The diagrams of the page as inline-ready SVG pairs; a diagram that is missing, refused or too slow is simply absent (the page shows its source). */
async function diagramsOf(html: string, o: BriefPageOpts): Promise<Map<string, Svgs>> {
  const fences = mermaidPres(html).map((m) => ({ text: m.text, sha: fenceSha(m.text) }));
  const out = new Map<string, Svgs>();
  if (fences.length === 0) return out;
  const engine = o.engine ?? createEngine({ timeoutMs: RENDER_TIMEOUT_MS });
  const files = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      renderSidecars(engine, fences, { write: async (name, data) => void files.set(name, data) }).catch(() => []),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, o.totalMs ?? DIAGRAMS_TOTAL_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    engine.close();
  }
  for (const f of fences) {
    const [dark, light] = THEMES.map((t) => files.get(diagramName(f.sha, t)));
    if (dark !== undefined && light !== undefined) out.set(f.sha, { dark, light });
  }
  return out;
}

/** Read, convert and render the brief page at `pagePath`. */
export async function convertBriefPage(pagePath: string, o: BriefPageOpts = {}): Promise<BriefPage | BriefPageError> {
  const name = path.basename(pagePath);
  let html: string;
  try {
    const st = fs.statSync(pagePath);
    if (!st.isFile()) return fail("brief_unreadable", `${name}: not a regular file`);
    if (st.size > PLAN_MAX_BYTES) return fail("brief_too_large", `${name}: the page is larger than 256 KiB`);
    const bytes = fs.readFileSync(pagePath);
    if (bytes.length > PLAN_MAX_BYTES) return fail("brief_too_large", `${name}: the page is larger than 256 KiB`);
    html = bytes.toString("utf8");
  } catch (e) {
    return fail("brief_unreadable", `${name}: the file cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let conv: ReturnType<typeof htmlToMarkdown>;
  try {
    conv = htmlToMarkdown(html);
  } catch (e) {
    return fail("brief_unconvertible", `${name} could not be converted to text (${e instanceof Error ? e.message : "error"})`);
  }
  const markdown = `${marker(name)}\n${conv.markdown}`;
  if (Buffer.byteLength(markdown, "utf8") > PLAN_MAX_BYTES) return fail("brief_too_large", `${name}: the generated text copy is larger than 256 KiB`);
  const title = conv.title?.trim() ?? "";
  let page: string;
  try {
    const svgs = await diagramsOf(html, o);
    page = renderHtmlPlanPage({ title: title || name, kicker: "Session brief", html, rulings: "", svgs, source: name });
  } catch (e) {
    return fail("brief_unconvertible", `${name} could not be rendered (${e instanceof Error ? e.message : "error"})`);
  }
  return { markdown, page, title, hiddenTotal: conv.hidden.reduce((n, h) => n + h.count, 0) };
}
