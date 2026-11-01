import * as fs from "node:fs";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import type { PreviewFixture, ScreenId } from "./plan-types.ts";
import { SetupApp } from "./tui/app.ts";
import { SCREEN_IDS } from "./tui/screens/index.ts";
import { CaptureTerminal, renderFrame } from "./tui/term.ts";

export interface PreviewIo {
  stdout: { write(s: string): unknown };
  isTTY: boolean;
  columns?: number;
  rows?: number;
}

const FIXTURE = new URL("./fixtures/preview.json", import.meta.url);

/** `foreman setup --preview [screen]`: draw a screen from the fixture. Returns the exit code. */
export async function runPreview(screen: string | undefined, io: PreviewIo): Promise<number> {
  const id = (screen ?? "home") as ScreenId;
  if (!SCREEN_IDS.includes(id)) {
    process.stderr.write(`Unknown screen "${screen}". Screens: ${SCREEN_IDS.join(", ")}\n`);
    return 2;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as PreviewFixture;
  if (io.isTTY) {
    const app = new SetupApp(fixture, new ProcessTerminal());
    app.showScreen(id);
    app.start();
    await app.done;
    return 0;
  }
  const cols = io.columns || 100;
  const rows = io.rows || 30;
  const app = new SetupApp(fixture, new CaptureTerminal(cols, rows));
  app.showScreen(id);
  io.stdout.write(renderFrame(app, cols, rows).join("\n") + "\n");
  return 0;
}
