// The shared look of the owner dialogs (plan checkpoint, session open, owner script, protect): one plain question line, the
// few facts that matter, detail in grey, locations as OSC 8 links with a plain path line below, and one line that says what each
// answer does. In the TUI the dialog is Pi's own ExtensionSelectorComponent through `ui.custom`: the question is its title,
// the body its description, and the blocked status carries the plain question (a styled title in `select` leaks escape codes
// into it). Elsewhere (rpc, no theme, no `custom`) the same text is drawn without styling. The answers, their order and the
// preselection are the caller's: this module only draws and returns what the owner picked.
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";

type Ui = ExtensionContext["ui"];

/** The parts of Pi's theme the dialog uses. */
export interface DialogTheme {
  fg(token: string, text: string): string;
  underline?(text: string): string;
}

/** `links` kind: `page` is a page the harness wrote; `text` is a brief, linked only when its real path ends in .md or .txt. */
export interface DialogLink {
  label: string;
  path: string;
  text: string;
  kind: "page" | "text";
  /** A served URL (page server) the link opens instead of the file URL; the dim path line stays the file path. */
  url?: string;
}

export interface DialogSpec {
  /** The question: one plain line, also the blocked label. */
  ask: string;
  summary?: string;
  facts?: [label: string, value: string][];
  links?: DialogLink[];
  detail?: string[];
  /** One line that says what each answer does, in the order of the answers. */
  answers?: string;
}

/** null = no styling (plain text); else the theme and whether the terminal draws OSC 8 links. */
export interface DialogStyle {
  theme: DialogTheme;
  links: boolean;
}

const isFormatChar = (c: number): boolean => c === 0x061c || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);

/** Characters that draw blank though they are not whitespace: Braille blank and the Hangul fillers (the fillers are Default_Ignorable, so they turn into a space before the invisible strip). */
const FILLERS = /[\u{2800}\u{3164}\u{115f}\u{1160}\u{ffa0}]/gu;
/** Characters that draw nothing: Default_Ignorable (soft hyphen, joiners, invisible operators, variation selectors, tags, interlinear anchors, ...), format, private-use and unassigned code points. */
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Co}\p{Cn}]/gu;
/** The marker sign of the real answers line (black right-pointing small triangle); cleaned text never holds one. */
const ANSWERS_SIGN = String.fromCodePoint(0x25b8);
/** Whole sign blocks that could pass for the marker: Arrows, some Math Operators (triangles), Misc Technical, Box Drawing / Block Elements / Geometric Shapes, Dingbat arrows, Supplemental Arrows-A and -B, Misc Symbols and Arrows, Geometric Shapes Extended and Supplemental Arrows-C, plus bullet and angle quotation look-alikes. */
const SIGN_LIKE = /[\u{2190}-\u{21ff}\u{22b2}-\u{22b5}\u{2300}-\u{23ff}\u{2500}-\u{25ff}\u{2794}-\u{27bf}\u{27f0}-\u{27ff}\u{2900}-\u{297f}\u{2b00}-\u{2bff}\u{1f780}-\u{1f8ff}\u{2023}\u{1405}\u{ff1e}\u{203a}\u{bb}]/gu;
/** Whitespace plus the characters that draw blank. */
const BLANK_RUN = /[\s\p{Zs}\p{Zl}\p{Zp}\u{2800}\u{3164}\u{115f}\u{1160}\u{ffa0}]+/gu;

/** Every caller- or model-provided string: escape sequences, control characters and bidi/format characters out, one line. */
export function cleanDialogText(s: string): string {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[^ -~]/g, (ch) => (isFormatChar(ch.charCodeAt(0)) ? " " : ch))
    .replace(FILLERS, " ")
    .replace(INVISIBLE, "")
    .replace(SIGN_LIKE, "")
    // blank-looking characters and long runs of spaces become one space; a run of up to three plain spaces is the dialogs' own separator
    .replace(BLANK_RUN, (run) => (run.length > 3 || /[^ ]/.test(run) ? " " : run))
    .trim();
}

/** The file URL of a path; `windows` is a parameter so a test covers Windows paths on any runner. */
export function fileUrl(p: string, windows: boolean = process.platform === "win32"): string {
  return pathToFileURL(p, { windows }).href;
}

/** The link rule: a served `url` when set; else a `page` always; a `text` file only when its real path ends in .md or .txt. Scripts are never passed as links. */
function linkUrl(l: DialogLink, windows: boolean): string | null {
  return l.url ?? fileLinkUrl(l, windows);
}

function fileLinkUrl(l: DialogLink, windows: boolean): string | null {
  if (l.kind === "page") return fileUrl(l.path, windows);
  let real = l.path;
  try {
    real = fs.realpathSync(l.path);
  } catch {
    return null;
  }
  return /\.(md|txt)$/i.test(real) ? fileUrl(real, windows) : null;
}

