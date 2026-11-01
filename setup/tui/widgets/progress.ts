import { Loader, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Step, StepStatus } from "../../plan-types.ts";
import { cyan, dim, green, red, yellow } from "../style.ts";

export const STATUS_GLYPH: Record<StepStatus, string> = { pending: "·", running: "●", done: "✓", failed: "✗", skipped: "–" };

const STATUS_PAINT: Record<StepStatus, (t: string) => string> = { pending: dim, running: cyan, done: green, failed: red, skipped: yellow };

export const statusGlyph = (status: StepStatus): string => STATUS_PAINT[status](STATUS_GLYPH[status]);

/** "from -> to" for a step's version, or "" when it has none. */
export function versionText(step: Step): string {
  if (!step.version) return "";
  return step.version.from ? `${step.version.from} → ${step.version.to}` : step.version.to;
}

/**
 * Step list with a status glyph per line. The running step shows a Loader; it spins only when
 * `ui` is given (a live terminal), so captured frames stay deterministic (first frame, timer stopped).
 */
export class ProgressList implements Component {
  private loaders = new Map<string, Loader>();

  private steps: Step[];
  private ui?: Pick<TUI, "requestRender">;

  constructor(steps: Step[], ui?: Pick<TUI, "requestRender">) {
    this.steps = steps;
    this.ui = ui;
  }

  setSteps(steps: Step[]): void {
    this.steps = steps;
  }

  invalidate(): void {}

  dispose(): void {
    for (const l of this.loaders.values()) l.stop();
    this.loaders.clear();
  }

  render(width: number): string[] {
    const out: string[] = [];
    for (const s of this.steps) {
      const ver = versionText(s);
      const label = ver ? `${s.title}  ${dim(ver)}` : s.title;
      if (s.status === "running") {
        let loader = this.loaders.get(s.id);
        if (!loader) {
          loader = new Loader((this.ui ?? { requestRender() {} }) as TUI, cyan, (t) => t, label);
          if (!this.ui) loader.stop(); // the constructor starts the spinner
          this.loaders.set(s.id, loader);
        }
        // Loader is a Text with paddingX 1: drop that column so the row lines up with the others
        out.push(...loader.render(width + 1).filter((l) => l.trim() !== "").map((l) => l.slice(1)));
      } else {
        out.push(`${statusGlyph(s.status)} ${label}`);
      }
    }
    return out;
  }
}
