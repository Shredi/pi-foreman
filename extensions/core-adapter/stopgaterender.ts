// Display of the stop gate message. Pi draws a custom message as markdown, where `\.` is an escape and eats the
// backslash of a Windows path (`pf-live-a\.workflow` shows as `pf-live-a.workflow`). This renderer shows the same
// content as plain text; the content the model reads is unchanged.
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

export const STOP_GATE_TYPE = "pi-foreman-stop-gate";

type Themed = { fg(color: string, text: string): string; bg(color: string, text: string): string };
type Shown = { customType: string; content: string | { type: string; text?: string }[] };

export function stopGateRenderer(message: Shown, options: { outputPad?: number }, theme: Themed): InstanceType<typeof Box> {
  const text = typeof message.content === "string" ? message.content : message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const box = new Box(options.outputPad ?? 1, 1, (t: string) => theme.bg("customMessageBg", t));
  box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(new Text(theme.fg("customMessageText", text), 0, 0));
  return box;
}
