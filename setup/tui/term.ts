import { stripTerminalSequences, type Component, type Terminal } from "@earendil-works/pi-tui";

/** The one ANSI stripper: snapshots, tests and the non-TTY preview all use it. */
export const stripAnsi = (s: string): string => stripTerminalSequences(s);

/** A fixed-size terminal that records what is written and never touches process.stdin. */
export class CaptureTerminal implements Terminal {
  readonly writes: string[] = [];
  private cols: number;
  private rws: number;

  constructor(columns = 100, rows = 30) {
    this.cols = columns;
    this.rws = rows;
  }

  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  get columns(): number {
    return this.cols;
  }
  get rows(): number {
    return this.rws;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: unknown): void {}
}

/** Render `component` at `cols` and return exactly `rows` plain-text lines (ANSI stripped, padded or truncated). */
export function renderFrame(component: Component, cols: number, rows: number): string[] {
  const lines = component.render(cols).map((l) => stripAnsi(l).replace(/\s+$/, ""));
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}