/** The question and the body (styled when `style` is given). The answers line is last. */
export function ownerDialog(spec: DialogSpec, style: DialogStyle | null, windows: boolean = process.platform === "win32"): { ask: string; body: string } {
  const t = style?.theme;
  const fg = (tok: string, s: string): string => (t ? t.fg(tok, s) : s);
  const out: string[] = [];
  if (spec.summary) out.push(fg("text", cleanDialogText(spec.summary)));
  if (spec.facts?.length) {
    out.push("");
    const w = Math.max(...spec.facts.map(([l]) => cleanDialogText(l).length));
    for (const [l, v] of spec.facts) out.push(`  ${fg("muted", `${cleanDialogText(l)}:`.padEnd(w + 1))}  ${fg("text", cleanDialogText(v))}`);
  }
  for (const l of spec.links ?? []) {
    const url = linkUrl(l, windows);
    // under a drawn (clickable) served link the dim line stays the file link of today; with no clickable link the served URL is the text to copy
    const shown = cleanDialogText(l.url && url && style?.links ? (fileLinkUrl(l, windows) ?? l.path) : (url ?? l.path));
    const label = cleanDialogText(l.label);
    out.push("");
    if (url && style?.links) {
      const link = hyperlink(cleanDialogText(l.text), url);
      out.push(`  ${fg("muted", `${label}:`)}  ${fg("mdLink", t?.underline ? t.underline(link) : link)}`);
      out.push(`  ${fg("dim", shown)}`);
    } else {
      out.push(`  ${fg("muted", `${label}:`)}`);
      out.push(`  ${t ? fg("dim", shown) : shown}`);
    }
  }
  if (spec.detail?.length) {
    out.push("");
    for (const x of spec.detail) out.push(`  ${fg("dim", cleanDialogText(x))}`);
  }
  if (spec.answers) {
    out.push("");
    out.push(fg("warning", `${ANSWERS_SIGN} ${cleanDialogText(spec.answers)}`));
  }
  return { ask: cleanDialogText(spec.ask), body: out.join("\n") };
}

/** The style of this session's dialogs, or null: only the TUI with a theme and a `custom` function is styled; links follow Pi's own terminal detection. */
export function dialogStyle(ui: Ui, mode: string | undefined, hyperlinks: () => boolean = () => getCapabilities().hyperlinks): DialogStyle | null {
  const theme = (ui as { theme?: DialogTheme }).theme;
  if (mode !== "tui" || !theme || typeof theme.fg !== "function" || typeof (ui as { custom?: unknown }).custom !== "function") return null;
  let links = false;
  try {
    links = hyperlinks() === true;
  } catch {
    links = false;
  }
  return { theme, links };
}

/** The selector Pi draws, through `custom`: the options array as given (index 0 preselected), the abort signal and Escape answer undefined. */
function customSelect(ui: Ui, ask: string, body: string, options: string[], kind: "question" | "permission", signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return ui.custom<string | undefined>(
    (tui, _theme, _kb, done) => {
      let finished = false;
      const onAbort = (): void => end(undefined);
      const end = (v: string | undefined): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        done(v);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      return new ExtensionSelectorComponent(ask, options, (o: string) => end(o), () => end(undefined), { tui, description: body });
    },
    { blocked: { kind, message: ask } },
  );
}

/** A select in the owner-dialog shape. The answer is whatever the owner picked (undefined: dismissed or withdrawn). */
export async function shapedSelect(ui: Ui, mode: string | undefined, spec: DialogSpec, options: string[], opts: { signal?: AbortSignal; style?: DialogStyle | null } = {}): Promise<string | undefined> {
  const style = opts.style === undefined ? dialogStyle(ui, mode) : opts.style;
  const { ask, body } = ownerDialog(spec, style);
  if (style) return customSelect(ui, ask, body, options, "question", opts.signal);
  const title = body ? `${ask}\n\n${body}` : ask;
  return opts.signal ? ui.select(title, options, { signal: opts.signal }) : ui.select(title, options);
}

/** A Yes/No confirm in the owner-dialog shape: true only for Yes. */
export async function shapedConfirm(ui: Ui, mode: string | undefined, spec: DialogSpec, opts: { signal?: AbortSignal; style?: DialogStyle | null } = {}): Promise<boolean> {
  const style = opts.style === undefined ? dialogStyle(ui, mode) : opts.style;
  const { ask, body } = ownerDialog(spec, style);
  if (style) return (await customSelect(ui, ask, body, ["Yes", "No"], "permission", opts.signal)) === "Yes";
  return (opts.signal ? await ui.confirm(ask, body, { signal: opts.signal }) : await ui.confirm(ask, body)) === true;
}
