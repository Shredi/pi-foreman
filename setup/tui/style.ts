import { indexedColor, styleText, truncateToWidth, visibleWidth, type TextStyle } from "@earendil-works/pi-tui";

export const paint = (text: string, style: TextStyle): string => styleText(text, style, "256color");

export const bold = (t: string): string => paint(t, { bold: true });
export const dim = (t: string): string => paint(t, { dim: true });
export const green = (t: string): string => paint(t, { fg: indexedColor(2) });
export const red = (t: string): string => paint(t, { fg: indexedColor(1) });
export const yellow = (t: string): string => paint(t, { fg: indexedColor(3) });
export const cyan = (t: string): string => paint(t, { fg: indexedColor(6) });
export const inverse = (t: string): string => paint(t, { inverse: true });

/** Truncate to `width` columns (ellipsis) and pad with spaces to exactly `width`. */
export const fit = (text: string, width: number): string => {
  const t = truncateToWidth(text, Math.max(0, width), "…");
  return t + " ".repeat(Math.max(0, width - visibleWidth(t)));
};
