import type { Component, TUI } from "@earendil-works/pi-tui";
import type { PreviewFixture } from "../../plan-types.ts";

export interface ScreenContext {
  /** Rows available to the screen (terminal rows minus header and keys bar). */
  rows(): number;
  /** The live TUI, absent in captured frames. */
  ui?: Pick<TUI, "requestRender">;
}

export type ScreenFactory = (fixture: PreviewFixture, ctx: ScreenContext) => Component;
